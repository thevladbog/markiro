import { runHostProcess, runHostArchiveProcess } from "../host/process.mjs";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { extractProductMigrationProof, readProductMigrationTar } from "../host/forward-product.mjs";
import { productFiles } from "./forward-product-fixture.mjs";
import { hostIdentity, privateFixture } from "./host-fixtures.mjs";
function tar(files = productFiles(), patch = {}) {
  const chunks = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    header.write(patch.name ?? `migrations/${file.path}`, 0, 100);
    header.write("0000600\0", 100, 8);
    header.write(`${file.bytes.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    header.fill(32, 148, 156);
    header.write(patch.type ?? "0", 156, 1);
    header.write("ustar\0", 257, 6);
    const checksum = header.reduce((a, b) => a + b, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    chunks.push(header, file.bytes, Buffer.alloc((512 - (file.bytes.length % 512)) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
test("tar parser accepts only bounded original regular migration bytes", () => {
  const files = readProductMigrationTar(tar());
  assert.deepEqual(files, productFiles());
  for (const patch of [
    { name: "../escape" },
    { name: "/absolute" },
    { type: "2" },
    { type: "1" },
    { type: "x" },
  ])
    assert.throws(() => readProductMigrationTar(tar(undefined, patch)));
  const corrupt = tar();
  corrupt[0] ^= 1;
  assert.throws(() => readProductMigrationTar(corrupt));
  assert.throws(() => readProductMigrationTar(tar().subarray(0, -1025)));
  assert.throws(() => readProductMigrationTar(Buffer.alloc(16 * 1024 * 1024 + 1)));
  assert.throws(() =>
    readProductMigrationTar(
      tar([{ path: "0000_large.sql", bytes: Buffer.alloc(2 * 1024 * 1024 + 1) }]),
    ),
  );
});
async function fixture(t, patch = {}) {
  const f = await privateFixture(t),
    identity = hostIdentity(),
    commands = [];
  const cid = "c".repeat(64);
  let container;
  let removed = false;
  let sources = 0;
  const runProcess = async (request) => {
    const args = request.args.slice(2);
    commands.push(args);
    let stdout;
    if (args[0] === "image")
      stdout = JSON.stringify([
        {
          Id: identity.admission.registry.api.imageId,
          Os: "linux",
          Architecture: "amd64",
          RepoDigests: [identity.admission.manifest.api],
          Config: { Volumes: null },
          ...patch.image,
        },
      ]);
    else if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1];
      container = {
        Id: cid,
        Name: `/${name}`,
        Image: identity.admission.registry.api.imageId,
        Config: {
          Image: identity.admission.manifest.api,
          Labels: {
            "io.markiro.operation": identity.operationId,
            "io.markiro.purpose": "product-migrations",
            "io.markiro.extraction": name,
          },
          Entrypoint: ["/bin/false"],
          Cmd: null,
        },
        HostConfig: {
          NetworkMode: "none",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          LogConfig: { Type: "none" },
          Privileged: false,
        },
        Mounts: [],
        State: {
          Status: "created",
          Running: false,
          Paused: false,
          Restarting: false,
          StartedAt: "0001-01-01T00:00:00Z",
        },
        ...patch.container,
      };
      stdout = cid;
    } else if (args[0] === "cp") {
      if (patch.copyFailure)
        throw Object.assign(new Error("private-copy-failure"), {
          terminationConfirmed: patch.copyFailure !== "unknown",
        });
      const relative = args[1].split("/migrations/")[1];
      // The real image also contains >126 MiB of meta/*_snapshot.json. A directory
      // copy must never be requested; only one validated source file is returned.
      assert.ok(relative && relative !== ".", "must not copy snapshot-bearing directory");
      const file = (patch.files ?? productFiles()).find((file) => file.path === relative);
      assert.ok(file, "only journal-selected SQL or the journal may be copied");
      stdout = tar([{ ...file, path: relative.split("/").at(-1) }]);
    } else if (args[0] === "container" && args[1] === "inspect")
      stdout = JSON.stringify([container]);
    else if (args[0] === "container" && args[1] === "rm") {
      assert.equal(args.at(-1), cid);
      assert.equal(args.includes("--force"), false);
      if (patch.cleanupFailure) throw new Error("private-cleanup-failure");
      removed = true;
      stdout = cid;
    } else if (args[0] === "container" && args[1] === "ls") stdout = removed ? "" : cid;
    else assert.fail(`unexpected fixed command ${args[0]}`);
    return {
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
      stderr: Buffer.alloc(0),
    };
  };
  return {
    ...f,
    identity,
    commands,
    runProcess,
    verifySources: async () => {
      sources++;
    },
    get sources() {
      return sources;
    },
  };
}
test("extractor independently binds image, never starts container, retains proof and removes only exact stopped ID", async (t) => {
  const f = await fixture(t);
  const proof = await extractProductMigrationProof(f);
  assert.equal(proof.productSha, f.identity.admission.manifest.sourceSha);
  assert.ok(f.sources > 3);
  const create = f.commands.find((a) => a[0] === "create");
  for (const flag of ["--read-only", "--network", "--cap-drop", "--security-opt", "--log-driver"])
    assert.ok(create.includes(flag));
  assert.equal(
    f.commands.some((a) => ["start", "run", "exec"].includes(a[0])),
    false,
  );
  assert.equal(f.commands.filter((a) => a[1] === "rm").length, 1);
  const [name] = await readdir(join(f.root, "product-migration-proofs"));
  const saved = JSON.parse(await readFile(join(f.root, "product-migration-proofs", name)));
  assert.deepEqual(saved, proof);
});
for (const kind of [
  "image-id",
  "digest",
  "volume",
  "foreign-container",
  "running",
  "cleanup",
  "copy",
  "unknown-copy",
])
  test(`extractor denies ${kind} and cannot proceed with unproved extraction`, async (t) => {
    const patches = {
      "image-id": { image: { Id: `sha256:${"f".repeat(64)}` } },
      digest: { image: { RepoDigests: [] } },
      volume: { image: { Config: { Volumes: { "/data": {} } } } },
      "foreign-container": { container: { Image: `sha256:${"f".repeat(64)}` } },
      running: { container: { State: { Running: true } } },
      cleanup: { cleanupFailure: true },
      copy: { copyFailure: "known" },
      "unknown-copy": { copyFailure: "unknown" },
    };
    const f = await fixture(t, patches[kind]);
    await assert.rejects(extractProductMigrationProof(f), (error) => {
      assert.doesNotMatch(error.message, /private-copy|private-cleanup/u);
      if (["foreign-container", "running", "cleanup", "unknown-copy"].includes(kind))
        assert.equal(error.durabilityUncertain, true);
      return true;
    });
    assert.ok(
      f.commands.filter((a) => a[1] === "rm").length <= 1,
      "cleanup must never retry removal",
    );
    if (["foreign-container", "running", "unknown-copy"].includes(kind))
      assert.equal(
        f.commands.some((a) => a[1] === "rm"),
        false,
      );
  });

test("archive producer has an explicit 16 MiB ceiling while ordinary process ceiling remains 1 MiB", async (t) => {
  const f = await privateFixture(t);
  const options = {
    executable: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.alloc(1048577))"],
    cwd: f.root,
    env: {},
    timeoutMs: 5000,
    outputLimitBytes: 2 * 1024 * 1024,
  };
  await assert.rejects(runHostProcess(options), (error) => error.reason === "spawn");
  assert.equal((await runHostArchiveProcess(options)).stdout.length, 1048577);
  await assert.rejects(
    runHostArchiveProcess({ ...options, outputLimitBytes: 16 * 1024 * 1024 + 1 }),
  );
});

test("extractor copies journal first and only its SQL, leaving image snapshots unread", async (t) => {
  const f = await fixture(t);
  await extractProductMigrationProof(f);
  assert.deepEqual(
    f.commands.filter((a) => a[0] === "cp").map((a) => a[1].split("/migrations/")[1]),
    [
      "meta/_journal.json",
      ...productFiles()
        .filter((f) => f.path.endsWith(".sql"))
        .map((f) => f.path),
    ],
  );
});

test("extractor rejects unsafe journal tags before requesting SQL or snapshots", async (t) => {
  const files = productFiles();
  const journal = files.find((file) => file.path === "meta/_journal.json");
  const value = JSON.parse(journal.bytes);
  value.entries[0].tag = "../meta/0000_snapshot";
  journal.bytes = Buffer.from(JSON.stringify(value));
  const f = await fixture(t, { files });
  await assert.rejects(extractProductMigrationProof(f));
  assert.equal(f.commands.filter((a) => a[0] === "cp").length, 1);
});

test("tar parser accepts a journal-declared historical hyphenated SQL basename", () => {
  const path = "0028_avatar-owner-integrity.sql";
  const files = [{ path, bytes: Buffer.from("SELECT 28;\n") }];
  assert.deepEqual(readProductMigrationTar(tar(files), path), files);
});
