import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUsRequestPublishedState } from "../src/modules/traceability/requests/us-request-publication-read";
import { UsRequestReadStore } from "../src/modules/traceability/requests/us-request-read";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  createUsRequestWorkerFixture,
  createUsWorkerDatabaseTransport,
} from "./support/us-request-worker-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("checked committed US publication reads in owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let worker: Awaited<ReturnType<typeof createUsRequestWorkerFixture>>;
  beforeEach(async () => {
    if (!url) throw new Error("Explicit isolated US database URL required");
    f = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterEach(async () => {
    worker?.destroy();
    await f?.close();
  });
  const ready = async (incomplete = false) => {
    worker = await createUsRequestWorkerFixture(f.db, {
      mode: incomplete ? "available_records_incomplete" : "export_ready",
      empty: incomplete,
      withPlan: !incomplete,
    });
    await worker.worker.runOne();
    const result = await worker.verifyReady();
    return result.state;
  };
  const read = () =>
    f.db.transaction(
      (tx) => readUsRequestPublishedState(tx, worker.scope.tenantId, worker.scope.runId),
      { isolationLevel: "repeatable read" },
    );
  const detail = () =>
    new UsRequestReadStore(f.db).getRun(
      {
        tenantId: worker.scope.tenantId,
        userId: worker.source.actorId,
        httpRequestId: randomUUID(),
      },
      worker.scope.runId,
    );

  // Corrupt one SQL result from a real published winner, never durable evidence or clocks.
  const faultedRead = async (table: string, fields: Record<string, unknown>, omit = false) => {
    const record = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const pool = f.db.$client;
    const query =
      (target: { query: unknown }, receiver: object) =>
      async (...args: unknown[]) => {
        const input = args[0];
        const parameters = args[1];
        const output: unknown = await Reflect.apply(
          target.query as (...values: unknown[]) => unknown,
          receiver,
          args,
        );
        if (
          !record(input) ||
          typeof input.text !== "string" ||
          !input.text.includes(`from "${table}"`) ||
          !Array.isArray(parameters) ||
          !parameters.includes(worker.scope.runId) ||
          !record(output) ||
          !Array.isArray(output.rows) ||
          !Array.isArray(output.fields)
        )
          return output;
        const columns = output.fields.map((field) =>
          record(field) && typeof field.name === "string" ? field.name : "",
        );
        const rows = output.rows.map((row: unknown, index: number) => {
          if (index !== 0 || !Array.isArray(row)) return row;
          return row.map((value: unknown, column: number) =>
            Object.hasOwn(fields, columns[column] ?? "") ? fields[columns[column] ?? ""] : value,
          );
        });
        return { ...output, rows: omit ? rows.slice(1) : rows };
      };
    const wrapped = new Proxy(pool, {
      get(target, key) {
        if (key === "connect")
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(receiver, field) {
                if (field === "query") return query(receiver, receiver);
                const value: unknown = Reflect.get(receiver, field, receiver);
                return typeof value === "function" ? value.bind(receiver) : value;
              },
            });
          };
        if (key === "query") return query(target, target);
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return drizzle(wrapped).transaction(
      (tx) => readUsRequestPublishedState(tx, worker.scope.tenantId, worker.scope.runId),
      { isolationLevel: "repeatable read" },
    );
  };

  // Breaks caught: candidate intents treated as authority, partial winners, and unsafe projections.
  it("accepts a real full worker winner without storage calls or mutations", async () => {
    await ready();
    const transport = createUsWorkerDatabaseTransport(f.db);
    const before = await worker.lifecycle.read(worker.scope);
    const result = await transport.db.transaction((tx) =>
      readUsRequestPublishedState(tx, worker.scope.tenantId, worker.scope.runId),
    );
    expect(result.artifacts).toHaveLength(6);
    expect((await detail()).artifacts.map((file) => file.kind).sort()).toEqual([
      "manifest",
      "package_zip",
      "plan_pdf",
      "request_report",
      "validation_report",
      "xlsx",
    ]);
    expect(JSON.stringify(await detail())).not.toMatch(
      /objectKey|leaseToken|executionDigest|inputSnapshot|packageExpectation/,
    );
    expect(await worker.lifecycle.read(worker.scope)).toEqual(before);
    expect(transport.statements.some(({ raw }) => /^\s*(insert|update|delete)\b/i.test(raw))).toBe(
      false,
    );
    for (const table of [
      "trace_export_artifacts",
      "trace_export_object_intents",
      "trace_export_attempts",
    ])
      expect(
        transport.statements
          .filter(({ raw }) => raw.includes(`from "${table}"`))
          .every(({ raw }) => raw.includes("limit")),
      ).toBe(true);
    await expect(
      f.db.transaction((tx) => readUsRequestPublishedState(tx, randomUUID(), worker.scope.runId)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("keeps a real ready incomplete package distinct from export readiness", async () => {
    await ready(true);
    expect(await detail()).toMatchObject({
      status: "ready",
      mode: "available_records_incomplete",
      exportReady: false,
      missingFiles: [
        { name: "records.xlsx", code: "empty_selection" },
        { name: "plan.pdf", code: "plan_absent" },
      ],
    });
    expect((await read()).artifacts).toHaveLength(4);
  });

  it("refuses partial ready artifact evidence", async () => {
    await ready();
    await expect(faultedRead("trace_export_artifacts", {}, true)).rejects.toMatchObject({
      status: 503,
    });
  });

  it.each([
    "hash",
    "size",
    "key",
    "publishedAt",
    "winner",
    "verified_only",
    "checkpoint",
    "fenced",
    "deleted",
    "unverified",
    "referencedAt",
    "mediaType",
    "kind",
    "intent_hash",
    "intent_size",
  ])("refuses %s mismatch without repair", async (mutation) => {
    const state = await ready();
    const artifact = state.artifacts[0];
    if (!artifact) throw new Error("Missing real publication artifact");
    const table =
      mutation === "winner"
        ? "trace_export_attempts"
        : [
              "verified_only",
              "fenced",
              "deleted",
              "unverified",
              "referencedAt",
              "intent_hash",
              "intent_size",
            ].includes(mutation)
          ? "trace_export_object_intents"
          : mutation === "checkpoint"
            ? "trace_export_render_checkpoints"
            : "trace_export_artifacts";
    const faults: Record<string, Record<string, unknown>> = {
      hash: { sha256: "0".repeat(64) },
      size: { byte_size: (artifact.byteSize + 1n).toString() },
      key: { object_key: "synthetic-wrong-private-key" },
      publishedAt: { published_at: new Date(artifact.publishedAt.getTime() + 1) },
      winner: { report_rendered_at: new Date(artifact.publishedAt.getTime() + 1) },
      verified_only: { state: "verified", referenced_at: null },
      checkpoint: { model_digest: "0".repeat(64) },
      fenced: { fenced_at: artifact.publishedAt },
      deleted: { deleted_at: artifact.publishedAt },
      unverified: { verified_at: null },
      referencedAt: { referenced_at: new Date(artifact.publishedAt.getTime() + 1) },
      mediaType: { media_type: "text/plain" },
      kind: { kind: "unexpected" },
      intent_hash: { sha256: "0".repeat(64) },
      intent_size: { byte_size: "1" },
    };
    const fields = faults[mutation];
    if (!fields) throw new Error("Missing explicit corruption case");
    await expect(faultedRead(table, fields)).rejects.toMatchObject({ status: 503 });
    expect((await read()).artifacts).toHaveLength(6);
  });

  it("retains actual immutable SQL guards on published evidence", async () => {
    const state = await ready();
    const artifact = state.artifacts[0];
    if (!artifact) throw new Error("Missing real publication artifact");
    await expect(
      f.db
        .update(schema.traceExportArtifacts)
        .set({ sha256: "0".repeat(64) })
        .where(eq(schema.traceExportArtifacts.id, artifact.id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      f.db
        .delete(schema.traceExportArtifacts)
        .where(eq(schema.traceExportArtifacts.id, artifact.id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    expect((await read()).artifacts).toHaveLength(6);
  });

  it("rejects an actual extra published row outside the worker expectation", async () => {
    const state = await ready(true);
    const winner = state.attempts.find((item) => item.status === "succeeded");
    if (!winner || !state.run.completedAt) throw new Error("Missing real committed winner");
    await f.db.insert(schema.traceExportArtifacts).values({
      tenantId: worker.scope.tenantId,
      runId: worker.scope.runId,
      kind: "plan_pdf",
      filename: "plan.pdf",
      mediaType: "application/pdf",
      byteSize: 1n,
      sha256: "a".repeat(64),
      objectKey: `us/requests/${worker.scope.tenantId}/${worker.scope.runId}/${winner.id}/plan.pdf`,
      publishedAt: state.run.completedAt,
    });
    await expect(read()).rejects.toMatchObject({ status: 503 });
    await expect(detail()).rejects.toMatchObject({ status: 503 });
  });

  it("does not treat a real queued or active run as published authority", async () => {
    worker = await createUsRequestWorkerFixture(f.db, {
      mode: "available_records_incomplete",
      empty: true,
      withPlan: false,
    });
    await expect(read()).rejects.toMatchObject({ status: 409 });
    const lease = await worker.lifecycle.claimNext();
    if (!lease) throw new Error("Missing actual active attempt");
    await expect(read()).rejects.toMatchObject({ status: 409 });
    expect(await detail()).toMatchObject({
      status: "processing",
      artifacts: [],
      missingFiles: null,
    });
  });
});
