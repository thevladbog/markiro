import { expect, it } from "vitest";
import type { ExportFinding } from "@markiro/platform-contracts";
import { requestFindingTarget } from "../src/us/requests/source.js";

const eventId = "a0000000-0000-4000-8000-000000000001";
const finding = (sourceRecord: string, extra: Partial<ExportFinding> = {}): ExportFinding => ({
  code: "missing_value",
  severity: "error",
  sourceRecord,
  message: "Missing value",
  ...extra,
});
it.each([
  ["receiving", "item", "items"],
  ["shipping", "item", "items"],
  ["transformation", "input", "inputs"],
  ["transformation", "output", "outputs"],
] as const)("maps canonical %s %s to the exact revision and line", (type, role, lineSide) => {
  expect(
    requestFindingTarget(
      finding(`${type}:${eventId}:3:${role}:2`, { eventId, revision: 3, lineNo: 2 }),
    ),
  ).toEqual({ type, eventId, revision: 3, lineSide, lineNo: 2 });
});
it.each([
  "metadata:plan",
  "request:scope",
  `receiving:${eventId}:3:output:2`,
  `transformation:${eventId}:3:item:2`,
  `shipping:${eventId}:0:item:2`,
  `receiving:${eventId}:03:item:2`,
  `receiving:${eventId}:3:item:0`,
  `receiving:${eventId}:3:item:2:extra`,
  `receiving:${eventId.toUpperCase()}:3:item:2`,
])("keeps unknown or noncanonical source %s as text", (source) => {
  expect(requestFindingTarget(finding(source))).toBeNull();
});
it.each([{ eventId: "20000000-0000-4000-8000-000000000002" }, { revision: 4 }, { lineNo: 1 }])(
  "rejects inconsistent optional evidence %j",
  (extra) => {
    expect(requestFindingTarget(finding(`receiving:${eventId}:3:item:2`, extra))).toBeNull();
  },
);
