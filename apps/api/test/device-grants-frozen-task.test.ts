import { describe, expect, it } from "vitest";
import { buildFrozenGrantTask } from "../src/modules/device-grants/frozen-task";
describe("frozen productive scope", () => {
  const scope = { snapshotId: "saved-snapshot", contentDigest: "a".repeat(64), mode: "check" };
  it("requires every productive event dimension without synthesizing quantity", () => {
    expect(
      buildFrozenGrantTask("inventory", "task", scope, ["inventory.scan.v1"], {
        "inventory.scan.v1": { maxEvents: 3 },
      }),
    ).toEqual({ status: "denied", reason: "bounds_required" });
  });
  it("retains zero as an exhausted budget", () => {
    expect(
      buildFrozenGrantTask("inventory", "task", scope, ["inventory.scan.v1"], {
        "inventory.scan.v1": { maxEvents: 0, maxUnits: 0 },
      }),
    ).toMatchObject({
      status: "ready",
      task: {
        eventTypes: ["inventory.scan.v1"],
        budget: [
          { id: "inventory.scan.v1:events", maximum: 0 },
          { id: "inventory.scan.v1:units", maximum: 0 },
        ],
      },
    });
  });
  it("changes frozen identity with task scope but keeps same-scope retries stable", () => {
    const bounds = { "inventory.close.v1": { maxEvents: 1 } };
    const first = buildFrozenGrantTask("inventory", "task", scope, ["inventory.close.v1"], bounds);
    const same = buildFrozenGrantTask(
      "inventory",
      "task",
      { ...scope },
      ["inventory.close.v1"],
      bounds,
    );
    const changed = buildFrozenGrantTask(
      "inventory",
      "task",
      { ...scope, contentDigest: "b".repeat(64) },
      ["inventory.close.v1"],
      bounds,
    );
    expect(first).toEqual(same);
    expect(changed).not.toEqual(first);
  });
  it("does not turn missing event bounds into a wildcard", () => {
    expect(
      buildFrozenGrantTask("shift", "task", {}, ["shift.scan.v1", "shift.close.v1"], {
        "shift.scan.v1": { maxEvents: 5, maxUnits: 4 },
      }),
    ).toEqual({ status: "denied", reason: "bounds_required" });
  });
});
