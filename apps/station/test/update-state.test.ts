import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  automaticCheckDue,
  loadUpdateState,
  recordCheckAttempt,
  recordCheckSuccess,
  saveUpdateState,
  updateSeverity,
} from "../src/lib/update-state.js";
import { makeExec } from "./support/sqlite-exec.js";

describe("station update state", () => {
  it("uses exact 7-day and 30-day boundaries", () => {
    const now = Date.parse("2026-08-31T00:00:00.000Z");
    expect(updateSeverity(now, null)).toBe("none");
    expect(
      updateSeverity(now, { version: "0.1.0-beta.2", publishedAt: "2026-08-24T00:00:01.000Z" }),
    ).toBe("info");
    expect(
      updateSeverity(now, { version: "0.1.0-beta.2", publishedAt: "2026-08-24T00:00:00.000Z" }),
    ).toBe("warn");
    expect(
      updateSeverity(now, { version: "0.1.0-beta.2", publishedAt: "2026-08-01T00:00:00.000Z" }),
    ).toBe("urgent");
  });

  it("throttles automatic checks but allows state transitions to retain a known update", () => {
    const empty = recordCheckAttempt(null, "2026-08-11T00:00:00.000Z");
    const known = recordCheckSuccess(empty, "2026-08-11T00:00:10.000Z", {
      version: "0.1.0-beta.2",
      publishedAt: "2026-08-10T00:00:00.000Z",
    });
    const failedLater = recordCheckAttempt(known, "2026-08-11T01:00:00.000Z");
    expect(failedLater.available).toEqual(known.available);
    expect(automaticCheckDue(Date.parse("2026-08-11T23:59:59.999Z"), failedLater)).toBe(false);
    expect(automaticCheckDue(Date.parse("2026-08-12T01:00:00.000Z"), failedLater)).toBe(true);
  });

  it("round-trips one bounded record and fails malformed data to empty state", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE station_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const exec = makeExec(db);
    const state = recordCheckSuccess(null, "2026-08-11T00:00:00.000Z", null);
    await saveUpdateState(exec, state);
    expect(await loadUpdateState(exec)).toEqual(state);
    db.prepare("UPDATE station_meta SET value = ? WHERE key = ?").run(
      "{bad",
      "station_update_state_v1",
    );
    expect(await loadUpdateState(exec)).toBeNull();
  });

  it("round-trips a canonical stable update for stable Station builds", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE station_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const exec = makeExec(db);
    const state = recordCheckSuccess(null, "2026-08-11T00:00:00.000Z", {
      version: "1.1.0",
      publishedAt: "2026-08-10T00:00:00.000Z",
    });
    await saveUpdateState(exec, state);
    expect(await loadUpdateState(exec)).toEqual(state);
  });

  it("rejects malformed and future metadata", () => {
    expect(() =>
      updateSeverity(Date.parse("2026-08-11T00:00:00.000Z"), {
        version: "0.1.0-beta.2",
        publishedAt: "2026-08-12T00:00:00.000Z",
      }),
    ).toThrow(/invalid station update state/);
    expect(() =>
      recordCheckSuccess(null, "2026-08-11T00:00:00.000Z", {
        version: "0.1.0-rc.1",
        publishedAt: "2026-08-10T00:00:00.000Z",
      }),
    ).toThrow(/invalid station update state/);
  });
});
