import { randomUUID } from "node:crypto";
import type { ReceivingDraft } from "@markiro/platform-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { bumpReceivingBasisVersions } from "../src/modules/traceability/receiving/us-receiving-roots";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving, seedExemptReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("receiving basis version compatibility", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsReceivingStore;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing synthetic database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsReceivingStore(fixture.db);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    c = await seedCompleteReceiving(fixture.db);
  });

  async function ready(draft: ReceivingDraft = c.draft) {
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft },
      "create",
    );
    const readiness = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: saved.draftVersion,
    });
    expect(readiness.state).toBe("complete");
    return {
      saved,
      command: {
        operationKey: randomUUID(),
        expectedDraftVersion: saved.draftVersion,
        expectedInputDigest: readiness.inputDigest,
        reviewedExemptLines: readiness.exemptReviewRequiredLines,
      },
    };
  }
  async function lots() {
    return (
      await fixture.pool.query<{ id: string; version: number; business: string }>(
        "SELECT id,to_jsonb(l)->'receiving_basis_version' AS version,(to_jsonb(l)-'receiving_basis_version')::text AS business FROM traceability_lots l WHERE tenant_id=$1 ORDER BY id",
        [c.tenant],
      )
    ).rows;
  }
  async function artifacts() {
    return (
      await fixture.pool.query(
        `SELECT 'receipt' AS kind,to_jsonb(o)::text AS exact FROM receiving_operations o WHERE tenant_id=$1
       UNION ALL SELECT 'audit',to_jsonb(a)::text FROM tenant_audit_events a WHERE organization_id=$1 ORDER BY kind,exact`,
        [c.tenant],
      )
    ).rows;
  }
  it.each([false, true])(
    "bumps created and linked lots exactly once; replay stays byte-exact (own assignment=%s)",
    async (own) => {
      if (own) c = await seedExemptReceiving(fixture.db);
      const { saved, command } = await ready();
      expect((await lots()).map((row) => row.version)).toEqual([1]);
      const result = await store.finalize(c.tenant, c.actor, saved.id, command, "confirm");
      expect(result.snapshot.snapshotVersion).toBe(2);
      const after = await lots();
      expect(after.map((row) => row.version)).toEqual([2, 2]);
      const history = await artifacts();
      expect(await store.finalize(c.tenant, c.actor, saved.id, command, "replay")).toEqual(result);
      expect(await lots()).toEqual(after);
      expect(await artifacts()).toEqual(history);
      expect(JSON.stringify({ result, history })).not.toMatch(
        /receivingBasisVersion|receiving_basis_version/,
      );
    },
  );

  it("an independent receipt updates the token, not the already-latched lot's business fields", async () => {
    const initial = await ready();
    await store.finalize(c.tenant, c.actor, initial.saved.id, initial.command, "first");
    const before = await lots();
    const linked = c.draft.items.filter((line) => line.lotId === c.lot);
    expect(linked).toHaveLength(1);
    const next = await ready({ ...c.draft, items: linked });
    await store.finalize(c.tenant, c.actor, next.saved.id, next.command, "second");
    const after = await lots();
    expect(after.find((row) => row.id === c.lot)).toEqual({
      ...before.find((row) => row.id === c.lot),
      version: 3,
    });
    expect(after.find((row) => row.id !== c.lot)).toEqual(before.find((row) => row.id !== c.lot));
    const audits = await fixture.pool.query(
      "SELECT action,actor_user_id,target_type,target_id,outcome FROM tenant_audit_events WHERE organization_id=$1 AND request_id='second'",
      [c.tenant],
    );
    expect(audits.rows).toEqual([
      {
        action: "traceability.receiving.finalized",
        actor_user_id: c.actor,
        target_type: "traceability_event",
        target_id: next.saved.id,
        outcome: "success",
      },
    ]);
  });

  it("keeps the current readiness v3 digest independent of the internal support token", async () => {
    const { saved, command } = await ready();
    await fixture.pool.query(
      "UPDATE traceability_lots SET receiving_basis_version=receiving_basis_version+1 WHERE tenant_id=$1 AND id=$2",
      [c.tenant, c.lot],
    );
    const checked = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(checked.ruleVersion).toBe("receiving-readiness-v3");
    expect(checked.inputDigest).toBe(command.expectedInputDigest);
    expect(
      (await store.finalize(c.tenant, c.actor, saved.id, command, "confirm")).snapshot
        .snapshotVersion,
    ).toBe(2);
  });

  it("rolls back the counter, lots, source latch and receipt together when finalization audit fails", async () => {
    const { saved, command } = await ready();
    const before = await lots();
    const history = await artifacts();
    await fixture.pool.query(
      "CREATE FUNCTION synthetic_basis_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='traceability.receiving.finalized' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_basis_fail_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_basis_fail_audit()",
    );
    try {
      await expect(
        store.finalize(c.tenant, c.actor, saved.id, command, "fail"),
      ).rejects.toBeDefined();
    } finally {
      await fixture.pool.query(
        "DROP TRIGGER synthetic_basis_fail_audit ON tenant_audit_events; DROP FUNCTION synthetic_basis_fail_audit()",
      );
    }
    expect(await lots()).toEqual(before);
    expect(await artifacts()).toEqual(history);
    expect(await store.getDraft(c.tenant, c.actor, saved.id)).toEqual(saved);
    await store.finalize(c.tenant, c.actor, saved.id, command, "retry");
    expect((await lots()).map((row) => row.version)).toEqual([2, 2]);
  });

  it("aborts without business effects if an affected counter is exhausted", async () => {
    await fixture.pool.query(
      "UPDATE traceability_lots SET receiving_basis_version=2147483647 WHERE tenant_id=$1 AND id=$2",
      [c.tenant, c.lot],
    );
    const { saved, command } = await ready();
    const before = await lots();
    const history = await artifacts();
    await expect(
      store.finalize(c.tenant, c.actor, saved.id, command, "exhausted"),
    ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
    expect(await lots()).toEqual(before);
    expect(await artifacts()).toEqual(history);
    expect(await store.getDraft(c.tenant, c.actor, saved.id)).toEqual(saved);
  });

  it("deduplicates UUID identity and leaves unrelated lots untouched", async () => {
    const foreign = await seedCompleteReceiving(fixture.db);
    const otherBefore = await fixture.pool.query(
      "SELECT to_jsonb(l)::text AS exact FROM traceability_lots l WHERE tenant_id=$1",
      [foreign.tenant],
    );
    const before = await lots();
    await fixture.db.transaction((tx) => bumpReceivingBasisVersions(tx, c.tenant, []));
    expect(await lots()).toEqual(before);
    await fixture.db.transaction((tx) =>
      bumpReceivingBasisVersions(tx, c.tenant, [c.lot, c.lot.toUpperCase(), c.lot]),
    );
    expect(await lots()).toEqual(before.map((row) => ({ ...row, version: 2 })));
    expect(
      (
        await fixture.pool.query(
          "SELECT to_jsonb(l)::text AS exact FROM traceability_lots l WHERE tenant_id=$1",
          [foreign.tenant],
        )
      ).rows,
    ).toEqual(otherBefore.rows);
  });

  it.each(["missing", "foreign"] as const)(
    "fails closed and rolls back the complete batch for a %s lot",
    async (kind) => {
      const foreign = await seedCompleteReceiving(fixture.db);
      const target = kind === "missing" ? randomUUID() : foreign.lot;
      const before = await fixture.pool.query(
        "SELECT to_jsonb(l)::text AS exact FROM traceability_lots l ORDER BY id",
      );
      await expect(
        fixture.db.transaction((tx) => bumpReceivingBasisVersions(tx, c.tenant, [c.lot, target])),
      ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
      expect(
        (
          await fixture.pool.query(
            "SELECT to_jsonb(l)::text AS exact FROM traceability_lots l ORDER BY id",
          )
        ).rows,
      ).toEqual(before.rows);
    },
  );

  it("preserves recalled-lot identity, reasons, revision, timestamps and irreversible source latch", async () => {
    await fixture.pool.query(
      "UPDATE traceability_lots SET status='recalled',revision=7,source_locked_at=now(),last_status_reason='  exact status reason  ',last_source_reason='  exact source reason  ' WHERE tenant_id=$1 AND id=$2",
      [c.tenant, c.lot],
    );
    const before = await lots();
    await fixture.db.transaction((tx) => bumpReceivingBasisVersions(tx, c.tenant, [c.lot]));
    expect(await lots()).toEqual(before.map((row) => ({ ...row, version: 2 })));
  });

  it("invalidates an older repeatable-read snapshot through a tuple update, not just a lock", async () => {
    const reader = await fixture.pool.connect();
    try {
      await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const before = await reader.query(
        "SELECT receiving_basis_version FROM traceability_lots WHERE tenant_id=$1 AND id=$2",
        [c.tenant, c.lot],
      );
      expect(before.rows).toEqual([{ receiving_basis_version: 1 }]);
      await fixture.db.transaction((tx) => bumpReceivingBasisVersions(tx, c.tenant, [c.lot]));
      await expect(
        reader.query("SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
          c.tenant,
          c.lot,
        ]),
      ).rejects.toMatchObject({ code: "40001" });
    } finally {
      await reader.query("ROLLBACK");
      reader.release();
    }
    expect((await lots()).map((row) => row.version)).toEqual([2]);
  });

  it("rolls back earlier increments in the same batch when a later version is exhausted", async () => {
    const other = randomUUID();
    await fixture.pool.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,created_by,updated_by) VALUES ($1,$2,$3,'BATCH','imported',$4,$4)",
      [other, c.tenant, c.product, c.actor],
    );
    const ids = [other, c.lot].sort();
    await fixture.pool.query(
      "UPDATE traceability_lots SET receiving_basis_version=2147483647 WHERE tenant_id=$1 AND id=$2",
      [c.tenant, ids[1]],
    );
    const before = await lots();
    await expect(
      fixture.db.transaction((tx) => bumpReceivingBasisVersions(tx, c.tenant, ids)),
    ).rejects.toMatchObject({ status: 503 });
    expect(await lots()).toEqual(before);
  });
});
