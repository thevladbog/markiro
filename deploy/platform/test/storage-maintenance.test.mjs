import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const maintenance = fileURLToPath(new URL("../maintenance/", import.meta.url));

test("storage maintenance preserves rollback images and verified archive copies", async () => {
  await exec(
    "python3",
    ["-B", "-m", "unittest", "test_image_retention", "test_archive_retirement"],
    { cwd: maintenance, timeout: 30_000 },
  );
});

test("the archive S3 client is valid Node.js source", async () => {
  await exec(process.execPath, ["--check", "archive-s3.cjs"], {
    cwd: maintenance,
    timeout: 30_000,
  });
});
