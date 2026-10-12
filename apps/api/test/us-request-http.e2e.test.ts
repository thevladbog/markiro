import { createHash, randomUUID } from "node:crypto";
import { access, unlink } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import {
  usRequestCommandResponseSchema,
  usRequestListResponseSchema,
  usRequestDetailResponseSchema,
  usRequestValidationHttpResponseSchema,
  usRequestPrepareResponseSchema,
  usRequestRunDetailSchema,
  usRequestRunListResponseSchema,
  usRequestAttemptListResponseSchema,
  usRequestRetryResponseSchema,
} from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { UsRuntime } from "../src/deployment/us-runtime";
import { captureUsRequestBuildDescriptor } from "../src/deployment/us-request-build-descriptor";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import {
  prepareUsWorkerSource,
  bindUsRequestWorkerFixture,
} from "./support/us-request-worker-fixture";
import { createUsRequestHttpFixture } from "./support/us-request-http-fixture";

const root = "/traceability/requests";
let f: Awaited<ReturnType<typeof createUsRequestHttpFixture>>;
beforeAll(async () => {
  if (process.env.US_TEST_DATABASE_URL) f = await createUsRequestHttpFixture();
}, 60_000);
afterAll(async () => {
  if (!f) return;
  const identity = await f.database.pool.query<{ name: string }>(
    "SELECT current_database() AS name",
  );
  await f.close();
  expect(identity.rows[0]?.name).toMatch(/^markiro_us_profile_[a-f0-9_]+$/);
  await expect(access(f.build.root)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.app.getHttpServer().listening).toBe(false);
  const base = process.env.US_TEST_DATABASE_URL;
  if (!base) throw new Error("Explicit isolated US database URL required");
  const admin = createDb(base);
  try {
    const remaining = await admin.pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      identity.rows[0]?.name,
    ]);
    expect(remaining.rowCount).toBe(0);
  } finally {
    await admin.pool.end();
  }
});
const body = () => ({
  requestNumber: randomUUID(),
  requesterName: "Synthetic HTTP requester",
  requesterOrganization: null,
  requesterContact: "private@example.test",
  receivedAt: "2026-10-05T00:00:00Z",
  scope: null,
});
describe.skipIf(!process.env.US_TEST_DATABASE_URL)(
  "US Requests canonical real HTTP boundary",
  () => {
    it("creates a real request with server correlation and keeps the obsolete alias closed", async () => {
      const response = await f.request(root, "POST", body(), {
        "x-request-id": "client-authority",
      });
      expect(response.status).toBe(201);
      const ack = usRequestCommandResponseSchema.parse(await response.json());
      expect(response.headers.get("x-request-id")).toBe(ack.httpRequestId);
      expect(ack.httpRequestId).not.toBe("client-authority");
      expect((await f.request("/api/us/traceability/requests")).status).toBe(404);
    });
    it("documents exactly thirteen canonical routes and all safe failures", () => {
      const document = SwaggerModule.createDocument(f.app, new DocumentBuilder().build());
      const paths = Object.fromEntries(
        Object.entries(document.paths).filter(
          ([key]) => key.startsWith(root) || key.startsWith("/traceability/export-runs"),
        ),
      );
      expect(
        Object.fromEntries(
          Object.entries(paths).map(([key, value]) => [key, Object.keys(value).sort()]),
        ),
      ).toEqual({
        [root]: ["get", "post"],
        [`${root}/{id}`]: ["get", "patch"],
        [`${root}/{id}/close`]: ["post"],
        [`${root}/{id}/validate`]: ["post"],
        [`${root}/{id}/acknowledge-warnings`]: ["post"],
        [`${root}/{id}/prepare`]: ["post"],
        [`${root}/{id}/runs`]: ["get"],
        "/traceability/export-runs/{id}": ["get"],
        "/traceability/export-runs/{id}/attempts": ["get"],
        "/traceability/export-runs/{id}/retry": ["post"],
        "/traceability/export-runs/{id}/artifacts/{kind}": ["get"],
      });
      for (const value of Object.values(paths))
        for (const operation of Object.values(value))
          expect(Object.keys(operation.responses)).toEqual(
            expect.arrayContaining(["400", "401", "403", "404", "409", "413", "415", "503"]),
          );
      expect(document.paths[`${root}`]?.post?.requestBody).toMatchObject({
        content: { "application/json": { schema: { additionalProperties: false } } },
      });
      const binary =
        document.paths["/traceability/export-runs/{id}/artifacts/{kind}"]?.get?.responses["200"];
      expect(binary).toMatchObject({
        content: {
          "application/zip": { schema: { type: "string", format: "binary" } },
          "application/pdf": { schema: { type: "string", format: "binary" } },
          "application/json": { schema: { type: "string", format: "binary" } },
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
            schema: { type: "string", format: "binary" },
          },
        },
      });
    });

    it("rejects aliases, unsupported business methods and invalid raw queries before session/database work", async () => {
      const id = randomUUID();
      const ready = vi.spyOn(f.app.get(UsRuntime), "assertDatabaseReady");
      const denied: [string, string, number][] = [
        [root, "HEAD", 404],
        [root, "PUT", 404],
        [root, "DELETE", 404],
        [root, "PROPFIND", 404],
        [`${root}/`, "GET", 404],
        [root.toUpperCase(), "GET", 404],
        [`/traceability/%72equests`, "GET", 404],
        [`${root}/${id.toUpperCase()}`, "GET", 404],
        [`${root}/${id}/`, "PATCH", 404],
        [`${root}/${id}/nested`, "GET", 404],
        [`${root}?limit=01`, "GET", 400],
        [`${root}?limit=51`, "GET", 400],
        [`${root}?offset=10001`, "GET", 400],
        [`${root}?limit=1&limit=2`, "GET", 400],
        [`${root}?unknown=yes`, "GET", 400],
        [`${root}/${id}?limit=1`, "GET", 400],
        [`${root}/${id}/runs?status=open`, "GET", 400],
        [`/traceability/export-runs/${id}/attempts?offset=0&offset=0`, "GET", 400],
        [`/traceability/export-runs/${id}/artifacts/SHA256SUMS`, "GET", 404],
        [`/traceability/export-runs/${id}/artifacts/package_zip`, "HEAD", 404],
      ];
      try {
        for (const [path, method, status] of denied) {
          const response = await f.request(path, method, method === "PATCH" ? {} : undefined, {
            cookie: "",
          });
          expect(response.status, `${method} ${path}`).toBe(status);
          expect(response.headers.get("cache-control")).toBe("no-store");
        }
        expect(ready).not.toHaveBeenCalled();
      } finally {
        ready.mockRestore();
      }
    });

    it("preserves protocol CORS preflight without executing a business operation", async () => {
      const ready = vi.spyOn(f.app.get(UsRuntime), "assertDatabaseReady");
      try {
        const response = await f.request(root, "OPTIONS", undefined, {
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
          cookie: "",
        });
        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5174");
        expect(ready).not.toHaveBeenCalled();
      } finally {
        ready.mockRestore();
      }
    });

    it("enforces Host/Origin, JSON-only/no inflation, server scope, and distinct body caps", async () => {
      for (const [headers, status] of [
        [{ host: "localhost:3000" }, 403],
        [{ origin: "http://localhost:5173" }, 403],
        [{ "content-type": "text/plain" }, 415],
      ] as const) {
        const response = await f.request(root, "POST", body(), headers);
        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      const headers = f.client.headers();
      headers.set("origin", "http://localhost:5174");
      headers.set("content-type", "application/json");
      headers.set("content-encoding", "gzip");
      expect(
        (
          await f.transport(
            new Request(`http://localhost:3100${root}`, {
              method: "POST",
              headers,
              body: new Uint8Array(gzipSync(JSON.stringify(body()))),
            }),
          )
        ).status,
      ).toBe(415);
      headers.delete("content-encoding");
      expect(
        (
          await f.transport(
            new Request(`http://localhost:3100${root}`, { method: "POST", headers, body: "{" }),
          )
        ).status,
      ).toBe(400);
      const authority = await f.request(root, "POST", {
        ...body(),
        tenantId: f.context.tenant,
        userId: f.context.actor,
        role: "owner",
      });
      expect(authority.status).toBe(400);
      expect(await authority.text()).not.toContain("private@example.test");
      const created = usRequestCommandResponseSchema.parse(
        await (await f.request(root, "POST", body())).json(),
      );
      expect(
        (await f.request(root, "POST", { ...body(), requesterName: "A".repeat(256 * 1024) }))
          .status,
      ).toBe(413);
      expect(
        (
          await f.request(`${root}/${created.requestId}`, "PATCH", {
            expectedRevision: 1,
            requesterName: "A".repeat(256 * 1024),
          })
        ).status,
      ).toBe(413);
      for (const action of ["close", "validate", "acknowledge-warnings", "prepare"])
        expect(
          (
            await f.request(`${root}/${created.requestId}/${action}`, "POST", {
              padding: "A".repeat(16 * 1024),
            })
          ).status,
        ).toBe(413);
      expect(
        (
          await f.request(`/traceability/export-runs/${randomUUID()}/retry`, "POST", {
            padding: "A".repeat(16 * 1024),
          })
        ).status,
      ).toBe(413);
      const tlcs = Array.from({ length: 50 }, (_, index) => `${index}${"界".repeat(118)}`);
      const unicode = { ...body(), scope: { tlcs } };
      expect(Buffer.byteLength(JSON.stringify(unicode))).toBeGreaterThan(16 * 1024);
      const response = await f.request(root, "POST", unicode);
      expect(response.status).toBe(201);
      const ack = usRequestCommandResponseSchema.parse(await response.json());
      expect(
        (
          await f.request(`${root}/${ack.requestId}`, "PATCH", {
            expectedRevision: 1,
            scope: { tlcs },
          })
        ).status,
      ).toBe(200);
    });

    it("routes every request command and immutable queued-run read through accepted services", async () => {
      const response = await f.request(root, "POST", {
        ...body(),
        scope: { lotId: f.context.lot },
      });
      const ack = usRequestCommandResponseSchema.parse(await response.json());
      const url = `${root}/${ack.requestId}`;
      const list = usRequestListResponseSchema.parse(
        await (
          await f.request(
            `${root}?requestNumber=${encodeURIComponent((await f.database.db.select().from(schema.traceRequests).where(eq(schema.traceRequests.id, ack.requestId)))[0]?.requestNumber ?? "")}&limit=1&offset=0`,
          )
        ).json(),
      );
      expect(list.items).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain("private@example.test");
      const detail = usRequestDetailResponseSchema.parse(await (await f.request(url)).json());
      expect(detail.availability).toEqual({ build: "available", packageStorage: "configured" });
      expect(detail.requesterContact).toBe("private@example.test");
      const edit = await f.request(url, "PATCH", {
        expectedRevision: 1,
        requesterName: "Edited HTTP requester",
      });
      expect(edit.status).toBe(200);
      const edited = usRequestCommandResponseSchema.parse(await edit.json());
      expect(edited.revision).toBe(2);
      expect((await f.request(`${url}/validate`, "POST", { expectedRevision: 1 })).status).toBe(
        409,
      );
      const validationResponse = await f.request(`${url}/validate`, "POST", {
        expectedRevision: 2,
      });
      expect(validationResponse.status).toBe(200);
      const validation = usRequestValidationHttpResponseSchema.parse(
        await validationResponse.json(),
      );
      expect(validationResponse.headers.get("x-request-id")).toBe(validation.httpRequestId);
      // A warning acknowledgement records saved warning intent without waiving blockers.
      const warning = await f.request(`${url}/acknowledge-warnings`, "POST", {
        expectedRevision: 2,
        digest: validation.digest,
        reason: "Synthetic HTTP warning review",
      });
      expect(warning.status).toBe(
        validation.findings.some((finding) => finding.severity === "warning") ? 200 : 409,
      );
      if (warning.status === 200) usRequestCommandResponseSchema.parse(await warning.json());
      const prepareBody = {
        expectedRevision: 2,
        validationDigest: validation.digest,
        mode: "available_records_incomplete",
        idempotencyKey: randomUUID(),
      };
      const prepare = await f.request(`${url}/prepare`, "POST", prepareBody);
      expect(prepare.status).toBe(200);
      const run = usRequestPrepareResponseSchema.parse(await prepare.json());
      expect(prepare.headers.get("x-request-id")).toBe(run.httpRequestId);
      const runs = usRequestRunListResponseSchema.parse(
        await (await f.request(`${url}/runs?limit=1&offset=0`)).json(),
      );
      expect(runs.items[0]?.runId).toBe(run.runId);
      const runUrl = `/traceability/export-runs/${run.runId}`;
      const runDetail = usRequestRunDetailSchema.parse(await (await f.request(runUrl)).json());
      expect(runDetail.status).toBe("queued");
      expect(JSON.stringify(runDetail)).not.toMatch(
        /leaseToken|objectKey|inputSnapshot|checkpoint/,
      );
      expect(
        usRequestAttemptListResponseSchema.parse(
          await (await f.request(`${runUrl}/attempts?limit=1&offset=0`)).json(),
        ).items,
      ).toEqual([]);
      expect(await f.database.db.select().from(schema.traceExportAttempts)).toEqual([]);
      expect(f.storage.calls).toEqual([]);
      expect(
        (
          await f.request(`${runUrl}/retry`, "POST", {
            expectedLifecycleVersion: 1,
            reason: "Synthetic manual retry",
            idempotencyKey: randomUUID(),
          })
        ).status,
      ).toBe(409);
      expect((await f.request(`${url}/close`, "POST", { expectedRevision: 2 })).status).toBe(200);
      const replay = usRequestPrepareResponseSchema.parse(
        await (await f.request(`${url}/prepare`, "POST", prepareBody)).json(),
      );
      expect(replay.runId).toBe(run.runId);
      const audit = await f.database.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.requestId, ack.httpRequestId));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        organizationId: f.context.tenant,
        actorUserId: f.context.actor,
        requestId: ack.httpRequestId,
        targetType: "trace_request",
        targetId: ack.requestId,
        action: "traceability.request.created",
        outcome: "success",
      });
    });

    it("denies foreign IDs, fresh role/profile revocation and unauthenticated requests", async () => {
      expect((await f.request(root, "GET", undefined, { cookie: "" })).status).toBe(401);
      const foreign = await seedCompleteReceiving(f.database.db);
      const request = await new UsRequestStore(f.database.db).create(
        foreign.tenant,
        foreign.actor,
        body(),
      );
      expect((await f.request(`${root}/${request.id}`)).status).toBe(404);
      expect(
        (
          await f.request(`${root}/${request.id}`, "PATCH", {
            expectedRevision: 1,
            requesterName: "Foreign",
          })
        ).status,
      ).toBe(404);
      expect((await f.request(`/traceability/export-runs/${randomUUID()}`)).status).toBe(404);
      try {
        await f.database.db
          .update(schema.member)
          .set({ role: "traceability_auditor" })
          .where(eq(schema.member.id, f.context.member));
        expect((await f.request(root)).status).toBe(200);
        expect((await f.request(root, "POST", body())).status).toBe(403);
        await f.database.db
          .update(schema.traceabilityProfiles)
          .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
          .where(eq(schema.traceabilityProfiles.tenantId, f.context.tenant));
        expect((await f.request(root)).status).toBe(403);
      } finally {
        await f.database.db
          .update(schema.traceabilityProfiles)
          .set({ code: "US_FSMA204_PROCESSOR" })
          .where(eq(schema.traceabilityProfiles.tenantId, f.context.tenant));
        await f.database.db
          .update(schema.member)
          .set({ role: "owner" })
          .where(eq(schema.member.id, f.context.member));
      }
    });

    it("releases audited full bytes after close, rejects HEAD/Range before storage, and ignores conditional shortcuts", async () => {
      const source = await prepareUsWorkerSource(
        f.database.db,
        f.context,
        "available_records_incomplete",
        { lotId: f.context.lot },
        false,
      );
      const published = bindUsRequestWorkerFixture(f.database.db, source);
      try {
        // Drain only this owned test database's earlier queued fixture before checking this winner.
        for (let index = 0; index < 3; index++) {
          const result = await published.worker.runOne();
          if ("scope" in result && result.scope.runId === source.run.id) break;
        }
        await published.verifyReady();
        for (const [key, object] of published.storage.objects) f.storage.objects.set(key, object);
        const close = await f.request(`${root}/${source.request.id}/close`, "POST", {
          expectedRevision: 1,
        });
        expect(close.status).toBe(200);
        await f.database.db
          .update(schema.member)
          .set({ role: "traceability_auditor" })
          .where(eq(schema.member.id, f.context.member));
        const path = `/traceability/export-runs/${source.run.id}/artifacts/package_zip`;
        const before = f.storage.calls.length;
        expect((await f.request(path, "HEAD")).status).toBe(404);
        expect((await f.request(path, "GET", undefined, { range: "bytes=0-99" })).status).toBe(400);
        expect(f.storage.calls).toHaveLength(before);
        const response = await f.request(path, "GET", undefined, {
          "if-none-match": "*",
          "if-modified-since": "Wed, 01 Jan 2099 00:00:00 GMT",
          "if-match": '"wrong"',
        });
        expect(response.status).toBe(200);
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.length).toBe(Number(response.headers.get("content-length")));
        expect(response.headers.get("content-disposition")).toBe(
          'attachment; filename="package.zip"',
        );
        expect(response.headers.get("content-type")).toBe("application/zip");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("etag")).toBeNull();
        const audit = await f.database.db
          .select()
          .from(schema.tenantAuditEvents)
          .where(
            eq(schema.tenantAuditEvents.requestId, response.headers.get("x-request-id") ?? ""),
          );
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          organizationId: f.context.tenant,
          actorUserId: f.context.actor,
          action: "traceability.request.artifact_downloaded",
          outcome: "success",
          targetType: "trace_export_run",
          targetId: source.run.id,
          after: {
            byteSize: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            kind: "package_zip",
          },
        });
        const detail = usRequestRunDetailSchema.parse(
          await (await f.request(`/traceability/export-runs/${source.run.id}`)).json(),
        );
        expect(detail.status).toBe("ready");
        expect(detail.exportReady).toBe(false);
        expect(
          usRequestAttemptListResponseSchema.parse(
            await (await f.request(`/traceability/export-runs/${source.run.id}/attempts`)).json(),
          ).items,
        ).toHaveLength(1);
      } finally {
        await f.database.db
          .update(schema.member)
          .set({ role: "owner" })
          .where(eq(schema.member.id, f.context.member));
        published.destroy();
      }
    }, 60_000);

    it("accepts a real failed-run manual retry and replays its frozen receipt", async () => {
      const source = await prepareUsWorkerSource(
        f.database.db,
        f.context,
        "available_records_incomplete",
        { lotId: f.context.lot },
        false,
      );
      const worker = bindUsRequestWorkerFixture(f.database.db, source);
      try {
        const lease = await worker.lifecycle.claimNext();
        if (!lease || lease.runId !== source.run.id)
          throw new Error("Wrong owned retry fixture lease");
        await worker.lifecycle.finishFailure(lease, {
          code: "us_request_report_render_failed",
          retryable: false,
        });
        const detail = usRequestRunDetailSchema.parse(
          await (await f.request(`/traceability/export-runs/${source.run.id}`)).json(),
        );
        expect(detail.status).toBe("failed");
        const command = {
          expectedLifecycleVersion: detail.lifecycleVersion,
          reason: "Synthetic HTTP retry",
          idempotencyKey: randomUUID(),
        };
        const response = await f.request(
          `/traceability/export-runs/${source.run.id}/retry`,
          "POST",
          command,
        );
        expect(response.status).toBe(200);
        const receipt = usRequestRetryResponseSchema.parse(await response.json());
        expect(receipt.httpRequestId).toBe(response.headers.get("x-request-id"));
        const replay = usRequestRetryResponseSchema.parse(
          await (
            await f.request(`/traceability/export-runs/${source.run.id}/retry`, "POST", command)
          ).json(),
        );
        expect(replay.runId).toBe(receipt.runId);
        expect(replay.lifecycleVersion).toBe(receipt.lifecycleVersion);
      } finally {
        worker.destroy();
      }
    }, 60_000);
  },
);

