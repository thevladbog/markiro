import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BACKUP_DIR_PROBLEMS,
  BACKUP_FAILURES,
  backupSettingsUpdateSchema,
  backupStateSchema,
  KNOWN_BLOCK_CODES,
  knownBlocksRequestSchema,
  knownBlocksResponseSchema,
} from "../src/host/backups.js";
import { errorBodySchema, helloSchema } from "../src/host/protocol.js";

// Bound first: Vite rewrites a literal `new URL(…, import.meta.url)` for the
// browser, which breaks a fixture read under jsdom (`protocol.test.ts`).
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"),
  ) as unknown;
}

describe("backup shapes (proto/fixtures)", () => {
  it("read the host's states, which may grow", () => {
    const state = backupStateSchema.parse(fixture("backup-state.json"));
    expect(state.second?.lastAttempt?.code).toBe("destination_unavailable");
    expect(state.local.copies.map((copy) => copy.trigger)).toEqual(["scheduled", "manual"]);
    const running = backupStateSchema.parse(fixture("backup-state-running.json"));
    expect(running.running).toEqual({ trigger: "manual", startedAt: "2026-10-09T14:19:58Z" });
    expect(running.second).toBeNull();
    const grown = { ...(fixture("backup-state.json") as Record<string, unknown>), extra: 1 };
    expect(backupStateSchema.safeParse(grown).success).toBe(true);
  });

  it("read a host that holds the facts since a restore, and its refusal of a fact", () => {
    const held = backupStateSchema.parse(fixture("backup-state-held.json"));
    expect(held.restoreHold?.stations.map((station) => station.reconciled)).toEqual([true, false]);
    expect(backupStateSchema.parse(fixture("backup-state.json")).restoreHold).toBeNull();
    const refusal = errorBodySchema.parse(fixture("error-restore-pending.json"));
    expect(refusal.error.code).toBe("restore_pending");
    expect(refusal.error.details).toEqual({ since: "2026-10-09T15:00:00Z" });
  });

  it("send the settings strictly, with a folder or null", () => {
    expect(backupSettingsUpdateSchema.parse(fixture("backup-settings-update.json"))).toEqual({
      secondDir: "\\\\ADMIN-PC\\MarkiroCopies",
      expectedRev: 7,
    });
    expect(backupSettingsUpdateSchema.safeParse({ secondDir: null, expectedRev: 1 }).success).toBe(
      true,
    );
    expect(
      backupSettingsUpdateSchema.safeParse({ secondDir: null, expectedRev: 1, extra: true })
        .success,
    ).toBe(false);
  });

  it("read the known blocks a station sends and the host's answer", () => {
    const request = knownBlocksRequestSchema.parse(fixture("known-blocks-request.json"));
    expect(request.blocks[0]?.toSerial).toBe(5499);
    const withNext = fixture("known-blocks-request.json") as { blocks: Record<string, unknown>[] };
    withNext.blocks[0] = { ...withNext.blocks[0], nextSerial: 3600 };
    expect(knownBlocksRequestSchema.safeParse(withNext).success).toBe(false);
    const topLevel = { ...(fixture("known-blocks-request.json") as object), epoch: "5d2c8e1a" };
    expect(knownBlocksRequestSchema.safeParse(topLevel).success).toBe(false);
    // Plan ХП: a station that never took a block sends an empty list; the host takes 0-64.
    expect(
      knownBlocksRequestSchema.parse(fixture("known-blocks-request-empty.json")).blocks,
    ).toEqual([]);
    const block = request.blocks[0];
    expect(knownBlocksRequestSchema.safeParse({ blocks: Array(64).fill(block) }).success).toBe(
      true,
    );
    expect(knownBlocksRequestSchema.safeParse({ blocks: Array(65).fill(block) }).success).toBe(
      false,
    );
    const response = knownBlocksResponseSchema.parse(fixture("known-blocks-response.json"));
    expect(response.results.map((each) => each.outcome)).toEqual([
      "registered",
      "known",
      "refused",
    ]);
  });

  it("read hello with and without the restore epoch", () => {
    expect(helloSchema.parse(fixture("hello-restored.json")).restoreEpoch).toBe(
      "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e",
    );
    expect(helloSchema.parse(fixture("hello.json")).restoreEpoch).toBeUndefined();
    const garbled = { ...(fixture("hello-restored.json") as object), restoreEpoch: "epoch-1" };
    expect(helloSchema.safeParse(garbled).success).toBe(false);
  });

  it("send only blocks that are a block: a digit extension, non-negative serials", () => {
    const block = (fixture("known-blocks-request.json") as { blocks: Record<string, unknown>[] })
      .blocks[0];
    const accepts = (change: Record<string, unknown>) =>
      knownBlocksRequestSchema.safeParse({ blocks: [{ ...block, ...change }] }).success;
    expect(accepts({})).toBe(true);
    expect(accepts({ extension: 9 })).toBe(true);
    expect(accepts({ extension: 10 })).toBe(false);
    expect(accepts({ extension: -1 })).toBe(false);
    expect(accepts({ fromSerial: -1 })).toBe(false);
    expect(accepts({ toSerial: 1.5 })).toBe(false);
    expect(accepts({ id: "block-1" })).toBe(false);
  });

  it("list exactly the host's codes (proto/fixtures/backup-codes.json)", () => {
    const codes = fixture("backup-codes.json") as Record<string, string[]>;
    expect([...BACKUP_FAILURES]).toEqual(codes.failures);
    expect([...BACKUP_DIR_PROBLEMS]).toEqual(codes.dirProblems);
    expect([...KNOWN_BLOCK_CODES]).toEqual(codes.knownBlockCodes);
  });
});
