import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  captureUsRequestBuildDescriptor,
  loadUsRequestBuildDescriptor,
} from "../src/deployment/us-request-build-descriptor";
import { UsRequestHttpResources } from "../src/deployment/us-request-http-resources";
import { UsRequestHttpCommands } from "../src/modules/traceability/requests/us-request-http-commands";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import { createUsRequestBuildFixture, localBuildEnv } from "./support/us-request-build-fixture";
import {
  createUsRequestWorkerStorageFixture,
  storageEnvironment,
} from "./support/us-request-worker-storage-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("HTTP resources with real commands in owned PostgreSQL", () => {
  it.each(["unconfigured", "invalid", "configured"] as const)(
    "allows Validate with %s storage and only configured storage allows Prepare",
    async (storageState) => {
      let database: Awaited<ReturnType<typeof createUsProfileTestDatabase>> | undefined;
      let fixture: Awaited<ReturnType<typeof createUsRequestBuildFixture>> | undefined;
      let storage: ReturnType<typeof createUsRequestWorkerStorageFixture> | undefined;
      let resources: UsRequestHttpResources | undefined;
      try {
        if (!url) throw new Error("Explicit isolated US database URL required");
        database = await createUsProfileTestDatabase(url);
        const context = await seedCompleteReceiving(database.db);
        fixture = await createUsRequestBuildFixture();
        await fixture.writeDocument(
          await captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots),
        );
        storage = createUsRequestWorkerStorageFixture();
        const roots = fixture.roots;
        resources = new UsRequestHttpResources(
          {
            ...(await localBuildEnv()),
            ...(storageState === "configured" ? storageEnvironment() : {}),
            ...(storageState === "invalid"
              ? { US_REQUEST_PACKAGE_S3_ENDPOINT: "http://127.0.0.1:19000" }
              : {}),
          },
          {
            loadBuild: (raw) => loadUsRequestBuildDescriptor(raw, roots),
            packageTransport: storage.transport,
          },
        );
        const commands = new UsRequestHttpCommands(database.db, resources);
        const ctx = {
          tenantId: context.tenant,
          userId: context.actor,
          httpRequestId: randomUUID(),
        };
        const request = await commands.create(ctx, {
          requestNumber: randomUUID(),
          requesterName: "Synthetic requester",
          requesterOrganization: null,
          requesterContact: null,
          receivedAt: "2026-10-04T00:00:00Z",
          scope: { lotId: context.lot },
        });
        expect(await resources.availability()).toEqual({
          build: "available",
          packageStorage: storageState,
        });
        const validation = await commands.validate(ctx, request.requestId, { expectedRevision: 1 });
        expect(validation.digest).toMatch(/^[a-f0-9]{64}$/);
        const body = {
          expectedRevision: 1,
          validationDigest: validation.digest,
          mode: "available_records_incomplete",
          idempotencyKey: randomUUID(),
        };
        const prepare = commands.prepare(ctx, request.requestId, body);
        if (storageState === "configured") {
          const prepared = await prepare;
          expect(prepared.requestId).toBe(request.requestId);
          expect(prepared.mode).toBe("available_records_incomplete");
          const runs = await database.db.select().from(schema.traceExportRuns);
          expect(runs).toHaveLength(1);
          expect(runs[0]).toMatchObject({ id: prepared.runId, status: "queued" });
          // HTTP Prepare queues only; it never runs a worker or probes storage.
          expect(await database.db.select().from(schema.traceExportAttempts)).toEqual([]);
        } else {
          await expect(prepare).rejects.toMatchObject({
            status: 503,
            response: { code: "us_request_package_storage_unavailable" },
          });
          expect(await database.db.select().from(schema.traceExportRuns)).toEqual([]);
        }
        expect(storage.calls).toEqual([]);
      } finally {
        resources?.dispose();
        storage?.destroy();
        await fixture?.dispose();
        await database?.close();
      }
    },
    60_000,
  );

  it.each(["dirty", "tampered"] as const)(
    "refuses Validate after %s owned build changes without replacing saved validation",
    async (mutation) => {
      let database: Awaited<ReturnType<typeof createUsProfileTestDatabase>> | undefined;
      let fixture: Awaited<ReturnType<typeof createUsRequestBuildFixture>> | undefined;
      let resources: UsRequestHttpResources | undefined;
      try {
        if (!url) throw new Error("Explicit isolated US database URL required");
        database = await createUsProfileTestDatabase(url);
        const context = await seedCompleteReceiving(database.db);
        fixture = await createUsRequestBuildFixture();
        const document = await captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots);
        await fixture.writeDocument(document);
        const roots = fixture.roots;
        resources = new UsRequestHttpResources(await localBuildEnv(), {
          loadBuild: (raw) => loadUsRequestBuildDescriptor(raw, roots),
        });
        const commands = new UsRequestHttpCommands(database.db, resources);
        const ctx = {
          tenantId: context.tenant,
          userId: context.actor,
          httpRequestId: randomUUID(),
        };
        const request = await commands.create(ctx, {
          requestNumber: randomUUID(),
          requesterName: "Synthetic requester",
          requesterOrganization: null,
          requesterContact: null,
          receivedAt: "2026-10-04T00:00:00Z",
          scope: { lotId: context.lot },
        });
        expect((await resources.availability()).build).toBe("available");
        await commands.validate(ctx, request.requestId, { expectedRevision: 1 });
        const before = await database.db.select().from(schema.traceRequests);
        if (mutation === "dirty")
          await fixture.writeDocument({ ...document, build: { ...document.build, dirty: true } });
        else await fixture.replaceApiBytes("index.js", Buffer.from("tampered output\n"));
        const refused = { ...ctx, httpRequestId: randomUUID() };
        await expect(
          commands.validate(refused, request.requestId, { expectedRevision: 1 }),
        ).rejects.toMatchObject({
          status: 503,
          response: { code: "us_request_build_unavailable" },
        });
        expect(await database.db.select().from(schema.traceRequests)).toEqual(before);
        expect(await database.db.select().from(schema.traceExportRuns)).toEqual([]);
        const audits = await database.db
          .select()
          .from(schema.tenantAuditEvents)
          .where(eq(schema.tenantAuditEvents.requestId, refused.httpRequestId));
        expect(audits).toEqual([
          {
            id: expect.any(String),
            createdAt: expect.any(Date),
            organizationId: context.tenant,
            actorUserId: context.actor,
            requestId: refused.httpRequestId,
            action: "traceability.request.validated",
            targetType: "trace_request",
            targetId: request.requestId,
            outcome: "rejected",
            before: null,
            after: { code: "us_request_build_unavailable" },
          },
        ]);
      } finally {
        resources?.dispose();
        await fixture?.dispose();
        await database?.close();
      }
    },
    60_000,
  );
});
