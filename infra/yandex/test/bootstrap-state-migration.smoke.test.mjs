import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("clean bootstrap state is applied locally then migrated to disposable S3", (context) => {
  try {
    execFileSync(process.execPath, [
      path.join(import.meta.dirname, "bootstrap-state-migration.smoke.mjs"),
    ], { stdio: "pipe" });
  } catch (error) {
    const message = `${error.message}\n${error.stderr?.toString("utf8") ?? ""}`;
    if (error.code === "ENOENT" || message.includes("ERROR: EPERM")) {
      context.skip("the sandbox does not permit the disposable S3 listener");
      return;
    }
    assert.fail(error.stderr?.toString("utf8") || error.message);
  }
});
