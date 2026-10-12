import fs from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createUsRequestBuildFixture } from "./support/us-request-build-fixture";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

describe("owned US request build fixture acquisition", () => {
  it("removes its actual root and rethrows the original acquisition failure", async () => {
    const sibling = await fs.mkdtemp(join(tmpdir(), "us-request-build-sibling-"));
    const original = new Error("Synthetic fixture write failure");
    let ownedRoot: string | undefined;
    const write = vi.mocked(writeFile).mockImplementationOnce(async (path) => {
      ownedRoot = dirname(String(path));
      throw original;
    });
    try {
      await expect(createUsRequestBuildFixture()).rejects.toBe(original);
      expect(ownedRoot).toBeDefined();
      if (!ownedRoot) throw new Error("Missing actual owned fixture root");
      await expect(fs.access(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(sibling)).resolves.toBeUndefined();
    } finally {
      write.mockReset().mockImplementation(fs.writeFile);
      if (ownedRoot) await fs.rm(ownedRoot, { recursive: true, force: true });
      await fs.rm(sibling, { recursive: true, force: true });
    }
  });

  it("keeps acquired files alive until its returned disposer removes the root", async () => {
    const fixture = await createUsRequestBuildFixture();
    try {
      await expect(fs.readFile(fixture.roots.lockfile, "utf8")).resolves.toBe("fixture lock\n");
      await expect(
        fs.readFile(join(fixture.roots.trees.api, "main.us-request-worker.js"), "utf8"),
      ).resolves.toBe("fixture worker\n");
      await fixture.writeDocument({ acquired: true });
      await expect(fs.readFile(fixture.descriptorPath, "utf8")).resolves.toBe('{"acquired":true}');
      await fixture.dispose();
      await expect(fs.access(fixture.root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.dispose();
    }
  });
});
