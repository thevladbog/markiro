import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureImages, exportImages, loadImages } from "../release-artifact.mjs";
import { publishImages } from "../release-publish.mjs";
import { releaseIo } from "../release-io.mjs";
import { parsePlatformManifest } from "../release-manifest.mjs";
import { parseReleaseManifest } from "../../production/release-manifest.mjs";

const sha = "a".repeat(40);
const expected = {
  sourceSha: sha,
  toolingSha: sha,
  workflowRunId: "456",
  workflowRunAttempt: "2",
  ciRunId: "123",
  ciRunAttempt: "3",
};
const api = "ghcr.io/thevladbog/markiro-api";
const edge = "ghcr.io/thevladbog/markiro-platform-edge";
const id = (letter) => `sha256:${letter.repeat(64)}`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "platform-release-test-"));
  const directory = join(root, "images");
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const images = new Map([
    [`${api}:${sha}`, id("b")],
    [`${edge}:${sha}`, id("c")],
  ]);
  const io = {
    ...releaseIo,
    run: async (args) => {
      calls.push(args);
      if (args[0] === "image" && args[1] === "inspect") {
        if (args[3] === "{{.Id}}") return images.get(args[4]);
        const repository = args[4].split(":platform-")[0];
        return JSON.stringify([`${repository}@${id(repository === api ? "d" : "e")}`]);
      }
      if (args[0] === "tag") images.set(args[2], args[1]);
      if (args[0] === "save") await writeFile(args[2], "verified docker bytes");
      return "";
    },
  };
  const captured = await captureImages(expected, io);
  await exportImages({ directory, expected, captured }, io);
  const exportCalls = calls.slice();
  calls.length = 0;
  return { directory, calls, images, io, captured, exportCalls };
}

test("exports by captured ID after checking both harness tags; never rebuilds", async (t) => {
  const f = await fixture(t);
  assert.ok(!f.exportCalls.some(([verb]) => verb === "build"));
  assert.deepEqual(
    f.exportCalls.filter(([verb]) => verb === "tag"),
    [
      ["tag", id("b"), `${api}:platform-${sha}-456-2`],
      ["tag", id("c"), `${edge}:platform-${sha}-456-2`],
    ],
  );
  const evidence = JSON.parse(await readFile(join(f.directory, "verified-images.json"), "utf8"));
  assert.equal(evidence.images.api.id, id("b"));
  assert.equal(evidence.images.api.tag, `${api}:platform-${sha}-456-2`);
  assert.equal(evidence.ciRunAttempt, "3");
});

test("changed harness image IDs cannot be exported", async (t) => {
  const f = await fixture(t);
  f.images.set(`${edge}:${sha}`, id("f"));
  await assert.rejects(
    exportImages({ directory: join(f.directory, "changed"), expected, captured: f.captured }, f.io),
  );
  assert.ok(!f.calls.some(([verb]) => ["save", "tag"].includes(verb)));
});

test("invalid evidence, swapped attempt, corrupt and linked archives never load", async (t) => {
  for (const kind of ["evidence", "attempt", "archive", "link", "evidence-link"]) {
    const f = await fixture(t);
    if (kind === "evidence") await writeFile(join(f.directory, "verified-images.json"), "{}");
    if (kind === "archive") await writeFile(join(f.directory, "images.tar"), "different bytes");
    if (kind.endsWith("link")) {
      const path = join(f.directory, kind === "link" ? "images.tar" : "verified-images.json");
      const backup = `${path}.backup`;
      await writeFile(backup, await readFile(path));
      await rm(path);
      await symlink(backup, path);
    }
    await assert.rejects(
      loadImages(
        {
          directory: f.directory,
          expected: kind === "attempt" ? { ...expected, workflowRunAttempt: "3" } : expected,
        },
        f.io,
      ),
    );
    assert.equal(f.calls.length, 0, kind);
  }
});

test("loads checked archive then rejects either changed loaded ID", async (t) => {
  for (const repository of [api, edge]) {
    const f = await fixture(t);
    f.images.set(`${repository}:platform-${sha}-456-2`, id("f"));
    await assert.rejects(loadImages({ ...f, expected }, f.io));
    assert.equal(f.calls[0][0], "load");
    assert.ok(!f.calls.some(([verb]) => verb === "push"));
  }
});

