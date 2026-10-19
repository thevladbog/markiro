import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
for (const path of ["/probe/worker.mjs", "/input/connections.json", "/input/ca.crt"]) {
  const info = await stat(path);
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o7777, 0o600);
  assert.ok((await readFile(path)).length > 0);
}
assert.equal(
  JSON.parse(await readFile("/input/connections.json", "utf8")).appUrl.startsWith("postgresql:"),
  true,
);
console.log(JSON.stringify({ read: 3, uid: process.getuid() }));
