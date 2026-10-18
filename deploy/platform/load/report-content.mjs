import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// The production renderer quotes every CSV cell. Sticky parsing consumes every
// byte and supports doubled quotes and embedded commas/CRLF inside quoted cells.
function parseRenderedCsv(bytes) {
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  const cell = /"((?:[^"]|"")*)"(,|\r\n|$)/gy;
  const rows = [];
  let row = [],
    offset = 0;
  while (offset < text.length) {
    cell.lastIndex = offset;
    const match = cell.exec(text);
    assert.ok(match, "Malformed rendered CSV");
    offset = cell.lastIndex;
    row.push(match[1].replaceAll('""', '"'));
    if (match[2] !== ",") {
      rows.push(row);
      row = [];
    }
  }
  assert.equal(row.length, 0, "Incomplete CSV row");
  return rows;
}

export function validateReportContent(csv, metadata, input) {
  assert.equal(metadata.rowCount, input.rowCount);
  assert.equal(metadata.dataSha256, createHash("sha256").update(csv).digest("hex"));
  const tenants = new Set(input.tenants);
  assert.ok(tenants.size > 0);
  assert.equal(tenants.size, input.tenants.length, "Duplicate expected tenant");
  for (const date of [input.fromDate, input.toDate]) {
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10), date);
  }
  const start = Date.parse(`${input.fromDate}T00:00:00Z`),
    end = Date.parse(`${input.toDate}T00:00:00Z`);
  assert.ok(end >= start && end - start < 366 * 86400000);
  const expected = new Set();
  for (let at = start; at <= end; at += 86400000) {
    const day = new Date(at).toISOString().slice(0, 10);
    for (const tenant of tenants) expected.add(JSON.stringify([tenant, day]));
  }
  assert.equal(input.rowCount, expected.size, "Expected row count must cover every tenant/day");
  const [header, ...rows] = parseRenderedCsv(csv);
  assert.ok(header);
  assert.equal(new Set(header).size, header.length, "Duplicate CSV column");
  const tenantColumn = header.indexOf("tenant_id"),
    dayColumn = header.indexOf("day"),
    countColumn = header.indexOf("agreements_signed");
  assert.ok(tenantColumn >= 0 && dayColumn >= 0 && countColumn >= 0);
  assert.equal(rows.length, expected.size);
  for (const row of rows) {
    assert.equal(row.length, header.length, "CSV row width mismatch");
    assert.equal(row[countColumn], "1", "Incorrect agreement count");
    const grain = JSON.stringify([row[tenantColumn], row[dayColumn]]);
    assert.ok(expected.delete(grain), "Foreign, out-of-range or duplicate tenant/day grain");
  }
  assert.equal(expected.size, 0, "Missing tenant/day grain");
  return rows.length;
}
