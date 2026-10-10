import { describe, expect, it } from "vitest";

import type { BackupState } from "../src/host/backups.js";
import {
  backupWarnings,
  failureReason,
  warningText,
  warningTone,
  warningToneKey,
} from "../src/office/backups/backup-warnings.js";
import { formatWhen } from "../src/office/backups/backup-format.js";
import { backupCopy, HEALTHY_BACKUPS } from "./support/backups.js";

function state(change: Partial<BackupState>): BackupState {
  return { ...HEALTHY_BACKUPS, ...change };
}

describe("backupWarnings", () => {
  it("is quiet when both folders have a fresh copy", () => {
    expect(backupWarnings(HEALTHY_BACKUPS)).toEqual([]);
  });

  it("names a failed folder first, with its reason", () => {
    const failed = state({
      local: {
        ...HEALTHY_BACKUPS.local,
        lastAttempt: {
          at: "2026-10-09T14:00:03Z",
          trigger: "scheduled",
          ok: false,
          code: "disk_full",
        },
      },
      second: {
        ...HEALTHY_BACKUPS.local,
        dir: "E:\\Markiro",
        lastAttempt: {
          at: "2026-10-09T14:00:03Z",
          trigger: "scheduled",
          ok: false,
          code: "from_a_newer_host",
        },
      },
    });
    const warnings = backupWarnings(failed);
    expect(warnings).toEqual([
      { kind: "localFailed", reason: "disk_full" },
      { kind: "secondFailed", reason: "unknown" },
    ]);
    expect(warnings.map(warningTone)).toEqual(["error", "error"]);
    expect(warningText(warnings[0]!)).toEqual({
      key: "office.backups.warnings.localFailed",
      reason: "office.backups.failures.disk_full",
    });
  });

  it("warns of no copy, a copy older than 26 hours and no second folder", () => {
    expect(
      backupWarnings(state({ local: { ...HEALTHY_BACKUPS.local, copies: [] }, second: null })),
    ).toEqual([{ kind: "noCopies" }, { kind: "noSecond" }]);
    const old = [backupCopy("2026-10-08T12:19:59Z")];
    const exactly = [backupCopy("2026-10-08T12:20:00Z")];
    expect(
      backupWarnings(
        state({
          local: { ...HEALTHY_BACKUPS.local, copies: old },
          second: { ...HEALTHY_BACKUPS.local, copies: old },
        }),
      ),
    ).toEqual([{ kind: "stale" }, { kind: "secondStale" }]);
    expect(
      backupWarnings(
        state({
          local: { ...HEALTHY_BACKUPS.local, copies: exactly },
          second: { ...HEALTHY_BACKUPS.local, copies: exactly },
        }),
      ),
    ).toEqual([]);
    expect(warningTone({ kind: "stale" })).toBe("warn");
    expect(warningText({ kind: "noSecond" })).toEqual({ key: "office.backups.warnings.noSecond" });
  });

  it("does not repeat a stale second folder whose last attempt failed", () => {
    const old = [backupCopy("2026-10-01T00:00:00Z")];
    expect(
      backupWarnings(
        state({
          second: {
            dir: "E:\\Markiro",
            copies: old,
            lastAttempt: {
              at: "2026-10-09T14:00:03Z",
              trigger: "scheduled",
              ok: false,
              code: "destination_unavailable",
            },
          },
        }),
      ),
    ).toEqual([{ kind: "secondFailed", reason: "destination_unavailable" }]);
  });

  it("warns of a copy running for more than half an hour", () => {
    const running = (startedAt: string) => state({ running: { trigger: "manual", startedAt } });
    expect(backupWarnings(running("2026-10-09T13:50:00Z"))).toEqual([]);
    expect(backupWarnings(running("2026-10-09T13:49:59Z"))).toEqual([{ kind: "stuck" }]);
    expect(warningTone({ kind: "stuck" })).toBe("warn");
  });

  it("puts the facts a restore holds first, with how many stations wait, and claims no count of returned blocks", () => {
    const held = state({
      restoreHold: {
        since: "2026-10-09T15:00:00Z",
        epoch: "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e",
        stations: [
          {
            id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
            name: "Станция 1",
            lastSeenAt: null,
            reconciled: true,
          },
          {
            id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
            name: "Станция 2",
            lastSeenAt: null,
            reconciled: false,
          },
        ],
      },
      second: null,
    });
    const warnings = backupWarnings(held);
    expect(warnings).toEqual([
      { kind: "held", since: "2026-10-09T15:00:00Z", stations: 2 },
      { kind: "noSecond" },
    ]);
    expect(warningTone(warnings[0]!)).toBe("error");
    expect(warningText(warnings[0]!)).toEqual({
      key: "office.backups.warnings.held",
      values: { since: formatWhen("2026-10-09T15:00:00Z"), stations: 2 },
    });
  });

  it("writes the time of a warning with the formatter it is given", () => {
    const text = warningText(
      { kind: "held", since: "2026-10-09T15:00:00Z", stations: 0 },
      (instant) => `<${instant}>`,
    );
    expect(text.values).toEqual({ since: "<2026-10-09T15:00:00Z>", stations: 0 });
  });

  it("names a failed folder's tone for a screen reader, not by colour alone", () => {
    expect(warningToneKey({ kind: "held", since: "2026-10-09T15:00:00Z", stations: 0 })).toBe(
      "office.backups.tone.error",
    );
    expect(warningToneKey({ kind: "noSecond" })).toBe("office.backups.tone.warn");
  });

  it("reads only the failure codes it has words for", () => {
    expect(failureReason("verify_failed")).toBe("verify_failed");
    expect(failureReason(null)).toBe("unknown");
    expect(failureReason("toString")).toBe("unknown");
  });
});
