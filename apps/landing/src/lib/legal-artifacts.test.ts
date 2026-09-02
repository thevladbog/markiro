import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadLegalArtifacts } from "./legal-artifacts";

const publicRoot = fileURLToPath(new URL("../../public/", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function copiedPublicRoot(): Promise<string> {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "markiro-landing-artifacts-"));
  roots.push(root);
  await cp(path.join(publicRoot, "legal"), path.join(root, "legal"), { recursive: true });
  return root;
}

async function editManifest(root: string, mutate: (manifest: unknown[]) => void): Promise<void> {
  const manifestPath = path.join(root, "legal", "artifacts.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown[];
  mutate(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("loadLegalArtifacts", () => {
  it("loads the complete release set and verifies current bytes and hashes", async () => {
    const artifacts = await loadLegalArtifacts(publicRoot);

    expect(artifacts).toHaveLength(26);
    expect(artifacts.filter(({ kind }) => kind === "pdfa-2b")).toHaveLength(22);
    expect(artifacts.filter(({ kind }) => kind === "template-docx")).toHaveLength(4);
    expect(artifacts.every(({ href }) => href.startsWith("/legal/files/"))).toBe(true);
    // The current dash-separated naming scheme (period-sequence); the period
    // moves with new series (MKR-INS-09 opened 2026.09) and the sequence
    // varies once a document is reissued, so both stay generalized.
    expect(
      artifacts.every(({ fileName }) => /_\d{4}\.\d{2}-\d{2}_(?:ru|en)\./.test(fileName)),
    ).toBe(true);
    expect(artifacts.every(({ fileName }) => !/_\d{4}\.\d{2}\.\d{2}_/.test(fileName))).toBe(true);
  });

  it.each([
    ["path separator", "../outside.pdf", "fileName"],
    ["wrong PDF media type", "text/plain", "mediaType"],
    ["invalid digest", "0".repeat(64), "sha256"],
    ["invalid byte count", 1, "bytes"],
  ] as const)("rejects %s", async (_label, value, field) => {
    const root = await copiedPublicRoot();
    await editManifest(root, (manifest) => {
      Object.assign(manifest[0] as object, { [field]: value });
    });

    await expect(loadLegalArtifacts(root)).rejects.toThrow(/artifact/i);
  });

  it("rejects a missing artifact", async () => {
    const root = await copiedPublicRoot();
    const manifest = JSON.parse(
      await readFile(path.join(root, "legal", "artifacts.json"), "utf8"),
    ) as { fileName: string }[];
    await rm(path.join(root, "legal", "files", manifest[0]!.fileName));

    await expect(loadLegalArtifacts(root)).rejects.toThrow(/artifact/i);
  });

  it("rejects an artifact symlink even when it resolves inside the files directory", async () => {
    const root = await copiedPublicRoot();
    const manifest = JSON.parse(
      await readFile(path.join(root, "legal", "artifacts.json"), "utf8"),
    ) as { fileName: string }[];
    const artifactPath = path.join(root, "legal", "files", manifest[0]!.fileName);
    const copyPath = `${artifactPath}.copy`;
    await cp(artifactPath, copyPath);
    await rm(artifactPath);
    await symlink(path.basename(copyPath), artifactPath);
    expect((await lstat(artifactPath)).isSymbolicLink()).toBe(true);

    await expect(loadLegalArtifacts(root)).rejects.toThrow(/symbolic link/i);
  });

  it("rejects a public root that is itself a symbolic link", async () => {
    const root = await copiedPublicRoot();
    const alias = `${root}-alias`;
    roots.push(alias);
    await symlink(root, alias);

    await expect(loadLegalArtifacts(alias)).rejects.toThrow(/symbolic link/i);
  });

  it("rejects a symbolic-link ancestor before opening the manifest", async () => {
    const root = await copiedPublicRoot();
    const ancestorRoot = await mkdtemp(
      path.join(await realpath(tmpdir()), "markiro-landing-ancestor-"),
    );
    roots.push(ancestorRoot);
    const alias = path.join(ancestorRoot, "public-parent");
    await symlink(root, alias);

    await expect(loadLegalArtifacts(path.join(alias, "."))).rejects.toThrow(/symbolic link/i);
  });

  it.each(["file", "directory", "symlink"] as const)(
    "rejects an extra %s in /legal/files",
    async (entryKind) => {
      const root = await copiedPublicRoot();
      const filesRoot = path.join(root, "legal", "files");
      const extra = path.join(filesRoot, `unlisted-${entryKind}`);
      if (entryKind === "file") await writeFile(extra, "unlisted");
      else if (entryKind === "directory") await mkdir(extra);
      else await symlink("markiro_mkr-pd-01_2026.08-01_ru.pdf", extra);

      await expect(loadLegalArtifacts(root)).rejects.toThrow(/unlisted|entry|manifest/i);
    },
  );

  it("rejects an English artifact for a Russian-only instruction", async () => {
    // MKR-INS-06 is a cabinet instruction outside INSTRUCTION_EN_PUBLISHED;
    // the station instructions (01-05) now legitimately publish English.
    const root = await copiedPublicRoot();
    await editManifest(root, (manifest) => {
      manifest.push({
        code: "MKR-INS-06",
        revision: "2026.08/03",
        effectiveDate: "2026-09-01",
        locale: "en",
        kind: "pdfa-2b",
        fileName: "markiro_mkr-ins-06_2026.08-03_en.pdf",
        bytes: 1,
        sha256: "0".repeat(64),
        mediaType: "application/pdf",
        generator: { docx: "9.7.1", libreOffice: "26.2.5", veraPdf: "1.30.2" },
      });
    });

    await expect(loadLegalArtifacts(root)).rejects.toThrow(/locale is not published/);
  });
});
