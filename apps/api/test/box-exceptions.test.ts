import { describe, expect, it } from "vitest";
import { sortExceptions, type ExceptionDto } from "../src/modules/station-scans/box-exceptions";

function ex(
  boxId: string,
  kind: ExceptionDto["kind"],
  codeHash: string | null = null,
): ExceptionDto {
  return {
    kind,
    boxId,
    codeHash,
    shiftId: "s1",
    terminalId: null,
    operatorId: null,
    reason: kind === "undo" ? null : "test",
    occurredAt: "2026-07-30T00:00:00.000Z",
  };
}

describe("sortExceptions", () => {
  it("orders deterministically by boxId, then kind, then codeHash", () => {
    const input = [
      ex("b2", "reprint"),
      ex("b1", "clear"),
      ex("b1", "undo", "hash2"),
      ex("b1", "undo", "hash1"),
    ];
    const sorted = sortExceptions(input);
    expect(sorted.map((e) => `${e.boxId}:${e.kind}:${e.codeHash ?? ""}`)).toEqual([
      "b1:clear:",
      "b1:undo:hash1",
      "b1:undo:hash2",
      "b2:reprint:",
    ]);
  });
});
