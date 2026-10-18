import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { hasOomEvent } from "../load/core.mjs";
import { validateReportContent } from "../load/report-content.mjs";

const tenants = Array.from({ length: 10 }, (_, i) => `tenant-${i}`);
const days = Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
const input = {
  tenants,
  excluded: "excluded-sentinel",
  rowCount: 300,
  fromDate: days[0],
  toDate: days.at(-1),
};
const rows = tenants.flatMap((tenant) =>
  days.map((day) => [tenant, "Synthetic factory", day, "1"]),
);
function report(records = rows) {
  const csv = Buffer.from(
    "\uFEFF" +
      [["tenant_id", "tenant_name", "day", "agreements_signed"], ...records]
        .map((row) => row.map((cell) => '"' + cell.replaceAll('"', '""') + '"').join(","))
        .join("\r\n") +
      "\r\n",
  );
  return [
    csv,
    { rowCount: records.length, dataSha256: createHash("sha256").update(csv).digest("hex") },
    input,
  ];
}
test("allocation OOM without process kill is rejected", () => {
  assert.equal(
    hasOomEvent(false, "low 0\nhigh 0\nmax 1\noom 1\noom_kill 0\noom_group_kill 0\n"),
    true,
  );
});
test("all OOM counter kinds and Docker kill flag are recognized", () => {
  assert.equal(hasOomEvent(true, "oom 0\noom_kill 0\noom_group_kill 0"), true);
  assert.equal(hasOomEvent(false, "oom 0\noom_kill 0\noom_group_kill 1"), true);
  assert.equal(hasOomEvent(false, "oom 0\noom_kill 2\noom_group_kill 0"), true);
  assert.equal(
    hasOomEvent(false, "low 0\nhigh 0\nmax 1\noom 0\noom_kill 0\noom_group_kill 0"),
    false,
  );
});
test("complete ten-tenant by thirty-day report passes", () => {
  assert.equal(validateReportContent(...report()), 300);
});
test("rejects valid-checksum foreign rows that preserve all tenants and row count", () => {
  const injected = [
    ...tenants.map((t) => [t, "Synthetic factory", days[0], "1"]),
    ...Array.from({ length: 290 }, () => [
      "different-foreign-tenant",
      "Synthetic factory",
      days[0],
      "1",
    ]),
  ];
  assert.throws(() => validateReportContent(...report(injected)));
});
test("rejects duplicate grain replacing a missing grain", () => {
  const duplicated = rows.map((row) => [...row]);
  duplicated[299] = [...duplicated[298]];
  assert.throws(() => validateReportContent(...report(duplicated)));
});
test("rejects date outside the requested range", () => {
  const outside = rows.map((row) => [...row]);
  outside[0][2] = "2026-09-30";
  assert.throws(() => validateReportContent(...report(outside)));
});
test("rejects missing rows and wrong agreement counts", () => {
  assert.throws(() => validateReportContent(...report(rows.slice(1))));
  const altered = rows.map((row) => [...row]);
  altered[10][3] = "2";
  assert.throws(() => validateReportContent(...report(altered)));
});
test("CSV parser preserves quoted commas, quotes and newlines", () => {
  const escaped = rows.map((row) => [...row]);
  escaped[0][1] = 'Synthetic, "factory"\r\nsecond line';
  assert.equal(validateReportContent(...report(escaped)), 300);
});
