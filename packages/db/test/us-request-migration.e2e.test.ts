import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US request migration in owned disposable PostgreSQL", () => {
  it("supports a fresh full migration", async () => {
    if (!url) throw new Error("US_TEST_DATABASE_URL is required");
    const fixture = await createUsProfileTestDatabase(url, 139);
    try {
      expect(
        (await fixture.pool.query("SELECT count(*)::int AS count FROM trace_requests")).rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      await fixture.close();
    }
  });
  it("preserves legacy rows and rejects cross-tenant references and invalid evidence", async () => {
    if (!url) throw new Error("US_TEST_DATABASE_URL is required");
    const fixture = await createUsProfileTestDatabase(url, 138);
    try {
      const a = randomUUID();
      const b = randomUUID();
      for (const id of [a, b])
        await fixture.pool.query(
          "INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic',$1,now())",
          [id],
        );
      await fixture.pool.query(
        "INSERT INTO traceability_profiles(tenant_id,code,baseline_version) VALUES($1,'US_FSMA204_PROCESSOR','fsma204-v1')",
        [a],
      );
      const event = randomUUID();
      const tx = await fixture.pool.connect();
      try {
        await tx.query("BEGIN");
        await tx.query(
          "INSERT INTO receiving_event_roots(id,tenant_id,event_number,pending_draft_id) VALUES($1,$2,'REC-26-0001',$1)",
          [event, a],
        );
        await tx.query(
          "INSERT INTO traceability_events(id,tenant_id,root_event_id,event_number,time_zone,created_by,updated_by,notes) VALUES($1,$2,$1,'REC-26-0001','America/Chicago','synthetic','synthetic','  Exact Ä  ')",
          [event, a],
        );
        await tx.query("COMMIT");
      } catch (error) {
        await tx.query("ROLLBACK");
        throw error;
      } finally {
        tx.release();
      }
      const plans = [randomUUID(), randomUUID()];
      for (const [i, tenant] of [a, b].entries())
        await fixture.pool.query(
          "INSERT INTO traceability_plan_versions(id,tenant_id,version_number,status,sections,created_by,approved_by,approved_at,config_snapshot,config_digest,pdf_object_key,pdf_sha256,pdf_byte_size,renderer_version) VALUES($1,$2,1,'effective','{}','qa','qa',now(),'{}',$3,'synthetic.pdf',$3,10,'synthetic-v1')",
          [plans[i], tenant, "a".repeat(64)],
        );
      const tables = [
        "organization",
        "traceability_profiles",
        "traceability_events",
        "receiving_event_roots",
        "traceability_plan_versions",
      ];
      const snapshot = () =>
        Promise.all(
          tables.map(
            async (table) =>
              (
                await fixture.pool.query(
                  `SELECT to_jsonb(t)::text AS exact FROM ${table} t ORDER BY 1`,
                )
              ).rows,
          ),
        );
      const before = await snapshot();
      const migrationsFolder = await mkdtemp(join(tmpdir(), "us-request-0139-"));
      try {
        await copyMigrationsThroughIndex({
          sourceFolder: resolve("../../packages/db/migrations"),
          targetFolder: migrationsFolder,
          lastIncludedIndex: 139,
        });
        await migrate(fixture.db, { migrationsFolder });
      } finally {
        await rm(migrationsFolder, { recursive: true, force: true });
      }
      expect(await snapshot()).toEqual(before);
      async function insert(table: string, row: Record<string, unknown>) {
        const entries = Object.entries(row);
        await fixture.pool.query(
          `INSERT INTO ${table}(${entries.map(([key]) => key).join()}) VALUES(${entries.map((_, i) => `$${i + 1}`).join()})`,
          entries.map(([key, value]) =>
            ["scope", "last_validation", "input_snapshot"].includes(key) && value !== null
              ? JSON.stringify(value)
              : value,
          ),
        );
      }
      const request = {
        id: randomUUID(),
        tenant_id: a,
        request_number: "REQ-A",
        requester_name: "Synthetic",
        received_at: "2026-09-17T16:00:00Z",
        due_at: "2026-09-18T16:00:00Z",
        created_by: "qa",
      };
      await insert("trace_requests", request);
      const run = {
        id: randomUUID(),
        tenant_id: a,
        request_id: request.id,
        revision: 1,
        mode: "available_records_incomplete",
        status: "queued",
        created_by: "qa",
        idempotency_key: randomUUID(),
        command_digest: "a".repeat(64),
        scoped_content_digest: "a".repeat(64),
        input_snapshot: { selectionKind: "empty" },
        started_at: "2026-09-18T12:00:00Z",
        plan_version_id: plans[0],
        plan_pdf_sha256: "a".repeat(64),
      };
      await expect(
        insert("trace_export_runs", { ...run, tenant_id: b, plan_version_id: plans[1] }),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        insert("trace_export_runs", { ...run, plan_version_id: plans[1] }),
      ).rejects.toMatchObject({ code: "23503" });
      await insert("trace_export_runs", run);
      // Fresh IDs/keys isolate revision uniqueness from primary-key and actor/key uniqueness.
      await expect(
        insert("trace_export_runs", { ...run, id: randomUUID(), idempotency_key: randomUUID() }),
      ).rejects.toMatchObject({ code: "23505", constraint: "trace_export_runs_revision_uq" });
      // Revision 2 is unused; only the original actor/idempotency tuple is duplicated.
      await expect(
        insert("trace_export_runs", { ...run, id: randomUUID(), revision: 2 }),
      ).rejects.toMatchObject({ code: "23505", constraint: "trace_export_runs_idempotency_uq" });
      const artifact = {
        id: randomUUID(),
        tenant_id: a,
        run_id: run.id,
        kind: "manifest",
        filename: "manifest.json",
        media_type: "application/json",
        byte_size: 1,
        sha256: "a".repeat(64),
        object_key: "synthetic/key",
        published_at: "2026-09-18T12:00:00Z",
      };
      await expect(
        insert("trace_export_artifacts", { ...artifact, tenant_id: b }),
      ).rejects.toMatchObject({ code: "23503" });
      await insert("trace_export_artifacts", artifact);
      for (const changes of [
        { scope: [] },
        { due_at: request.received_at },
        { due_at: "2026-09-19T16:00:00Z" },
        { alternate_deadline_reason: "Reason" },
        { due_at: "2026-09-19T16:00:00Z", alternate_deadline_reason: "ab" },
        { due_at: "2026-09-19T16:00:00Z", alternate_deadline_reason: " ".repeat(10) },
        { due_at: "2026-09-19T16:00:00Z", alternate_deadline_reason: "a".repeat(2001) },
        { last_validation_digest: "bad" },
        {
          last_validation: {},
          last_validation_digest: "bad",
          last_validated_at: request.received_at,
        },
        {
          last_validation: [],
          last_validation_digest: "a".repeat(64),
          last_validated_at: request.received_at,
        },
        { status: "closed" },
        { status: "unknown" },
        { closed_at: request.received_at },
        { revision: 0 },
        { warning_ack_digest: "a".repeat(64) },
      ])
        await expect(
          insert("trace_requests", {
            ...request,
            id: randomUUID(),
            request_number: randomUUID(),
            ...changes,
          }),
        ).rejects.toMatchObject({ code: "23514" });
      await expect(
        insert("trace_requests", { ...request, id: randomUUID() }),
      ).rejects.toMatchObject({ code: "23505" });
      for (const changes of [
        { command_digest: "A".repeat(64) },
        { input_snapshot: [] },
        { input_snapshot: { selectionKind: "nonempty" } },
        { input_digest: "a".repeat(64) },
        { completed_at: "2026-09-18T13:00:00Z" },
        { status: "ready" },
        { status: "failed", completed_at: "2026-09-18T13:00:00Z" },
        { export_ready: true },
        { plan_version_id: null },
        { plan_pdf_sha256: null },
        { registry_hash: "bad" },
        { mode: "unknown" },
        { status: "processing", failure_code: "failure" },
        { status: "ready", completed_at: request.received_at, failure_code: "failure" },
      ])
        await expect(
          insert("trace_export_runs", {
            ...run,
            id: randomUUID(),
            revision: 2,
            idempotency_key: randomUUID(),
            ...changes,
          }),
        ).rejects.toMatchObject({ code: "23514" });
      for (const changes of [{ kind: "unknown" }, { byte_size: 0 }, { sha256: "A".repeat(64) }])
        await expect(
          insert("trace_export_artifacts", { ...artifact, id: randomUUID(), ...changes }),
        ).rejects.toMatchObject({ code: "23514" });
      await expect(
        insert("trace_export_artifacts", {
          ...artifact,
          id: randomUUID(),
          filename: "other-manifest.json",
        }),
      ).rejects.toMatchObject({ code: "23505", constraint: "trace_export_artifacts_kind_uq" });
      await expect(
        insert("trace_export_artifacts", {
          ...artifact,
          id: randomUUID(),
          kind: "validation_report",
        }),
      ).rejects.toMatchObject({ code: "23505", constraint: "trace_export_artifacts_filename_uq" });
      for (const table of ["trace_requests", "trace_export_runs", "trace_export_artifacts"])
        expect((await fixture.pool.query(`SELECT tenant_id FROM ${table}`)).rows).toEqual([
          { tenant_id: a },
        ]);
      await expect(
        fixture.pool.query("DELETE FROM trace_requests WHERE id=$1", [request.id]),
      ).rejects.toMatchObject({ code: "23503" });
      expect(await snapshot()).toEqual(before);
      await insert("trace_requests", {
        ...request,
        id: randomUUID(),
        request_number: "REQ-ALTERNATE",
        scope: {},
        due_at: "2026-09-19T16:00:00Z",
        alternate_deadline_reason: "Requested extension",
        status: "closed",
        closed_at: request.received_at,
        last_validation: {},
        last_validation_digest: "a".repeat(64),
        last_validated_at: request.received_at,
        warning_ack_digest: "a".repeat(64),
        warning_ack_reason: "Synthetic acknowledgement",
        warning_ack_at: request.received_at,
        warning_ack_by: "qa",
      });
      for (const [index, status] of ["processing", "ready", "failed"].entries())
        await insert("trace_export_runs", {
          ...run,
          id: randomUUID(),
          revision: index + 2,
          idempotency_key: randomUUID(),
          status,
          mode: "export_ready",
          input_snapshot: { selectionKind: "nonempty" },
          input_digest: "a".repeat(64),
          completed_at: status === "processing" ? null : request.received_at,
          failure_code: status === "failed" ? "synthetic_failure" : null,
          export_ready: status === "ready",
        });
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
