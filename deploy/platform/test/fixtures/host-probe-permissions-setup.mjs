// Static fixture: no generated/evaluated source; stdin is synthetic data only.
import assert from "node:assert/strict";
import fs from "node:fs";
const input = JSON.parse(fs.readFileSync(0, "utf8"));
assert.ok(Number.isSafeInteger(input.uid) && input.uid > 0);
assert.ok(Number.isSafeInteger(input.gid) && input.gid >= 0);
assert.deepEqual(input.files.map((file) => file.name).sort(), [
  "ca.crt",
  "connections.json",
  "worker.mjs",
]);
for (const file of input.files) {
  const path = "/data/" + file.name;
  fs.writeFileSync(path, Buffer.from(file.bytes, "base64"), { mode: 0o600, flag: "wx" });
  fs.chownSync(path, input.uid, input.gid);
}
fs.chmodSync("/data", 0o700);
fs.chownSync("/data", input.uid, input.gid);
