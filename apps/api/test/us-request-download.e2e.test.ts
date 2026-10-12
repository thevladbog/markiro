import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import { UsRequestDownloadStore } from "../src/modules/traceability/requests/us-request-download";
import { UsRequestHttpResources } from "../src/deployment/us-request-http-resources";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { createUsRequestWorkerFixture } from "./support/us-request-worker-fixture";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Fixture = Awaited<ReturnType<typeof createUsRequestWorkerFixture>>;
type Database = Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
type Context = { tenantId: string; userId: string; httpRequestId: string };
const audit = (f: Database, ctx: Context) =>
  f.db
    .select()
    .from(schema.tenantAuditEvents)
    .where(eq(schema.tenantAuditEvents.requestId, ctx.httpRequestId));
const role = (f: Database, ctx: Context, value: string) =>
  f.db
    .update(schema.member)
    .set({ role: value })
    .where(
      and(eq(schema.member.organizationId, ctx.tenantId), eq(schema.member.userId, ctx.userId)),
    );

async function fixture(
  body: (
    f: Database,
    published: Fixture,
    ctx: Context,
    downloads: UsRequestDownloadStore,
  ) => Promise<void>,
  options: {
    mode: "export_ready" | "available_records_incomplete";
    withPlan: boolean;
    empty?: boolean;
  } = { mode: "available_records_incomplete", withPlan: false },
  publish = true,
) {
  if (!url) throw new Error("Explicit isolated US database URL required");
  let f: Database | undefined;
  let published: Fixture | undefined;
  try {
    f = await createUsProfileTestDatabase(url);
    published = await createUsRequestWorkerFixture(f.db, options);
    if (publish) {
      await published.worker.runOne();
      await published.verifyReady();
    }
    const ctx = {
      tenantId: published.source.tenantId,
      userId: published.source.actorId,
      httpRequestId: randomUUID(),
    };
    if (publish) await role(f, ctx, "traceability_auditor");
    const store = published.store;
    await body(f, published, ctx, new UsRequestDownloadStore(f.db, () => store));
  } finally {
    published?.destroy();
    await f?.close();
  }
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Held I/O checkpoint timed out")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!url)("verified private US downloads in owned PostgreSQL", () => {
  // Breaks caught: release without hash validation, QA-only access, or wrong audit identity.
  it("releases real incomplete package bytes for an auditor with exact release audit", async () => {
    await fixture(async (f, published, ctx, downloads) => {
      const result = await downloads.download(ctx, published.scope.runId, "package_zip");
      expect(result.filename).toBe("package.zip");
      expect(result.mediaType).toBe("application/zip");
      expect(result.bytes.length).toBe(result.byteSize);
      expect(hash(result.bytes)).toBe(result.sha256);
      const rows = await audit(f, ctx);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId: ctx.tenantId,
        actorUserId: ctx.userId,
        requestId: ctx.httpRequestId,
        action: "traceability.request.artifact_downloaded",
        outcome: "success",
        targetType: "trace_export_run",
        targetId: published.scope.runId,
        before: null,
        after: {
          requestId: published.source.request.id,
          requestRevision: 1,
          runRevision: 1,
          mode: "available_records_incomplete",
          kind: "package_zip",
          byteSize: result.byteSize,
          sha256: result.sha256,
        },
      });
      expect(Object.keys(rows[0]?.after ?? {}).sort()).toEqual([
        "byteSize",
        "kind",
        "mode",
        "requestId",
        "requestRevision",
        "runRevision",
        "sha256",
      ]);
      expect(JSON.stringify(rows)).not.toMatch(
        /objectKey|private@example|leaseToken|inputSnapshot/,
      );
    });
  }, 60_000);

  it("downloads all six published kinds from a real full winner", async () => {
    await fixture(
      async (f, published, base, downloads) => {
        for (const [kind, filename, mediaType] of [
          [
            "xlsx",
            "records.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ],
          ["plan_pdf", "plan.pdf", "application/pdf"],
          ["validation_report", "validation.json", "application/json"],
          ["request_report", "request-report.pdf", "application/pdf"],
          ["manifest", "manifest.json", "application/json"],
          ["package_zip", "package.zip", "application/zip"],
        ]) {
          const ctx = { ...base, httpRequestId: randomUUID() };
          const result = await downloads.download(ctx, published.scope.runId, kind);
          expect(result).toMatchObject({
            filename,
            mediaType,
            byteSize: result.bytes.length,
            sha256: hash(result.bytes),
          });
          expect(await audit(f, ctx)).toMatchObject([{ outcome: "success", after: { kind } }]);
        }
      },
      { mode: "export_ready", withPlan: true },
    );
  }, 60_000);

  it("refuses absent optional files and arbitrary kinds without storage or target audit", async () => {
    await fixture(
      async (f, published, ctx, downloads) => {
        const before = published.storage.calls.length;
        for (const kind of ["xlsx", "plan_pdf"])
          await expect(downloads.download(ctx, published.scope.runId, kind)).rejects.toMatchObject({
            status: 404,
          });
        for (const kind of ["SHA256SUMS", "../manifest.json", "unknown"])
          await expect(downloads.download(ctx, published.scope.runId, kind)).rejects.toMatchObject({
            status: 400,
          });
        expect(published.storage.calls).toHaveLength(before);
        expect(await audit(f, ctx)).toEqual([]);
      },
      { mode: "available_records_incomplete", withPlan: false, empty: true },
    );
  }, 60_000);

  it("denies foreign targets and authorizes before parsing malformed inputs", async () => {
    await fixture(async (f, published, ctx, downloads) => {
      const foreign = await seedCompleteReceiving(f.db);
      const before = published.storage.calls.length;
      const foreignCtx = { ...ctx, tenantId: foreign.tenant, userId: foreign.actor };
      await expect(
        downloads.download(foreignCtx, published.scope.runId, "package_zip"),
      ).rejects.toMatchObject({ status: 404 });
      expect(await audit(f, foreignCtx)).toEqual([]);
      await role(f, ctx, "member");
      await expect(downloads.download(ctx, "malformed", "unknown")).rejects.toMatchObject({
        status: 403,
      });
      expect(published.storage.calls).toHaveLength(before);
      expect(await audit(f, ctx)).toEqual([]);
    });
  }, 60_000);

  it("refuses queued and failed runs without fetching candidates", async () => {
    await fixture(
      async (f, published, ctx, downloads) => {
        await expect(
          downloads.download(ctx, published.scope.runId, "package_zip"),
        ).rejects.toMatchObject({ status: 409 });
        const lease = await published.lifecycle.claimNext();
        if (!lease) throw new Error("Missing real lease");
        await published.lifecycle.finishFailure(lease, {
          code: "us_request_worker_stored_invalid",
          retryable: false,
        });
        expect((await published.lifecycle.read(published.scope)).run.status).toBe("failed");
        await expect(
          downloads.download(ctx, published.scope.runId, "package_zip"),
        ).rejects.toMatchObject({ status: 409 });
        expect(published.storage.calls).toEqual([]);
        expect(await audit(f, ctx)).toEqual([]);
      },
      undefined,
      false,
    );
  }, 60_000);

  it("does not substitute a real uploading candidate intent for a committed artifact", async () => {
    await fixture(
      async (f, published, ctx, downloads) => {
        let unblock: () => void = () => {};
        let entered: () => void = () => {};
        const release = new Promise<void>((resolve) => {
          unblock = resolve;
        });
        const observed = new Promise<void>((resolve) => {
          entered = resolve;
        });
        published.storage.faults.before = async (command) => {
          if (command instanceof PutObjectCommand) {
            entered();
            await release;
          }
        };
        const pending = published.worker.runOne();
        const settlement = pending.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        try {
          await bounded(observed);
          expect(
            await f.db
              .select()
              .from(schema.traceExportObjectIntents)
              .where(eq(schema.traceExportObjectIntents.runId, published.scope.runId)),
          ).not.toEqual([]);
          const before = published.storage.calls.length;
          await expect(
            downloads.download(ctx, published.scope.runId, "package_zip"),
          ).rejects.toMatchObject({ status: 409 });
          expect(published.storage.calls).toHaveLength(before);
          expect(await audit(f, ctx)).toEqual([]);
        } finally {
          unblock();
          await settlement;
        }
        await pending;
        await published.verifyReady();
      },
      undefined,
      false,
    );
  }, 60_000);

  it.each(["type", "size", "hash", "cap", "missing", "provider"] as const)(
    "rejects %s storage faults without bytes or success audit",
    async (fault) => {
      await fixture(async (f, published, ctx, downloads) => {
        published.storage.faults.before = async (command) => {
          if (!(command instanceof GetObjectCommand)) return;
          if (fault === "missing") throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
          if (fault === "provider") throw new Error("provider-private-secret/key/contact");
        };
        published.storage.faults.after = async (command, response) => {
          if (!(command instanceof GetObjectCommand) || !response || typeof response !== "object")
            return response;
          if (fault === "type") return { ...response, ContentType: "text/plain" };
          if (fault === "size") return { ...response, ContentLength: 1 };
          if (fault === "hash" || fault === "cap") {
            const object = published.storage.objects.get(command.input.Key ?? "");
            if (!object) throw new Error("Missing fixture object");
            const bytes = Buffer.from(object.bytes);
            if (fault === "hash") bytes[0] = (bytes[0] ?? 0) ^ 255;
            const body = Readable.from(
              fault === "cap" ? [bytes, Buffer.from("overflow")] : [bytes],
            );
            published.storage.bodies.push(body);
            return { ...response, Body: body };
          }
          return response;
        };
        const result = await downloads.download(ctx, published.scope.runId, "package_zip").then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        expect(result).toMatchObject({ error: { status: 503 } });
        expect(result).not.toHaveProperty("value");
        expect(JSON.stringify(result)).not.toMatch(/provider-private|objectKey|private@example/);
        expect(await audit(f, ctx)).toMatchObject([
          {
            organizationId: ctx.tenantId,
            actorUserId: ctx.userId,
            requestId: ctx.httpRequestId,
            action: "traceability.request.artifact_downloaded",
            outcome: "rejected",
            targetType: "trace_export_run",
            targetId: published.scope.runId,
            before: null,
            after: { code: expect.any(String) },
          },
        ]);
        expect((await audit(f, ctx)).some((row) => row.outcome === "success")).toBe(false);
      });
    },
    60_000,
  );

  it.each(["membership", "profile", "timeout"] as const)(
    "holds real GET then refuses %s before releasing buffered bytes",
    async (change) => {
      await fixture(async (f, published, ctx, downloads) => {
        let unblock: () => void = () => {};
        let entered: () => void = () => {};
        const release = new Promise<void>((resolve) => {
          unblock = resolve;
        });
        const observed = new Promise<void>((resolve) => {
          entered = resolve;
        });
        published.storage.faults.before = async (command) => {
          if (command instanceof GetObjectCommand) {
            entered();
            await release;
          }
        };
        const pending = downloads.download(ctx, published.scope.runId, "package_zip");
        const settlement = pending.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        try {
          await bounded(observed);
          // A real separate pooled connection must be free to revoke while GET is held.
          if (change === "membership") await bounded(role(f, ctx, "member"));
          if (change === "profile")
            await bounded(
              f.db
                .update(schema.traceabilityProfiles)
                .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
                .where(eq(schema.traceabilityProfiles.tenantId, ctx.tenantId)),
            );
          if (change === "timeout") {
            await expect(pending).rejects.toMatchObject({
              status: 503,
              response: { code: "us_request_package_storage_timeout" },
            });
          } else {
            unblock();
            await expect(pending).rejects.toMatchObject({ status: 403 });
          }
          expect(await settlement).not.toHaveProperty("value");
          const rows = await audit(f, ctx);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            organizationId: ctx.tenantId,
            actorUserId: ctx.userId,
            requestId: ctx.httpRequestId,
            action: "traceability.request.artifact_downloaded",
            outcome: "rejected",
            targetType: "trace_export_run",
            targetId: published.scope.runId,
            before: null,
            after: {
              code:
                change === "membership"
                  ? "insufficient_permission"
                  : change === "profile"
                    ? "us_request_profile_unsupported"
                    : "us_request_package_storage_timeout",
            },
          });
          expect(published.storage.calls.at(-1)?.signal.aborted).toBe(true);
        } finally {
          unblock();
          await settlement;
        }
      });
    },
    60_000,
  );

  it("never releases verified bytes if the atomic release audit fails", async () => {
    await fixture(async (f, published, ctx, downloads) => {
      const before = await published.lifecycle.read(published.scope);
      await f.pool.query(
        "CREATE FUNCTION reject_download_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='traceability.request.artifact_downloaded' AND NEW.outcome='success' THEN RAISE EXCEPTION 'synthetic private audit failure'; END IF; RETURN NEW; END $$",
      );
      await f.pool.query(
        "CREATE TRIGGER reject_download_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_download_audit()",
      );
      const result = await downloads.download(ctx, published.scope.runId, "package_zip").then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      expect(result).toMatchObject({ error: { status: 503 } });
      expect(result).not.toHaveProperty("value");
      expect(JSON.stringify(result)).not.toContain("synthetic private audit failure");
      expect((await audit(f, ctx)).some((row) => row.outcome === "success")).toBe(false);
      expect(await published.lifecycle.read(published.scope)).toEqual(before);
      await f.pool.query("DROP TRIGGER reject_download_audit ON tenant_audit_events");
      await expect(
        downloads.download(
          { ...ctx, httpRequestId: randomUUID() },
          published.scope.runId,
          "package_zip",
        ),
      ).resolves.toMatchObject({ filename: "package.zip" });
    });
  }, 60_000);

  it("rereads and compares the exact committed identity after GET", async () => {
    await fixture(async (f, published, ctx) => {
      let substitute = false;
      const record = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null;
      const pool = new Proxy(f.pool, {
        get(target, key) {
          if (key === "connect")
            return async () => {
              const client = await target.connect();
              return new Proxy(client, {
                get(receiver, field) {
                  if (field === "query")
                    return async (...args: unknown[]) => {
                      const output: unknown = await Reflect.apply(receiver.query, receiver, args);
                      const input = args[0];
                      if (
                        !substitute ||
                        !record(input) ||
                        typeof input.text !== "string" ||
                        !input.text.includes('from "trace_export_object_intents"') ||
                        !record(output) ||
                        !Array.isArray(output.rows) ||
                        !Array.isArray(output.fields)
                      )
                        return output;
                      const column = output.fields.findIndex(
                        (item: unknown) => record(item) && item.name === "id",
                      );
                      return {
                        ...output,
                        rows: output.rows.map((row: unknown) =>
                          Array.isArray(row)
                            ? row.map((value: unknown, index: number) =>
                                index === column ? randomUUID() : value,
                              )
                            : row,
                        ),
                      };
                    };
                  const value: unknown = Reflect.get(receiver, field, receiver);
                  return typeof value === "function" ? value.bind(receiver) : value;
                },
              });
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      published.storage.faults.after = async (_command, response) => {
        substitute = true;
        return response;
      };
      const downloads = new UsRequestDownloadStore(drizzle(pool), () => published.store);
      await expect(
        downloads.download(ctx, published.scope.runId, "package_zip"),
      ).rejects.toMatchObject({
        status: 503,
        response: { code: "us_request_publication_invalid" },
      });
      expect(await audit(f, ctx)).toMatchObject([
        {
          outcome: "rejected",
          targetId: published.scope.runId,
          after: { code: "us_request_publication_invalid" },
        },
      ]);
      // Fault only the SQL transport's second read; persisted winner remains intact.
      published.storage.faults.after = null;
      await published.verifyReady();
    });
  }, 60_000);

  it("keeps closed requests downloadable without checked build and refuses missing private storage", async () => {
    await fixture(async (f, published, ctx, downloads) => {
      await role(f, ctx, "owner");
      await new UsRequestStore(f.db).close(ctx.tenantId, ctx.userId, published.source.request.id, {
        expectedRevision: 1,
      });
      await role(f, ctx, "traceability_auditor");
      await expect(
        downloads.download(ctx, published.scope.runId, "package_zip"),
      ).resolves.toMatchObject({ filename: "package.zip" });
      const resources = new UsRequestHttpResources({
        NODE_ENV: "test",
        MARKIRO_DEPLOYMENT_EDITION: "US",
      });
      try {
        const before = published.storage.calls.length;
        const unavailable = new UsRequestDownloadStore(f.db, () => resources.requirePackageStore());
        await expect(
          unavailable.download(
            { ...ctx, httpRequestId: randomUUID() },
            published.scope.runId,
            "package_zip",
          ),
        ).rejects.toMatchObject({
          status: 503,
          response: { code: "us_request_package_storage_unavailable" },
        });
        expect(published.storage.calls).toHaveLength(before);
      } finally {
        resources.dispose();
      }
    });
  }, 60_000);
});