describe.skipIf(!process.env.US_TEST_DATABASE_URL)("US Requests local availability and MFA", () => {
  it.each(["missing", "dirty"] as const)(
    "keeps real CRUD/read available with %s build and refuses Validate/Prepare",
    async (build) => {
      const document = await captureUsRequestBuildDescriptor(f.build.cleanBuild, f.roots);
      if (build === "dirty")
        await f.build.writeDocument({ ...document, build: { ...document.build, dirty: true } });
      else await unlink(f.build.descriptorPath);
      try {
        const created = await f.request(root, "POST", body());
        expect(created.status).toBe(201);
        const ack = usRequestCommandResponseSchema.parse(await created.json());
        const path = `${root}/${ack.requestId}`;
        const detail = usRequestDetailResponseSchema.parse(await (await f.request(path)).json());
        expect(detail.availability.build).toBe("unavailable");
        expect(
          (await f.request(path, "PATCH", { expectedRevision: 1, requesterName: "Edited" })).status,
        ).toBe(200);
        expect((await f.request(root)).status).toBe(200);
        for (const [action, command] of [
          ["validate", { expectedRevision: 2 }],
          [
            "prepare",
            {
              expectedRevision: 2,
              validationDigest: "a".repeat(64),
              mode: "available_records_incomplete",
              idempotencyKey: randomUUID(),
            },
          ],
        ] as const) {
          const response = await f.request(`${path}/${action}`, "POST", command);
          expect(response.status).toBe(503);
          expect(await response.json()).toEqual({ code: "us_request_build_unavailable" });
        }
        expect((await f.request(`${path}/close`, "POST", { expectedRevision: 2 })).status).toBe(
          200,
        );
      } finally {
        await f.build.writeDocument(document);
      }
    },
    60_000,
  );

  it("validates a checked clean build without storage and refuses package commands", async () => {
    await f.restart(false);
    const before = f.storage.calls.length;
    try {
      const ack = usRequestCommandResponseSchema.parse(
        await (
          await f.request(root, "POST", { ...body(), scope: { lotId: f.context.lot } })
        ).json(),
      );
      const path = `${root}/${ack.requestId}`;
      const validation = await f.request(`${path}/validate`, "POST", { expectedRevision: 1 });
      expect(validation.status).toBe(200);
      const saved = usRequestValidationHttpResponseSchema.parse(await validation.json());
      const prepared = await f.request(`${path}/prepare`, "POST", {
        expectedRevision: 1,
        validationDigest: saved.digest,
        mode: "available_records_incomplete",
        idempotencyKey: randomUUID(),
      });
      expect(prepared.status).toBe(503);
      expect(await prepared.json()).toEqual({ code: "us_request_package_storage_unavailable" });
      const source = await prepareUsWorkerSource(
        f.database.db,
        f.context,
        "available_records_incomplete",
        { lotId: f.context.lot },
        false,
      );
      const published = bindUsRequestWorkerFixture(f.database.db, source);
      try {
        for (let index = 0; index < 3; index++) {
          const result = await published.worker.runOne();
          if ("scope" in result && result.scope.runId === source.run.id) break;
        }
        await published.verifyReady();
        expect(
          (await f.request(`/traceability/export-runs/${source.run.id}/artifacts/package_zip`))
            .status,
        ).toBe(503);
        expect(
          (
            await f.request(`/traceability/export-runs/${source.run.id}/retry`, "POST", {
              expectedLifecycleVersion: 1,
              reason: "Synthetic retry",
              idempotencyKey: randomUUID(),
            })
          ).status,
        ).toBe(503);
      } finally {
        published.destroy();
      }
      expect(f.storage.calls).toHaveLength(before);
    } finally {
      await f.restart(true);
    }
  }, 60_000);

  it("denies an actual password session without enrolled verified MFA", async () => {
    expect(f.passwordSessionStatus).toBe(403);
  }, 60_000);
});
