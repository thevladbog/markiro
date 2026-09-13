// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { recordProductLabelAcceptance } from "../src/lib/product-labels/acceptance.js";
import {
  hasUnresolvedProductLabelJob,
  presentProductLabelJob,
  readProductLabelJob,
} from "../src/lib/product-labels/store.js";
import { makeRotatingExec, openFileDatabase } from "./support/sqlite-exec.js";
import {
  markFixtureSent,
  productLabelAcceptanceFixture,
  seedProductLabelShift,
} from "./support/product-labels.js";

async function acceptFixture(
  exec: SqlExecutor,
  input: Parameters<typeof recordProductLabelAcceptance>[1],
) {
  await seedProductLabelShift(exec, input);
  return recordProductLabelAcceptance(exec, input);
}

const tables = [
  "product_label_accept_commands",
  "codes_mirror",
  "scan_events_mirror",
  "outbox",
  "product_label_jobs",
  "product_label_attempts",
  "product_label_events",
  "product_label_outbox",
] as const;

describe("atomic product label acceptance", () => {
  let folder: string;
  let databases: DatabaseSync[];
  let exec: SqlExecutor;
  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), "markiro-product-labels-"));
    const path = join(folder, "station.sqlite");
    databases = [openFileDatabase(path), openFileDatabase(path)];
    exec = makeRotatingExec(databases);
    await applyMigrations(exec);
  });
  afterEach(() => {
    for (const db of databases) db.close();
    rmSync(folder, { recursive: true, force: true });
  });
  async function counts(): Promise<number[]> {
    const result: number[] = [];
    for (const table of tables)
      result.push(
        (await exec.all<{ count: number }>(`SELECT count(*) AS count FROM ${table}`))[0]?.count ??
          -1,
      );
    return result;
  }

  it("accepts one closed-source repeat atomically and preserves original identity", async () => {
    const input = productLabelAcceptanceFixture({
      allowPreviouslyAcceptedCodes: true,
      verification: "none",
    });
    await seedProductLabelShift(exec, input);
    const source = randomUUID();
    await exec.run(
      "INSERT INTO codes_mirror(code_hash,shift_id,gtin14,serial,scanned_at) VALUES(?,?,?,?,?)",
      [input.codeHash, source, input.gtin14, input.serial, "2026-09-01T00:00:00.000Z"],
    );
    await exec.run(
      "INSERT INTO validation_code_history(shift_id,code_hash,kind,source_shift_id,shift_number,shift_status,scanned_at) VALUES(?,?,'original',?,'OLD-1','closed',?)",
      [input.shiftId, input.codeHash, source, "2026-09-01T00:00:00.000Z"],
    );
    expect(await recordProductLabelAcceptance(exec, input)).toEqual({
      status: "accepted",
      jobId: input.jobId,
    });
    expect(await exec.all("SELECT shift_id FROM codes_mirror")).toEqual([{ shift_id: source }]);
    expect(
      await exec.all("SELECT shift_id,source_shift_id,outcome FROM validation_occurrences"),
    ).toEqual([{ shift_id: input.shiftId, source_shift_id: source, outcome: "pending" }]);
    await markFixtureSent(exec, input);
    const next = {
      ...input,
      jobId: randomUUID(),
      preparedEvent: {
        ...input.preparedEvent,
        jobId: "",
        eventId: randomUUID(),
        attemptId: randomUUID(),
      },
    };
    next.preparedEvent.jobId = next.jobId;
    expect(await recordProductLabelAcceptance(exec, next)).toEqual({ status: "duplicate" });
    expect((await exec.all("SELECT * FROM product_label_jobs")).length).toBe(1);
  });

  it.each([false, true])(
    "refuses an active processing entry without an original owner (flag %s)",
    async (allowPreviouslyAcceptedCodes) => {
      const input = productLabelAcceptanceFixture({ allowPreviouslyAcceptedCodes });
      await seedProductLabelShift(exec, input);
      await exec.run(
        "INSERT INTO validation_code_history(shift_id,code_hash,kind,source_shift_id,shift_number,shift_status,scanned_at) VALUES(?,?,'reprocessing',?,'ACTIVE-1','active',?)",
        [input.shiftId, input.codeHash, randomUUID(), input.acceptedAt],
      );
      expect(await recordProductLabelAcceptance(exec, input)).toEqual({ status: "duplicate" });
      expect((await exec.all("SELECT * FROM product_label_jobs")).length).toBe(0);
    },
  );

  it("refuses a known local source without server-confirmed closed history", async () => {
    const input = productLabelAcceptanceFixture({ allowPreviouslyAcceptedCodes: true });
    await seedProductLabelShift(exec, input);
    await exec.run(
      "INSERT INTO codes_mirror(code_hash,shift_id,gtin14,serial,scanned_at) VALUES(?,?,?,?,?)",
      [input.codeHash, randomUUID(), input.gtin14, input.serial, input.acceptedAt],
    );
    expect(await recordProductLabelAcceptance(exec, input)).toEqual({ status: "duplicate" });
    expect((await exec.all("SELECT * FROM product_label_jobs")).length).toBe(0);
  });

  it("blocks a locally retained active occurrence missing from stale downloaded history", async () => {
    const input = productLabelAcceptanceFixture({ allowPreviouslyAcceptedCodes: true });
    await seedProductLabelShift(exec, input);
    await exec.run(
      "INSERT INTO validation_occurrences(shift_id,code_hash,scanned_at,credential_ownership,terminal_id,canonical_raw,outcome) VALUES(?,?,?,?,?,?,'reprocessed')",
      [
        randomUUID(),
        input.codeHash,
        input.acceptedAt,
        input.credentialOwnership,
        input.terminalId,
        input.canonicalRaw,
      ],
    );
    expect(await recordProductLabelAcceptance(exec, input)).toEqual({ status: "duplicate" });
    expect(await exec.all("SELECT * FROM product_label_jobs")).toHaveLength(0);
  });

  it("refuses a closed historical code under false even without a local registry row", async () => {
    const input = productLabelAcceptanceFixture();
    await seedProductLabelShift(exec, input);
    await exec.run(
      "INSERT INTO validation_code_history(shift_id,code_hash,kind,source_shift_id,shift_number,shift_status,scanned_at) VALUES(?,?,'original',?,'OLD','closed',?)",
      [input.shiftId, input.codeHash, randomUUID(), input.acceptedAt],
    );
    expect(await recordProductLabelAcceptance(exec, input)).toEqual({ status: "duplicate" });
    expect(await exec.all("SELECT * FROM product_label_jobs")).toHaveLength(0);
  });

  it("atomically keeps full data, attribution, print bytes and one acceptance; retries are stable", async () => {
    const input = productLabelAcceptanceFixture();
    expect(await acceptFixture(exec, input)).toEqual({
      status: "accepted",
      jobId: input.jobId,
    });
    expect(await acceptFixture(exec, input)).toEqual({
      status: "accepted",
      jobId: input.jobId,
    });
    expect(await counts()).toEqual(tables.map(() => 1));
    const [scan] = await exec.all(
      "SELECT shift_id,terminal_id,raw,verdict,scanned_at,operator_id FROM scan_events_mirror",
    );
    expect(scan).toEqual({
      shift_id: input.shiftId,
      terminal_id: input.terminalId,
      raw: input.raw,
      verdict: "ok",
      scanned_at: input.acceptedAt,
      operator_id: input.operatorId,
    });
    const [queued] = await exec.all(
      "SELECT code_hash,gtin14,serial,box_id,operator_id,verdict,raw FROM outbox",
    );
    expect(queued).toEqual({
      code_hash: input.codeHash,
      gtin14: input.gtin14,
      serial: input.serial,
      box_id: null,
      operator_id: input.operatorId,
      verdict: "ok",
      raw: input.raw,
    });
    const stored = await readProductLabelJob(exec, input.credentialOwnership, input.jobId);
    expect(stored).toEqual({
      ...input,
      ownershipConflict: false,
      updatedAt: input.acceptedAt,
      projection: expect.objectContaining({
        status: "prepared",
        verification: "required",
        verificationOutcome: "pending",
        latestSequence: 1,
      }),
      attempts: [
        { prepared: input.preparedEvent, state: "prepared", verifiedAt: null, verifiedBy: null },
      ],
    });
    expect(await readProductLabelJob(exec, "other-owner", input.jobId)).toBeNull();
    expect(await hasUnresolvedProductLabelJob(exec, input.credentialOwnership)).toBe(true);
    expect(await hasUnresolvedProductLabelJob(exec, input.credentialOwnership, randomUUID())).toBe(
      false,
    );
    expect(await hasUnresolvedProductLabelJob(exec, "other-owner")).toBe(false);
    if (!stored) throw new Error("Missing accepted job");
    const view = presentProductLabelJob(stored);
    expect(view.codeSuffix).toBe("IAL-42");
    expect(Object.keys(view).sort()).toEqual(
      [
        "jobId",
        "shiftId",
        "codeSuffix",
        "attemptId",
        "attemptNo",
        "attemptState",
        "language",
        "dpi",
        "status",
        "verification",
        "verificationOutcome",
        "ownershipConflict",
        "acceptedAt",
        "updatedAt",
      ].sort(),
    );
    expect(JSON.stringify(view)).not.toContain("Crypto");
  });

  it("restores the complete job after migration replay and connection restart", async () => {
    const input = productLabelAcceptanceFixture();
    await acceptFixture(exec, input);
    for (const db of databases) db.close();
    databases = [
      openFileDatabase(join(folder, "station.sqlite")),
      openFileDatabase(join(folder, "station.sqlite")),
    ];
    exec = makeRotatingExec(databases);
    await applyMigrations(exec);
    expect(await readProductLabelJob(exec, input.credentialOwnership, input.jobId)).toMatchObject(
      input,
    );
    expect(await counts()).toEqual(tables.map(() => 1));
  });

  it("blocks another unit across shifts while this owner has an unresolved job", async () => {
    const first = productLabelAcceptanceFixture();
    await acceptFixture(exec, first);
    expect(await acceptFixture(exec, productLabelAcceptanceFixture({ serial: "NEXT" }))).toEqual({
      status: "busy",
    });
    expect(await counts()).toEqual(tables.map(() => 1));
    const other = productLabelAcceptanceFixture({
      serial: "OTHER",
      ownership: "credential-generation-b",
    });
    expect(await acceptFixture(exec, other)).toEqual({
      status: "accepted",
      jobId: other.jobId,
    });
  });

  it("serializes concurrent acceptance so exactly one unit wins the owner slot", async () => {
    const results = await Promise.all([
      acceptFixture(exec, productLabelAcceptanceFixture()),
      acceptFixture(exec, productLabelAcceptanceFixture({ serial: "NEXT" })),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["accepted", "busy"]);
    expect(await counts()).toEqual(tables.map(() => 1));
  });

  it("records a duplicate scan after completion without another accepted unit or print job", async () => {
    const input = productLabelAcceptanceFixture({ verification: "none" });
    await acceptFixture(exec, input);
    await markFixtureSent(exec, input);
    expect(await hasUnresolvedProductLabelJob(exec, input.credentialOwnership)).toBe(false);
    expect(await acceptFixture(exec, productLabelAcceptanceFixture())).toEqual({
      status: "duplicate",
    });
    expect(await counts()).toEqual([1, 1, 2, 2, 1, 1, 3, 1]);
    expect(await exec.all("SELECT verdict,code_hash FROM outbox ORDER BY id")).toEqual([
      { verdict: "ok", code_hash: input.codeHash },
      { verdict: "duplicate", code_hash: null },
    ]);
  });

  it("rejects reused job identity with changed immutable content", async () => {
    const input = productLabelAcceptanceFixture();
    await acceptFixture(exec, input);
    await expect(
      acceptFixture(exec, {
        ...input,
        fields: { ...input.fields, date: "09.09.2026" },
      }),
    ).rejects.toMatchObject({ code: "PRODUCT_LABEL_ACCEPTANCE_ID_CONFLICT" });
    expect(await counts()).toEqual(tables.map(() => 1));
    expect(
      (await readProductLabelJob(exec, input.credentialOwnership, input.jobId))?.fields.date,
    ).toBe("08.09.2026");
  });

  it("retries a lost reply after commit without another acceptance or print event", async () => {
    const input = productLabelAcceptanceFixture();
    let loseReply = true;
    const dropping = makeRotatingExec(databases, {
      afterRun(sql) {
        if (loseReply && sql.includes("INSERT INTO product_label_accept_commands")) {
          loseReply = false;
          throw new Error("TEST_REPLY_LOST");
        }
      },
    });
    await expect(acceptFixture(dropping, input)).rejects.toThrow("TEST_REPLY_LOST");
    expect(await acceptFixture(exec, input)).toEqual({
      status: "accepted",
      jobId: input.jobId,
    });
    expect(await counts()).toEqual(tables.map(() => 1));
  });

  it.each(tables)("rolls back every write when %s fails", async (table) => {
    await exec.run(
      `CREATE TRIGGER test_product_label_fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'TEST_DISK_FAILURE'); END;`,
    );
    await expect(acceptFixture(exec, productLabelAcceptanceFixture())).rejects.toThrow(
      "TEST_DISK_FAILURE",
    );
    expect(await counts()).toEqual(tables.map(() => 0));
  });

  it("does not mistake another table's unique failure for a duplicate code", async () => {
    await exec.run(
      "CREATE TRIGGER test_product_label_fault BEFORE INSERT ON product_label_events BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: unrelated.id'); END;",
    );
    await expect(acceptFixture(exec, productLabelAcceptanceFixture())).rejects.toThrow(
      "unrelated.id",
    );
    expect(await counts()).toEqual(tables.map(() => 0));
  });

  it("keeps accepted unit facts when the isolated print context is removed", async () => {
    const input = productLabelAcceptanceFixture({ verification: "none" });
    await acceptFixture(exec, input);
    await markFixtureSent(exec, input);
    // Exercise FK behavior only. Production retention additionally requires all receipts in task 15.
    await exec.run(
      "DELETE FROM product_label_accept_commands WHERE credential_ownership=? AND job_id=?",
      [input.credentialOwnership, input.jobId],
    );
    expect(await counts()).toEqual([0, 1, 1, 1, 0, 0, 0, 0]);
  });

  it("detects a damaged persisted projection instead of exposing a completed unit", async () => {
    const input = productLabelAcceptanceFixture();
    await acceptFixture(exec, input);
    await exec.run(
      "UPDATE product_label_jobs SET status='completed',projection_json=json_set(projection_json,'$.status','completed') WHERE job_id=?",
      [input.jobId],
    );
    await expect(
      readProductLabelJob(exec, input.credentialOwnership, input.jobId),
    ).rejects.toMatchObject({ code: "PRODUCT_LABEL_STORAGE_INVALID" });
  });

  it("detects changed printer bytes in the saved acceptance context", async () => {
    const input = productLabelAcceptanceFixture();
    await acceptFixture(exec, input);
    await exec.run(
      "UPDATE product_label_accept_commands SET acceptance_json=json_set(acceptance_json,'$.bytesBase64',?) WHERE job_id=?",
      [Buffer.from("ALTERED").toString("base64"), input.jobId],
    );
    await expect(
      readProductLabelJob(exec, input.credentialOwnership, input.jobId),
    ).rejects.toMatchObject({ code: "PRODUCT_LABEL_ACCEPTANCE_INVALID" });
  });

  it("accepts a prepared resolution that differs from the template's authoring dpi", async () => {
    const input = productLabelAcceptanceFixture();
    // The template snapshot is authored at 203 dpi; the printer is 300.
    const prepared = { ...input, preparedEvent: { ...input.preparedEvent, dpi: 300 as const } };
    await expect(acceptFixture(exec, prepared)).resolves.toEqual({
      status: "accepted",
      jobId: input.jobId,
    });
    const stored = await readProductLabelJob(exec, input.credentialOwnership, input.jobId);
    expect(stored?.policy.snapshot.spec.dpi).toBe(203);
    expect(stored?.projection.dpi).toBe(300);
  });

  it.each(["codeHash", "canonicalRaw", "bytesBase64", "credentialOwnership"] as const)(
    "rejects corrupt acceptance %s before any write",
    async (field) => {
      const input = productLabelAcceptanceFixture();
      await expect(acceptFixture(exec, { ...input, [field]: "" })).rejects.toThrow();
      expect(await counts()).toEqual(tables.map(() => 0));
    },
  );
});
