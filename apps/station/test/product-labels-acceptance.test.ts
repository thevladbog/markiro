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
import { markFixtureSent, productLabelAcceptanceFixture } from "./support/product-labels.js";

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

  it("atomically keeps full data, attribution, print bytes and one acceptance; retries are stable", async () => {
    const input = productLabelAcceptanceFixture();
    expect(await recordProductLabelAcceptance(exec, input)).toEqual({
      status: "accepted",
      jobId: input.jobId,
    });
    expect(await recordProductLabelAcceptance(exec, input)).toEqual({
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
    await recordProductLabelAcceptance(exec, input);
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
    await recordProductLabelAcceptance(exec, first);
    expect(
      await recordProductLabelAcceptance(exec, productLabelAcceptanceFixture({ serial: "NEXT" })),
    ).toEqual({ status: "busy" });
    expect(await counts()).toEqual(tables.map(() => 1));
    const other = productLabelAcceptanceFixture({
      serial: "OTHER",
      ownership: "credential-generation-b",
    });
    expect(await recordProductLabelAcceptance(exec, other)).toEqual({
      status: "accepted",
      jobId: other.jobId,
    });
  });

  it("serializes concurrent acceptance so exactly one unit wins the owner slot", async () => {
    const results = await Promise.all([
      recordProductLabelAcceptance(exec, productLabelAcceptanceFixture()),
      recordProductLabelAcceptance(exec, productLabelAcceptanceFixture({ serial: "NEXT" })),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["accepted", "busy"]);
    expect(await counts()).toEqual(tables.map(() => 1));
  });

  it("records a duplicate scan after completion without another accepted unit or print job", async () => {
    const input = productLabelAcceptanceFixture({ verification: "none" });
    await recordProductLabelAcceptance(exec, input);
    await markFixtureSent(exec, input);
    expect(await hasUnresolvedProductLabelJob(exec, input.credentialOwnership)).toBe(false);
    expect(await recordProductLabelAcceptance(exec, productLabelAcceptanceFixture())).toEqual({
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
    await recordProductLabelAcceptance(exec, input);
    await expect(
      recordProductLabelAcceptance(exec, {
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
    await expect(recordProductLabelAcceptance(dropping, input)).rejects.toThrow("TEST_REPLY_LOST");
    expect(await recordProductLabelAcceptance(exec, input)).toEqual({
      status: "accepted",
      jobId: input.jobId,
    });
    expect(await counts()).toEqual(tables.map(() => 1));
  });

  it.each(tables)("rolls back every write when %s fails", async (table) => {
    await exec.run(
      `CREATE TRIGGER test_product_label_fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'TEST_DISK_FAILURE'); END;`,
    );
    await expect(
      recordProductLabelAcceptance(exec, productLabelAcceptanceFixture()),
    ).rejects.toThrow("TEST_DISK_FAILURE");
    expect(await counts()).toEqual(tables.map(() => 0));
  });

  it("does not mistake another table's unique failure for a duplicate code", async () => {
    await exec.run(
      "CREATE TRIGGER test_product_label_fault BEFORE INSERT ON product_label_events BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: unrelated.id'); END;",
    );
    await expect(
      recordProductLabelAcceptance(exec, productLabelAcceptanceFixture()),
    ).rejects.toThrow("unrelated.id");
    expect(await counts()).toEqual(tables.map(() => 0));
  });

  it("keeps accepted unit facts when the isolated print context is removed", async () => {
    const input = productLabelAcceptanceFixture({ verification: "none" });
    await recordProductLabelAcceptance(exec, input);
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
    await recordProductLabelAcceptance(exec, input);
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
    await recordProductLabelAcceptance(exec, input);
    await exec.run(
      "UPDATE product_label_accept_commands SET acceptance_json=json_set(acceptance_json,'$.bytesBase64',?) WHERE job_id=?",
      [Buffer.from("ALTERED").toString("base64"), input.jobId],
    );
    await expect(
      readProductLabelJob(exec, input.credentialOwnership, input.jobId),
    ).rejects.toMatchObject({ code: "PRODUCT_LABEL_ACCEPTANCE_INVALID" });
  });

  it.each(["codeHash", "canonicalRaw", "bytesBase64", "credentialOwnership"] as const)(
    "rejects corrupt acceptance %s before any write",
    async (field) => {
      const input = productLabelAcceptanceFixture();
      await expect(recordProductLabelAcceptance(exec, { ...input, [field]: "" })).rejects.toThrow();
      expect(await counts()).toEqual(tables.map(() => 0));
    },
  );
});
