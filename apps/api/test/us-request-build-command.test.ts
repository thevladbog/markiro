import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadUsRequestBuildDescriptor } from "../src/deployment/us-request-build-descriptor";
import { createUsRequestBuildFixture, localBuildEnv } from "./support/us-request-build-fixture";

describe("actual local worker build command", () => {
  it("captures Git HEAD and package version, then truthfully records an untracked input", async () => {
    const fixture = await createUsRequestBuildFixture();
    try {
      const sha = fixture.initializeGit();
      const run = () =>
        execFileSync(process.execPath, [resolve("scripts/build-us-request-worker.mjs")], {
          cwd: fixture.api,
          env: {
            ...process.env,
            API_VERSION: "forged-version",
            GIT_SHA: "b".repeat(40),
            SOURCE_VERSION: "c".repeat(40),
          },
          encoding: "utf8",
        });
      run();
      const clean: unknown = JSON.parse(await readFile(fixture.descriptorPath, "utf8"));
      expect(clean).toMatchObject({
        build: { apiVersion: "fixture-1", gitSha: sha, dirty: false },
      });
      const source = {
        ...(await localBuildEnv()),
        API_VERSION: "ignored",
        GIT_SHA: "d".repeat(40),
        US_REQUEST_BUILD_DESCRIPTOR_PATH: "/forbidden",
      };
      expect((await loadUsRequestBuildDescriptor(source, fixture.roots)).document.build).toEqual({
        apiVersion: "fixture-1",
        gitSha: sha,
        dirty: false,
      });
      run();
      expect(JSON.parse(await readFile(fixture.descriptorPath, "utf8"))).toMatchObject({
        build: { dirty: false },
      });
      await writeFile(resolve(fixture.root, "input.ts"), "synthetic new source\n");
      run();
      const dirty: unknown = JSON.parse(await readFile(fixture.descriptorPath, "utf8"));
      expect(dirty).toMatchObject({ build: { apiVersion: "fixture-1", gitSha: sha, dirty: true } });
      expect(JSON.stringify(dirty)).not.toContain("forged-version");
      expect(JSON.stringify(dirty)).not.toContain("synthetic new source");
      await expect(loadUsRequestBuildDescriptor(source, fixture.roots)).rejects.toThrow(
        "us_request_build_invalid",
      );
    } finally {
      await fixture.dispose();
    }
  });
  it("records tracked source changes and refuses invalid arguments without raw errors", async () => {
    const fixture = await createUsRequestBuildFixture();
    try {
      fixture.initializeGit();
      await writeFile(
        resolve(fixture.api, "package.json"),
        JSON.stringify({ name: "@markiro/api", version: "fixture-2" }),
      );
      execFileSync(process.execPath, [resolve("scripts/build-us-request-worker.mjs")], {
        cwd: fixture.api,
      });
      expect(JSON.parse(await readFile(fixture.descriptorPath, "utf8"))).toMatchObject({
        build: { apiVersion: "fixture-2", dirty: true },
      });
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync(
        process.execPath,
        [resolve("scripts/build-us-request-worker.mjs"), "--descriptor=/forbidden"],
        { cwd: fixture.api, encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("us_request_build_invalid\n");
      expect(result.stdout).toBe("");
    } finally {
      await fixture.dispose();
    }
  });
});