test("publishes exactly checked IDs and binds digest manifest and complete evidence", async (t) => {
  const f = await fixture(t);
  await loadImages({ ...f, expected }, f.io);
  f.calls.length = 0;
  const outputDirectory = join(f.directory, "published");
  await publishImages(
    { ...f, expected, outputDirectory, createdAt: "2026-10-18T00:00:00.000Z" },
    f.io,
  );
  const text = await readFile(join(outputDirectory, "platform-manifest.json"), "utf8");
  const manifest = parsePlatformManifest(text, expected.workflowRunId);
  assert.equal(manifest.api, `${api}@${id("d")}`);
  assert.equal(manifest.edge, `${edge}@${id("e")}`);
  assert.equal(manifest.sourceSha, sha);
  assert.equal(manifest.toolingSha, sha);
  assert.throws(() => parseReleaseManifest(text, expected.workflowRunId));
  const release = JSON.parse(
    await readFile(join(outputDirectory, "release-evidence.json"), "utf8"),
  );
  assert.equal(release.status, "complete");
  assert.equal(release.verified.ciRunId, "123");
  assert.equal(release.verified.workflowRunAttempt, "2");
  assert.deepEqual(
    f.calls.filter(([verb]) => verb === "push"),
    [
      ["push", `${api}:platform-${sha}-456-2`],
      ["push", `${edge}:platform-${sha}-456-2`],
    ],
  );
  assert.ok(!f.calls.some(([verb]) => ["build", "load", "tag"].includes(verb)));
});

test("no push if either local ID changes after load", async (t) => {
  for (const repository of [api, edge]) {
    const f = await fixture(t);
    await loadImages({ ...f, expected }, f.io);
    f.calls.length = 0;
    f.images.set(`${repository}:platform-${sha}-456-2`, id("f"));
    await assert.rejects(
      publishImages({ ...f, expected, outputDirectory: join(f.directory, "published") }, f.io),
    );
    assert.ok(!f.calls.some(([verb]) => verb === "push"));
  }
});

test("either push or digest failure preserves partial evidence without a manifest", async (t) => {
  for (const repository of [api, edge])
    for (const stage of ["push", "digest"]) {
      const f = await fixture(t);
      const run = f.io.run;
      f.io.run = async (args) => {
        if (
          args.at(-1).startsWith(`${repository}:platform-`) &&
          ((stage === "push" && args[0] === "push") ||
            (stage === "digest" && args[3] === "{{json .RepoDigests}}"))
        )
          throw new Error("secret response must not escape");
        return run(args);
      };
      const outputDirectory = join(f.directory, "published");
      await assert.rejects(
        publishImages({ ...f, expected, outputDirectory }, f.io),
        /platform publication failed/,
      );
      await assert.rejects(readFile(join(outputDirectory, "platform-manifest.json")));
      const text = await readFile(join(outputDirectory, "release-evidence.json"), "utf8");
      assert.equal(JSON.parse(text).status, "incomplete");
      assert.ok(!text.includes("secret response"));
    }
});

test("a changed second image between pushes aborts and records only the first push", async (t) => {
  const f = await fixture(t);
  const run = f.io.run;
  f.io.run = async (args) => {
    const result = await run(args);
    if (args[0] === "push") f.images.set(`${edge}:platform-${sha}-456-2`, id("f"));
    return result;
  };
  const outputDirectory = join(f.directory, "published");
  await assert.rejects(publishImages({ ...f, expected, outputDirectory }, f.io));
  assert.equal(f.calls.filter(([verb]) => verb === "push").length, 1);
  const evidence = JSON.parse(
    await readFile(join(outputDirectory, "release-evidence.json"), "utf8"),
  );
  assert.equal(evidence.status, "incomplete");
  assert.deepEqual(Object.keys(evidence.published), ["api"]);
  await assert.rejects(readFile(join(outputDirectory, "platform-manifest.json")));
});

test("publish revalidates archive and rejects stale output directory before pushing", async (t) => {
  for (const kind of ["hash", "output"]) {
    const f = await fixture(t);
    const outputDirectory = kind === "output" ? f.directory : join(f.directory, "published");
    if (kind === "hash") await writeFile(join(f.directory, "images.tar"), "changed");
    await assert.rejects(publishImages({ ...f, expected, outputDirectory }, f.io));
    assert.equal(f.calls.length, 0);
  }
});

test("CLI carries explicit GitHub identity through verify/load/publish and rejects other commands", async (t) => {
  const { main } = await import("../release-images.mjs");
  const f = await fixture(t);
  const env = {
    RELEASE_SHA: sha,
    GITHUB_RUN_ID: "456",
    GITHUB_RUN_ATTEMPT: "2",
    CI_RUN_ID: "123",
    CI_RUN_ATTEMPT: "3",
  };
  await main(["verify", f.directory], env, f.io);
  assert.equal(f.calls.length, 0);
  await main(["load", f.directory], env, f.io);
  await main(["publish", f.directory, join(f.directory, "cli-published")], env, f.io);
  f.calls.length = 0;
  await assert.rejects(main(["load", f.directory], { ...env, GITHUB_RUN_ATTEMPT: "3" }, f.io));
  for (const args of [
    [],
    ["other", f.directory],
    ["load", f.directory, "unexpected"],
    ["export", f.directory],
    ["publish", f.directory],
  ])
    await assert.rejects(main(args, env, f.io));
  assert.equal(f.calls.length, 0);
});
