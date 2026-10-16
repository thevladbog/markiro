import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { readFixtureBody } from "../../../apps/station/test/browser/read-fixture-body.mjs";

const text = JSON.stringify({ label: "ЕДИНИЦ", note: "Палета А4 · горизонтальная" });
const bytes = Buffer.from(text, "utf8");

test("a multi-byte letter split between two chunks is decoded intact", async () => {
  const at = bytes.indexOf(Buffer.from("Д", "utf8")) + 1; // inside the two-byte letter
  const request = Readable.from([bytes.subarray(0, at), bytes.subarray(at)]);
  assert.equal(await readFixtureBody(request, 1024), text);
});

test("every possible chunk boundary round-trips", async () => {
  for (let at = 1; at < bytes.length; at++) {
    const request = Readable.from([bytes.subarray(0, at), bytes.subarray(at)]);
    assert.equal(await readFixtureBody(request, 1024), text, `split at byte ${at}`);
  }
});

test("the limit counts bytes, not characters", async () => {
  await assert.rejects(
    readFixtureBody(Readable.from([Buffer.from("ЕДИНИЦ", "utf8")]), 11),
    /too large/,
  );
  assert.equal(await readFixtureBody(Readable.from([Buffer.from("ЕДИНИЦ", "utf8")]), 12), "ЕДИНИЦ");
});
