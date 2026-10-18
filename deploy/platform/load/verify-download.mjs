import { validateReportContent } from "./report-content.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const require = createRequire("/app/package.json");
const { unzipSync } = require("fflate");
const input = JSON.parse(readFileSync("/load-private/download.json", "utf8"));
const url = new URL(input.url);
assert.equal(url.hostname, "seaweedfs");
assert.equal(url.port, "8333");
const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
assert.equal(response.status, 200);
const bytes = Buffer.from(await response.arrayBuffer()),
  zip = unzipSync(bytes);
const csvEntry = Object.entries(zip).find(([name]) => name.endsWith(".csv")),
  metaEntry = Object.entries(zip).find(([name]) => name.endsWith(".json"));
assert.ok(csvEntry);
assert.ok(metaEntry);
const csv = Buffer.from(csvEntry[1]),
  metadata = JSON.parse(Buffer.from(metaEntry[1]).toString());
const validatedRows = validateReportContent(csv, metadata, input);
console.log(
  JSON.stringify({
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    validatedRows,
    contentValidation: "exact-tenant-day-grain-v2",
  }),
);
