import { describe, expect, it } from "vitest";

import type { SyncState } from "../src/app/shell.js";
import { syncChipModel } from "../src/office/sync-chip.js";

const sync = (overrides: Partial<SyncState> = {}): SyncState => ({
  kind: "done",
  synced: 1,
  failure: null,
  quarantined: 0,
  ...overrides,
});

describe("the sync chip", () => {
  it("is absent where the shell's sync is unknown", () => {
    expect(syncChipModel(null, null)).toBeNull();
  });

  it("says the time of a sync the office saw finish, on an ok chip", () => {
    expect(syncChipModel(sync(), "12:04")).toEqual({
      tone: "ok",
      labelKey: "office.header.sync.at",
      time: "12:04",
    });
  });

  it("does not invent a time for a sync that finished before the office looked", () => {
    expect(syncChipModel(sync(), null)).toEqual({
      tone: "ok",
      labelKey: "office.header.sync.done",
      time: null,
    });
  });

  it("is amber with its own words for a failed sync, another host, or a failure the shell retries", () => {
    for (const state of [
      sync({ kind: "failed" }),
      sync({ kind: "other_host" }),
      sync({ kind: "done", failure: "host" }),
    ]) {
      expect(syncChipModel(state, "12:04")).toEqual({
        tone: "warn",
        labelKey: "office.header.sync.failed",
        time: null,
      });
    }
  });

  it("is info while running and neutral while idle", () => {
    expect(syncChipModel(sync({ kind: "running" }), null)?.tone).toBe("info");
    expect(syncChipModel(sync({ kind: "running" }), null)?.labelKey).toBe(
      "office.header.sync.running",
    );
    expect(syncChipModel(sync({ kind: "idle" }), null)).toEqual({
      tone: "neutral",
      labelKey: "office.header.sync.idle",
      time: null,
    });
  });
});
