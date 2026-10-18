import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { admitPlatformRelease } from "../admit-release.mjs";
import { extractReleaseZip } from "../admission-archive.mjs";
import { validateRegistryManifest, inspectRegistryImage } from "../admission-registry.mjs";
import { expected, release, publisher, jobs, registry, digest } from "./admission-fixtures.mjs";
const exec = promisify(execFile);
const base = "https://api.github.com/repos/thevladbog/markiro/actions";
const token = "sentinel-GH-token-never-print";
const rawSecret = "sentinel-upstream-secret-never-print";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const response = (value) => new Response(JSON.stringify(value));
async function temporary(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), "admission-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function zipBytes(dir, entries, patch = "") {
  const script = `import json,sys,zipfile,stat\nentries=json.loads(sys.argv[2])\nwith zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as z:\n for e in entries:\n  i=zipfile.ZipInfo(e['name']); i.compress_type=zipfile.ZIP_DEFLATED\n  i.external_attr=e.get('mode', stat.S_IFREG | 0o600)<<16\n  z.writestr(i, e['text'])\n${patch}`;
  const file = join(dir, "fixture.zip");
  await exec("python3", ["-I", "-c", script, file, JSON.stringify(entries)], {
    maxBuffer: 2 * 1024 * 1024,
  });
  return fs.readFile(file);
}
function entries(value = release()) {
  return [
    { name: "platform-manifest.json", text: JSON.stringify(value.manifest) },
    { name: "release-evidence.json", text: JSON.stringify(value.evidence) },
  ];
}
async function harness(t) {
  const dir = await temporary(t);
  const bytes = await zipBytes(dir, entries());
  const run = publisher();
  const ci = {
    ...run,
    id: 123,
    run_attempt: 3,
    name: "CI",
    path: ".github/workflows/ci.yml",
    event: "push",
  };
  const state = {
    bytes,
    run,
    attempt: structuredClone(run),
    jobs: jobs(run),
    ci,
    ciAttempt: structuredClone(ci),
    ciJobs: jobs(ci, ["production-bundle", "ci-required"]),
    calls: [],
    commands: [],
    metadata: {
      id: 789,
      name: "markiro-platform-release-456-2",
      expired: false,
      expires_at: "2099-01-01T00:00:00Z",
      size_in_bytes: bytes.length,
      digest: `sha256:${hash(bytes)}`,
      workflow_run: {
        id: 456,
        head_sha: expected.sourceSha,
        head_branch: "main",
        repository_id: 10,
        head_repository_id: 10,
      },
    },
  };
  const adapters = {
    token,
    tempRoot: dir,
    request: async (url, options) => {
      state.calls.push({ url, options });
      if (state.override) {
        const result = await state.override(url, options);
        if (result) return result;
      }
      if (url === `${base}/runs/456`) return response(state.run);
      if (url === `${base}/runs/456/attempts/2`) return response(state.attempt);
      if (url === `${base}/runs/456/attempts/2/jobs?per_page=100&page=1`)
        return response(state.jobs);
      if (url === `${base}/artifacts/789`) return response(state.metadata);
      if (url === `${base}/artifacts/789/zip`)
        return new Response(null, {
          status: 302,
          headers: { Location: "https://blob.example/release.zip?signature=private" },
        });
      if (url === "https://blob.example/release.zip?signature=private")
        return new Response(state.bytes);
      if (url === `${base}/runs/123`) return response(state.ci);
      if (url === `${base}/runs/123/attempts/3`) return response(state.ciAttempt);
      if (url === `${base}/runs/123/attempts/3/jobs?per_page=100&page=1`)
        return response(state.ciJobs);
      throw new Error(rawSecret);
    },
    run: async (command, args, options) => {
      state.commands.push({ command, args, options });
      assert.equal(command, "docker");
      assert.deepEqual(args.slice(0, 3), ["manifest", "inspect", "--verbose"]);
      const name = args[3].includes("markiro-api@") ? "api" : "edge";
      return JSON.stringify(registry(args[3], release().evidence.verified.images[name].id));
    },
  };
  const input = { ...expected, artifactId: "789", outputFile: join(dir, "record.json") };
  return { dir, state, adapters, input };
}
async function rejected(h, phase) {
  await assert.rejects(admitPlatformRelease(h.input, h.adapters), {
    message: `platform admission failed: ${phase}`,
  });
  await assert.rejects(fs.lstat(h.input.outputFile), { code: "ENOENT" });
  assert.deepEqual(
    (await fs.readdir(h.dir)).filter((name) => name.startsWith("platform-admission-")),
    [],
  );
}
test("ordered default ZIP verification produces exhaustive private admission record", async (t) => {
  const h = await harness(t);
  const value = release();
  const expectedRecord = {
    version: 1,
    kind: "platform-release-admission",
    repository: "thevladbog/markiro",
    manifest: value.manifest,
    verified: value.evidence.verified,
    artifact: { id: "789", sha256: hash(h.state.bytes) },
    publisher: { runId: "456", runAttempt: "2" },
    ci: { runId: "123", runAttempt: "3" },
    registry: Object.fromEntries(
      ["api", "edge"].map((name) => [
        name,
        {
          reference: value.manifest[name],
          imageId: value.evidence.verified.images[name].id,
          platform: "linux/amd64",
        },
      ]),
    ),
  };
  assert.deepEqual(await admitPlatformRelease(h.input, h.adapters), expectedRecord);
  assert.deepEqual(JSON.parse(await fs.readFile(h.input.outputFile, "utf8")), expectedRecord);
  assert.equal((await fs.stat(h.input.outputFile)).mode & 0o777, 0o600);
  assert.equal(h.state.commands.length, 2);
  assert.equal(h.state.calls.length, 9);
  for (const { url, options } of h.state.calls) {
    assert.ok(options.signal);
    assert.equal(options.redirect, "manual");
    assert.equal(
      options.headers?.Authorization,
      url.startsWith("https://api.github.com/") ? `Bearer ${token}` : undefined,
    );
  }
  assert.deepEqual((await fs.readdir(h.dir)).sort(), ["fixture.zip", "record.json"]);
});
test("rejects malformed selectors before all HTTP, processes and writes", async (t) => {
  const h = await harness(t);
  for (const key of ["sourceSha", "workflowRunId", "workflowRunAttempt", "artifactId"]) {
    for (const bad of [null, 123, "01", "1\n", "9007199254740992"]) {
      const input = { ...h.input, [key]: bad };
      await rejected({ ...h, input }, "input");
    }
  }
  assert.equal(h.state.calls.length, 0);
  assert.equal(h.state.commands.length, 0);
});
test("publisher rejects run/attempt, workflow, repository and success substitutions", async (t) => {
  for (const section of ["run", "attempt"]) {
    for (const patch of [
      { id: 457 },
      { run_attempt: 3 },
      { event: "push" },
      { name: "Other" },
      { path: ".github/workflows/release-images.yml" },
      { head_branch: "feature" },
      { head_sha: "b".repeat(40) },
      { status: "in_progress" },
      { conclusion: "failure" },
      { repository: { id: 10, full_name: "fork/markiro" } },
      { head_repository: { id: 11, full_name: "thevladbog/markiro" } },
      { repository: { id: "10", full_name: "thevladbog/markiro" } },
    ]) {
      const h = await harness(t);
      Object.assign(h.state[section], patch);
      await rejected(h, "publisher");
    }
  }
});
test("publisher requires complete unique jobs belonging to selected attempt", async (t) => {
  for (const patch of [
    { run_attempt: 1 },
    { run_id: 123 },
    { head_sha: "b".repeat(40) },
    { conclusion: "skipped" },
    { status: "queued" },
    { name: "other" },
    { id: 1000 },
  ]) {
    const h = await harness(t);
    Object.assign(h.state.jobs.jobs[1], patch);
    await rejected(h, "publisher");
  }
  for (const total_count of [0, 1, 3, 10001, "2"]) {
    const h = await harness(t);
    h.state.jobs.total_count = total_count;
    await rejected(h, "publisher");
  }
});
test("pagination fetches every page and rejects incomplete, repeated, mixed or changing inventories", async (t) => {
  for (const mutation of ["valid", "short", "duplicate", "mixed", "count"]) {
    const h = await harness(t);
    const all = jobs(publisher(), [
      "build",
      "publish",
      ...Array.from({ length: 99 }, (_, i) => `other-${i}`),
    ]);
    h.state.jobs = { total_count: 101, jobs: all.jobs.slice(0, 100) };
    const last = { total_count: 101, jobs: all.jobs.slice(100) };
    if (mutation === "short") last.jobs = [];
    if (mutation === "duplicate") last.jobs[0].id = 1000;
    if (mutation === "mixed") last.jobs[0].run_attempt = 1;
    if (mutation === "count") last.total_count = 102;
    h.state.override = async (url) =>
      url.endsWith("/runs/456/attempts/2/jobs?per_page=100&page=2") ? response(last) : undefined;
    if (mutation === "valid") await admitPlatformRelease(h.input, h.adapters);
    else await rejected(h, "publisher");
  }
});
test("artifact metadata binds ID/run/SHA/branch/repository/name/digest/expiration/size", async (t) => {
  for (const patch of [
    { id: 790 },
    { id: "789" },
    { name: "markiro-platform-release-456-1" },
    { expired: true },
    { expired: null },
    { expires_at: "2000-01-01T00:00:00Z" },
    { expires_at: "invalid" },
    { digest: digest("f") },
    { digest: `sha256:${"d".repeat(64)}\n` },
    { size_in_bytes: 1048577 },
    { size_in_bytes: 0 },
    { size_in_bytes: "10" },
  ]) {
    const h = await harness(t);
    Object.assign(h.state.metadata, patch);
    await rejected(h, patch.digest === digest("f") ? "archive" : "artifact");
  }
  for (const [key, bad] of [
    ["id", 457],
    ["head_sha", "b".repeat(40)],
    ["head_branch", "feature"],
    ["repository_id", 11],
    ["head_repository_id", 11],
  ]) {
    const h = await harness(t);
    h.state.metadata.workflow_run[key] = bad;
    await rejected(h, "artifact");
  }
});
test("JSON transport bounds bytes, denies redirects and masks upstream failures", async (t) => {
  for (const kind of ["redirect", "oversize", "error", "invalid", "throw"]) {
    const h = await harness(t);
    h.state.override = async () => {
      if (kind === "throw") throw new Error(rawSecret + token);
      if (kind === "redirect")
        return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
      if (kind === "oversize") return new Response("x".repeat(2 * 1024 * 1024 + 1));
      if (kind === "error") return new Response(rawSecret, { status: 500 });
      return new Response(rawSecret);
    };
    await rejected(h, "publisher");
    assert.equal(h.state.calls.length, 1);
  }
});
test("download rejects insecure/credentialed redirects, oversize, redirect loops and byte tampering", async (t) => {
  for (const location of [
    "http://blob.example/file",
    "https://user:secret@blob.example/file",
    "file:///tmp/file",
  ]) {
    const h = await harness(t);
    h.state.override = async (url) =>
      url.endsWith("/zip") ? new Response(null, { status: 302, headers: { location } }) : undefined;
    await rejected(h, "archive");
    assert.equal(
      h.state.calls.filter((x) => !x.url.startsWith("https://api.github.com/")).length,
      0,
    );
  }
  for (const mutation of ["oversize", "tamper", "truncated", "loop"]) {
    const h = await harness(t);
    if (mutation === "oversize") h.state.bytes = Buffer.alloc(1048577);
    if (mutation === "tamper") h.state.bytes[0] ^= 255;
    if (mutation === "truncated")
      h.state.bytes = h.state.bytes.subarray(0, h.state.bytes.length - 5);
    if (mutation === "loop")
      h.state.override = async (url) =>
        url.startsWith("https://blob.example/")
          ? new Response(null, { status: 302, headers: { location: url } })
          : undefined;
    await rejected(h, "archive");
  }
});
test("redirects are followed credential-free on every HTTPS hop", async (t) => {
  const h = await harness(t);
  h.state.override = async (url, options) => {
    if (url.startsWith("https://blob.example/"))
      return new Response(null, {
        status: 307,
        headers: { location: "https://blob2.example/final" },
      });
    if (url === "https://blob2.example/final") {
      assert.equal(options.headers?.Authorization, undefined);
      return new Response(h.state.bytes);
    }
  };
  await admitPlatformRelease(h.input, h.adapters);
});
test("real ZIP parser rejects extra/duplicate/nested/traversal/link/directory/encrypted/oversize/CRC/truncated entries", async (t) => {
  const dir = await temporary(t);
  for (const mutation of [
    "extra",
    "duplicate",
    "nested",
    "traversal",
    "link",
    "directory",
    "encrypted",
    "oversize",
    "crc",
    "truncated",
  ]) {
    const list = entries();
    let patch = "";
    if (mutation === "extra") list.push({ name: "extra", text: "no" });
    if (mutation === "duplicate") list.push(list[0]);
    if (mutation === "nested") list[0].name = "nested/platform-manifest.json";
    if (mutation === "traversal") list[0].name = "../platform-manifest.json";
    if (mutation === "link") list[0].mode = 0o120777;
    if (mutation === "directory") list[0].mode = 0o040700;
    if (mutation === "oversize") list[0].text = "x".repeat(256 * 1024 + 1);
    if (mutation === "encrypted")
      patch =
        "p=sys.argv[1]\nb=bytearray(open(p,'rb').read())\nb[6]|=1\ni=b.index(b'PK\\x01\\x02'); b[i+8]|=1\nopen(p,'wb').write(b)\n";
    if (mutation === "crc")
      patch =
        "p=sys.argv[1]\nb=bytearray(open(p,'rb').read())\ni=b.index(b'PK\\x01\\x02'); b[i+16]^=255\nopen(p,'wb').write(b)\n";
    let bytes = await zipBytes(dir, list, patch);
    if (mutation === "truncated") bytes = bytes.subarray(0, bytes.length - 8);
    const file = join(dir, "input.zip");
    await fs.writeFile(file, bytes);
    await assert.rejects(extractReleaseZip(file), undefined, mutation);
  }
});
test("valid-hash unsafe ZIP and altered evidence fail before CI/registry/output", async (t) => {
  for (const mutation of ["extra", "evidence"]) {
    const h = await harness(t);
    const value = release();
    if (mutation === "evidence") value.evidence.status = "incomplete";
    const list = entries(value);
    if (mutation === "extra") list.push({ name: "extra", text: "no" });
    h.state.bytes = await zipBytes(h.dir, list);
    h.state.metadata.digest = `sha256:${hash(h.state.bytes)}`;
    h.state.metadata.size_in_bytes = h.state.bytes.length;
    await rejected(h, mutation === "extra" ? "archive" : "evidence");
    assert.equal(h.state.commands.length, 0);
  }
});
test("CI remotely validates exact source and attempt recorded by evidence", async (t) => {
  for (const patch of [
    { head_sha: "b".repeat(40) },
    { run_attempt: 4 },
    { conclusion: "failure" },
    { event: "pull_request" },
  ]) {
    const h = await harness(t);
    Object.assign(h.state.ci, patch);
    await rejected(h, "ci");
    assert.equal(h.state.commands.length, 0);
  }
  const h = await harness(t);
  h.state.ciJobs.jobs[0].conclusion = "skipped";
  await rejected(h, "ci");
});
test("registry accepts only one source-backed linux/amd64 manifest with exact ref/digest/config", () => {
  const value = release();
  const ref = value.manifest.api;
  const id = value.evidence.verified.images.api.id;
  for (const oci of [false, true])
    assert.deepEqual(validateRegistryManifest(JSON.stringify(registry(ref, id, oci)), ref, id), {
      reference: ref,
      imageId: id,
      platform: "linux/amd64",
    });
  for (const mutation of [
    "array",
    "ref",
    "digest",
    "config",
    "os",
    "arch",
    "index",
    "both",
    "null",
    "version",
    "media",
  ]) {
    let v = registry(ref, id);
    if (mutation === "array") v = [v];
    if (mutation === "null") v = null;
    if (mutation === "ref") v.Ref = ref.replace("markiro-api", "other");
    if (mutation === "digest") v.Descriptor.digest = digest("f");
    if (mutation === "config") v.SchemaV2Manifest.config.digest = digest("f");
    if (mutation === "os") v.Descriptor.platform.os = "windows";
    if (mutation === "arch") v.Descriptor.platform.architecture = "arm64";
    if (mutation === "index") v.Descriptor.mediaType = "application/vnd.oci.image.index.v1+json";
    if (mutation === "both") v.OCIManifest = v.SchemaV2Manifest;
    if (mutation === "version") v.SchemaV2Manifest.schemaVersion = 1;
    if (mutation === "media")
      v.SchemaV2Manifest.mediaType = "application/vnd.oci.image.index.v1+json";
    assert.throws(() => validateRegistryManifest(JSON.stringify(v), ref, id), undefined, mutation);
  }
});
test("registry mismatch or command failure leaves no record or raw diagnostics", async (t) => {
  for (const kind of ["mismatch", "throw"]) {
    const h = await harness(t);
    h.adapters.run = async () => {
      if (kind === "throw") throw new Error(rawSecret + token);
      return JSON.stringify(registry(release().manifest.api, digest("f")));
    };
    await rejected(h, "registry");
  }
});
test("registry process receives no GitHub token environment or credential arguments", async () => {
  const saved = process.env.GH_TOKEN;
  process.env.GH_TOKEN = token;
  try {
    await inspectRegistryImage(
      release().manifest.api,
      release().evidence.verified.images.api.id,
      async (command, args, options) => {
        assert.equal(options.env.GH_TOKEN, undefined);
        assert.equal(options.env.GITHUB_TOKEN, undefined);
        assert.ok(options.timeout > 0);
        assert.ok(options.maxBuffer > 0);
        assert.ok(!JSON.stringify(args).includes(token));
        return JSON.stringify(registry(args[3], release().evidence.verified.images.api.id));
      },
    );
  } finally {
    if (saved === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = saved;
  }
});
test("existing output including symlink is preserved and no request is made", async (t) => {
  for (const kind of ["file", "link", "directory"]) {
    const h = await harness(t);
    if (kind === "file") await fs.writeFile(h.input.outputFile, "keep");
    if (kind === "link") await fs.symlink(join(h.dir, "missing"), h.input.outputFile);
    if (kind === "directory") await fs.mkdir(h.input.outputFile);
    await assert.rejects(admitPlatformRelease(h.input, h.adapters), {
      message: "platform admission failed: output",
    });
    assert.equal(h.state.calls.length, 0);
    assert.ok(await fs.lstat(h.input.outputFile));
    if (kind === "file") assert.equal(await fs.readFile(h.input.outputFile, "utf8"), "keep");
  }
});
test("exclusive output handles concurrent destination creation without replacing it", async (t) => {
  const h = await harness(t);
  const run = h.adapters.run;
  h.adapters.run = async (...args) => {
    await fs.writeFile(h.input.outputFile, "concurrent");
    return run(...args);
  };
  await assert.rejects(admitPlatformRelease(h.input, h.adapters), {
    message: "platform admission failed: output",
  });
  assert.equal(await fs.readFile(h.input.outputFile, "utf8"), "concurrent");
});
test("real CLI subprocess masks tokens, raw upstream exceptions and paths", async (t) => {
  const dir = await temporary(t);
  const stub = join(dir, "fetch-stub.mjs");
  await fs.writeFile(
    stub,
    `globalThis.fetch = async () => { throw new Error(process.env.GH_TOKEN + '${rawSecret}'); };`,
  );
  try {
    await exec(
      process.execPath,
      [
        "--import",
        stub,
        resolve("deploy/platform/admit-release.mjs"),
        expected.sourceSha,
        "456",
        "2",
        "789",
        join(dir, "record"),
      ],
      { env: { ...process.env, GH_TOKEN: token } },
    );
    assert.fail("must fail");
  } catch (error) {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.equal(error.stderr, "platform admission failed: publisher\n");
    assert.ok(!error.stderr.includes(token));
    assert.ok(!error.stderr.includes(rawSecret));
  }
  await assert.rejects(fs.lstat(join(dir, "record")), { code: "ENOENT" });
});

test("artifact expiration must be a real calendar timestamp", async (t) => {
  const h = await harness(t);
  h.state.metadata.expires_at = "2099-02-30T00:00:00Z";
  await rejected(h, "artifact");
});

test("successful newer CI attempt cannot replace the attempt in release evidence", async (t) => {
  const h = await harness(t);
  h.state.ci.run_attempt = 4;
  const rerun = structuredClone(h.state.ci);
  h.state.override = async (url) => {
    if (url === `${base}/runs/123/attempts/4`) return response(rerun);
    if (url === `${base}/runs/123/attempts/4/jobs?per_page=100&page=1`)
      return response(jobs(rerun, ["production-bundle", "ci-required"]));
  };
  await rejected(h, "ci");
  assert.equal(h.state.commands.length, 0);
});

test("partial output write failure removes only the newly created record", async (t) => {
  const h = await harness(t);
  const open = fs.open.bind(fs);
  t.mock.method(fs, "open", async (path, ...args) => {
    const handle = await open(path, ...args);
    if (path === h.input.outputFile) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async () => {
        await write("partial");
        throw new Error(rawSecret);
      };
    }
    return handle;
  });
  await rejected(h, "output");
});

