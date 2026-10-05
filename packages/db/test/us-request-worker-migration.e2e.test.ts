import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US worker additive migration in owned child databases", () => {
  it("preserves exact queued v1/v2 facts and refuses frozen rewrites after upgrade", async () => {
    if (!url) throw new Error("Missing isolated US test URL");
    const f = await createUsProfileTestDatabase(url, 139);
    try {
      const tenant = randomUUID(),
        request = randomUUID();
      await f.pool.query(
        "INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic',$1,now())",
        [tenant],
      );
      await f.pool.query(
        "INSERT INTO trace_requests(id,tenant_id,request_number,requester_name,received_at,due_at,created_by) VALUES($1,$2,'R','Synthetic',now(),now()+interval '24 hours','qa')",
        [request, tenant],
      );
      const ids = [randomUUID(), randomUUID()];
      for (const [i, id] of ids.entries())
        await f.pool.query(
          "INSERT INTO trace_export_runs(id,tenant_id,request_id,revision,mode,status,created_by,idempotency_key,command_digest,scoped_content_digest,input_snapshot,started_at,attempt_count) VALUES($1,$2,$3,$4,'available_records_incomplete','queued','qa',$5,$6,$6,$7,now(),$4)",
          [
            id,
            tenant,
            request,
            i + 1,
            randomUUID(),
            "a".repeat(64),
            JSON.stringify({ schemaVersion: i + 1, selectionKind: "empty", saved: "  Exact Ä  " }),
          ],
        );
      const snapshot = async () =>
        (
          await f.pool.query("SELECT to_jsonb(t) AS row FROM trace_export_runs t ORDER BY revision")
        ).rows.map((r: { row: Record<string, unknown> }) => r.row);
      const before = await snapshot();
      await migrate(f.db, { migrationsFolder: resolve("../../packages/db/migrations") });
      const after = await snapshot();
      for (const [i, row] of after.entries()) {
        expect(Object.fromEntries(Object.keys(before[i] ?? {}).map((k) => [k, row[k]]))).toEqual(
          before[i],
        );
        expect(row).toMatchObject({
          lifecycle_version: 0,
          retry_cycle: 1,
          cycle_attempt_count: 0,
          next_attempt_at: null,
          lease_attempt_id: null,
          lease_token: null,
          lease_expires_at: null,
          attempt_deadline_at: null,
        });
      }
      for (const table of [
        "trace_export_attempts",
        "trace_export_render_checkpoints",
        "trace_export_object_intents",
        "trace_export_retry_receipts",
      ])
        expect((await f.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([
          { n: 0 },
        ]);
      for (const mutation of [
        "input_snapshot='{}'::jsonb",
        "created_by='other'",
        "command_digest=repeat('b',64)",
        "started_at=now()+interval '1 hour'",
        "attempt_count=0",
      ])
        await expect(
          f.pool.query(`UPDATE trace_export_runs SET ${mutation} WHERE id=$1`, [ids[0]]),
        ).rejects.toMatchObject({ code: "23514" });
      await expect(
        f.pool.query("DELETE FROM trace_export_runs WHERE id=$1", [ids[0]]),
      ).rejects.toMatchObject({ code: "23514" });
      await f.pool.query("UPDATE trace_export_runs SET input_snapshot=input_snapshot WHERE id=$1", [
        ids[0],
      ]);
      expect(await snapshot()).toEqual(after);
    } finally {
      await f.close();
    }
  }, 60_000);

  it("enforces tenant/fence ownership, write-once checkpoint and permanent object fences", async () => {
    if (!url) throw new Error("Missing isolated US test URL");
    const f = await createUsProfileTestDatabase(url);
    try {
      const tenant = randomUUID(),
        foreign = randomUUID(),
        request = randomUUID(),
        run = randomUUID(),
        attempt = randomUUID(),
        token = randomUUID();
      for (const id of [tenant, foreign])
        await f.pool.query(
          "INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic',$1,now())",
          [id],
        );
      await f.pool.query(
        "INSERT INTO trace_requests(id,tenant_id,request_number,requester_name,received_at,due_at,created_by) VALUES($1,$2,'R','Synthetic',now(),now()+interval '24 hours','qa')",
        [request, tenant],
      );
      await f.pool.query(
        "INSERT INTO trace_export_runs(id,tenant_id,request_id,revision,mode,status,created_by,idempotency_key,command_digest,scoped_content_digest,input_snapshot,started_at) VALUES($1,$2,$3,1,'available_records_incomplete','queued','qa',$4,$5,$5,'{\"selectionKind\":\"empty\"}',now())",
        [run, tenant, request, randomUUID(), "a".repeat(64)],
      );
      const insertAttempt = (t = tenant, n = 1) =>
        f.pool.query(
          "INSERT INTO trace_export_attempts(id,tenant_id,run_id,attempt_number,cycle,token,status,started_at,lease_expires_at,deadline_at) VALUES($1,$2,$3,$4,1,$5,'active',now(),now()+interval '120 seconds',now()+interval '300 seconds')",
          [randomUUID(), t, run, n, randomUUID()],
        );
      await expect(insertAttempt(foreign)).rejects.toMatchObject({ code: "23503" });
      await f.pool.query(
        "INSERT INTO trace_export_attempts(id,tenant_id,run_id,attempt_number,cycle,token,status,started_at,lease_expires_at,deadline_at) VALUES($1,$2,$3,1,1,$4,'active',now(),now()+interval '120 seconds',now()+interval '300 seconds')",
        [attempt, tenant, run, token],
      );
      await expect(insertAttempt()).rejects.toMatchObject({ code: "23505" });
      await expect(insertAttempt(tenant, 0)).rejects.toMatchObject({ code: "23514" });
      await expect(
        f.pool.query(
          "UPDATE trace_export_runs SET status='processing',attempt_count=1,cycle_attempt_count=1,lease_attempt_id=$2,lease_token=$3,lease_expires_at=now()+interval '120 seconds',attempt_deadline_at=now()+interval '300 seconds' WHERE id=$1",
          [run, attempt, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await f.pool.query(
        "INSERT INTO trace_export_render_checkpoints(tenant_id,run_id,attempt_id,model,model_digest,execution_digest,package_version,report_version) VALUES($1,$2,$3,'{}',$4,$4,'us-request-package-v1','us-request-report-pdf-v1')",
        [tenant, run, attempt, "a".repeat(64)],
      );
      await expect(
        f.pool.query("UPDATE trace_export_render_checkpoints SET tenant_id=$2 WHERE run_id=$1", [
          run,
          foreign,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        f.pool.query(
          "INSERT INTO trace_export_render_checkpoints(tenant_id,run_id,attempt_id,model,model_digest,execution_digest,package_version,report_version) VALUES($1,$2,$3,'{}',$4,$4,'us-request-package-v1','us-request-report-pdf-v1')",
          [foreign, randomUUID(), attempt, "a".repeat(64)],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        f.pool.query(
          "UPDATE trace_export_render_checkpoints SET model='{\"changed\":true}' WHERE run_id=$1",
          [run],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await f.pool.query(
        "UPDATE trace_export_render_checkpoints SET package_expectation='{}' WHERE run_id=$1",
        [run],
      );
      await expect(
        f.pool.query("DELETE FROM trace_export_render_checkpoints WHERE run_id=$1", [run]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        f.pool.query(
          "UPDATE trace_export_render_checkpoints SET package_expectation=NULL WHERE run_id=$1",
          [run],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      const intent = randomUUID(),
        key = `us/requests/${tenant}/${run}/${attempt}/manifest.json`;
      await f.pool.query(
        "INSERT INTO trace_export_object_intents(id,tenant_id,run_id,attempt_id,name,kind,object_key,media_type,byte_size,sha256,state) VALUES($1,$2,$3,$4,'manifest.json','manifest',$5,'application/json',10,$6,'allocated')",
        [intent, tenant, run, attempt, key, "a".repeat(64)],
      );
      await expect(
        f.pool.query("UPDATE trace_export_object_intents SET state='unknown' WHERE id=$1", [
          intent,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await f.pool.query(
        "UPDATE trace_export_object_intents SET state='fenced',fenced_at=now() WHERE id=$1",
        [intent],
      );
      await expect(
        f.pool.query(
          "UPDATE trace_export_object_intents SET state='verified',verified_at=now(),fenced_at=NULL WHERE id=$1",
          [intent],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        f.pool.query("DELETE FROM trace_export_object_intents WHERE id=$1", [intent]),
      ).rejects.toMatchObject({ code: "23514" });
      await f.pool.query(
        "INSERT INTO trace_export_artifacts(tenant_id,run_id,kind,filename,media_type,byte_size,sha256,object_key,published_at) VALUES($1,$2,'manifest','manifest.json','application/json',10,$3,$4,now())",
        [tenant, run, "a".repeat(64), key],
      );
      for (const command of [
        "UPDATE trace_export_artifacts SET byte_size=11",
        "DELETE FROM trace_export_artifacts",
      ])
        await expect(f.pool.query(command)).rejects.toMatchObject({ code: "23514" });
      const receipt = () =>
        f.pool.query(
          "INSERT INTO trace_export_retry_receipts(tenant_id,run_id,actor_id,idempotency_key,command_digest,reason,expected_lifecycle_version,cycle,lifecycle_version,created_at) VALUES($1,$2,'qa',$3,$4,'Synthetic retry',0,2,1,now())",
          [tenant, run, token, "a".repeat(64)],
        );
      await receipt();
      await expect(receipt()).rejects.toMatchObject({ code: "23505" });
    } finally {
      await f.close();
    }
  }, 60_000);
});
