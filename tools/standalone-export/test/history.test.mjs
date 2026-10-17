import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileChecksum } from "../canonical.mjs";
import { writeHistory, MAX_HISTORY_PART_BYTES, MAX_HISTORY_PART_ROWS } from "../history.mjs";

const fixture = new URL(
  "../../../apps/standalone/proto/fixtures/cloud-history.jsonl",
  import.meta.url,
);
async function golden() {
  return (await readFile(fixture, "utf8")).trim().split("\n").map(JSON.parse);
}
async function* rows(lines) {
  const [manifest, ...parts] = lines;
  yield {
    type: "metadata",
    value: { source: manifest.source, organization: manifest.organization, clean: true },
  };
  for (const part of parts)
    for (const [type, values] of Object.entries(part.payload))
      for (const value of values) yield { type, value };
}
async function workspace(run) {
  const dir = await mkdtemp(join(tmpdir(), "history-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("the streaming writer matches the golden contract with GS1 and flat-only codes", async () =>
  workspace(async (dir) => {
    const lines = await golden();
    const path = join(dir, "history.jsonl");
    const manifest = await writeHistory(path, rows(lines), {
      exportedAt: lines[0].exportedAt,
      since: lines[0].since,
    });
    assert.deepEqual((await readFile(path, "utf8")).trim().split("\n").map(JSON.parse), lines);
    assert.equal(manifest.checksum, fileChecksum(manifest));
    assert.ok(lines[1].payload.codes.some((code) => code.flatOnly));
    assert.ok(lines[1].payload.codes[0].canonical.includes("\u001d"));
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(
      writeHistory(path, rows(lines), { exportedAt: lines[0].exportedAt, since: lines[0].since }),
      { code: "EEXIST" },
    );
    assert.deepEqual(await readdir(dir), ["history.jsonl"]);
  }));

test("the database snapshot supplies the exact export instant and default window", async () =>
  workspace(async (dir) => {
    const [manifest] = await golden();
    async function* input() {
      yield {
        type: "metadata",
        value: {
          source: manifest.source,
          organization: manifest.organization,
          clean: true,
          exportedAt: "2024-02-29T10:00:00.123456Z",
          since: "2023-02-28",
        },
      };
    }
    const output = await writeHistory(join(dir, "snapshot.jsonl"), input(), {
      exportedAt: "2024-03-01T00:00:00.000Z",
    });
    assert.equal(output.exportedAt, "2024-02-29T10:00:00.123456Z");
    assert.equal(output.since, "2023-02-28");
  }));
test("parts honor both byte and row ceilings, include checksum bytes and allow empty history", async () =>
  workspace(async (dir) => {
    const [manifest, part] = await golden();
    async function* many() {
      yield {
        type: "metadata",
        value: { source: manifest.source, organization: manifest.organization, clean: true },
      };
      for (let i = 0; i < MAX_HISTORY_PART_ROWS + 1; i++)
        yield {
          type: "owners",
          value: { ...part.payload.owners[0], hash: i.toString(16).padStart(64, "0") },
        };
    }
    const result = await writeHistory(join(dir, "many.jsonl"), many(), manifest);
    assert.equal(result.parts.length, 2);
    for (const line of (await readFile(join(dir, "many.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .slice(1))
      assert.ok(Buffer.byteLength(line) <= MAX_HISTORY_PART_BYTES);
    const empty = [
      manifest,
      { payload: { shifts: [], codes: [], boxes: [], items: [], pallets: [], owners: [] } },
    ];
    assert.equal(
      (await writeHistory(join(dir, "empty.jsonl"), rows(empty), manifest)).parts.length,
      1,
    );
    async function* wide() {
      yield {
        type: "metadata",
        value: { source: manifest.source, organization: manifest.organization, clean: true },
      };
      for (let i = 0; i < 6; i++)
        yield {
          type: "shifts",
          value: { ...part.payload.shifts[0], productName: "я".repeat(500_000) },
        };
    }
    assert.ok((await writeHistory(join(dir, "wide.jsonl"), wide(), manifest)).parts.length > 1);
  }));
test("bad rows, non-clean metadata and interrupted streams never publish a partial file or values", async () =>
  workspace(async (dir) => {
    const lines = await golden();
    for (const bad of [
      [
        {
          type: "metadata",
          value: { source: lines[0].source, organization: lines[0].organization, clean: false },
        },
      ],
      [
        {
          type: "metadata",
          value: { source: lines[0].source, organization: lines[0].organization, clean: true },
        },
        { type: "codes", value: { ...lines[1].payload.codes[0], canonical: null } },
      ],
      [
        {
          type: "metadata",
          value: { source: lines[0].source, organization: lines[0].organization, clean: true },
        },
        {
          type: "shifts",
          value: {
            ...lines[1].payload.shifts[0],
            productName: "PRIVATE".repeat(MAX_HISTORY_PART_BYTES),
          },
        },
      ],
    ]) {
      async function* input() {
        yield* bad;
      }
      await assert.rejects(
        writeHistory(join(dir, "bad.jsonl"), input(), lines[0]),
        (error) => !error.message.includes("PRIVATE"),
      );
      assert.deepEqual(await readdir(dir), []);
    }
    async function* interrupted() {
      yield* rows(lines);
      throw new Error("private raw database error");
    }
    await assert.rejects(writeHistory(join(dir, "bad.jsonl"), interrupted(), lines[0]));
    assert.deepEqual(await readdir(dir), []);
  }));