test("cleanup failure reports its phase and never writes a record", async (t) => {
  const h = await harness(t);
  const rm = fs.rm.bind(fs);
  let failed = false;
  t.mock.method(fs, "rm", async (path, options) => {
    if (String(path).includes("platform-admission-") && !failed) {
      failed = true;
      throw new Error(rawSecret);
    }
    return rm(path, options);
  });
  await rejected(h, "cleanup");
});

test("default parser accepts actual upload-artifact Unix permissions and data descriptors", async (t) => {
  const dir = await temporary(t);
  const file = join(dir, "descriptor.zip");
  const script = `import io,json,sys,zipfile\nclass Stream(io.BytesIO):\n def seek(self, *args): raise OSError()\nb=Stream()\nwith zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as z:\n for e in json.loads(sys.argv[2]):\n  i=zipfile.ZipInfo(e['name']); i.compress_type=8; i.external_attr=0o100600<<16; z.writestr(i,e['text'])\nopen(sys.argv[1],'wb').write(b.getvalue())\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert all(i.flag_bits==8 for i in z.infolist())\n`;
  await exec("python3", ["-I", "-c", script, file, JSON.stringify(entries())]);
  assert.deepEqual(await extractReleaseZip(file), {
    manifestText: JSON.stringify(release().manifest),
    evidenceText: JSON.stringify(release().evidence),
  });
});

test("registry rejects ambiguous top-level manifest payloads instead of guessing", () => {
  const ref = release().manifest.api;
  const id = release().evidence.verified.images.api.id;
  const value = registry(ref, id);
  value.manifests = [];
  assert.throws(() => validateRegistryManifest(JSON.stringify(value), ref, id));
});
