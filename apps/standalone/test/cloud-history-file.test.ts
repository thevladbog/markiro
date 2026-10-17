import { readFileSync } from "node:fs";
import { kmHash, parseKm } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import {
  cloudHistoryManifestSchema,
  cloudHistoryPartSchema,
  readCloudHistoryFile,
  cloudHistoryChecksum,
  MAX_HISTORY_PART_BYTES,
  MAX_HISTORY_MANIFEST_BYTES,
  cloudHistoryImportStateSchema,
} from "../src/host/cloud-history.js";

const testModuleUrl = import.meta.url;
const text = () =>
  readFileSync(new URL("../proto/fixtures/cloud-history.jsonl", testModuleUrl), "utf8");
async function* chunks(value: string) {
  const bytes = new TextEncoder().encode(value);
  for (let i = 0; i < bytes.length; i += 37) yield bytes.slice(i, i + 37);
}
describe("history file", () => {
  it("streams the shared golden, preserving nullable metadata, GS1 and reprocessing", async () => {
    const rows = [];
    for await (const record of readCloudHistoryFile(chunks(text()))) rows.push(record);
    expect(rows).toHaveLength(2);
    const manifest = cloudHistoryManifestSchema.parse(rows[0]);
    const part = cloudHistoryPartSchema.parse(rows[1]);
    expect(await cloudHistoryChecksum(manifest)).toBe(manifest.checksum);
    expect(part.payload.codes[0]?.canonical).toContain("\u001d");
    expect(part.payload.codes[1]?.flatOnly).toBe(true);
    expect(part.payload.shifts[0]?.plannedDate).toBeNull();
    expect(part.payload.shifts[0]?.shelfLifeDays).toBe(30);
    expect(part.payload.pallets[0]).toMatchObject({
      productName: "Milk",
      gtin14: "04600682000013",
      shelfLifeDays: 30,
    });
    for (const code of part.payload.codes) expect(kmHash(parseKm(code.canonical))).toBe(code.hash);
  });
  it("handles multibyte characters split at every UTF-8 byte", async () => {
    const [manifestLine, partLine] = text().trim().split("\n");
    const manifest = cloudHistoryManifestSchema.parse(JSON.parse(manifestLine ?? ""));
    manifest.source.tenantName = "Молоко🍶";
    manifest.checksum = await cloudHistoryChecksum(manifest);
    async function* oneByte() {
      for (const byte of new TextEncoder().encode(
        JSON.stringify(manifest) + "\n" + partLine + "\n",
      ))
        yield Uint8Array.of(byte);
    }
    const records = [];
    for await (const record of readCloudHistoryFile(oneByte())) records.push(record);
    expect(cloudHistoryManifestSchema.parse(records[0]).source.tenantName).toBe("Молоко🍶");
  });
  it("rejects tampering, unknown fields, wrong counts and trailing/missing parts without values", async () => {
    const lines = text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const value of [
      text().replace("Milk", "PRIVATE"),
      text().split("\n")[0] ?? "",
      text() + text().split("\n")[1] + "\n",
      "PRIVATE",
    ]) {
      await expect(async () => {
        for await (const record of readCloudHistoryFile(chunks(value))) {
          void record;
        }
      }).rejects.toThrow(/^history_/);
    }
    expect(cloudHistoryManifestSchema.safeParse({ ...lines[0], extra: true }).success).toBe(false);
    expect(cloudHistoryManifestSchema.safeParse({ ...lines[0], since: "2025-02-29" }).success).toBe(
      false,
    );
  });
  it("rejects actual part row-count mismatch even with every checksum recomputed", async () => {
    const [manifestLine, partLine] = text().trim().split("\n");
    const manifest = cloudHistoryManifestSchema.parse(JSON.parse(manifestLine ?? ""));
    const part = cloudHistoryPartSchema.parse(JSON.parse(partLine ?? ""));
    part.payload.codes.pop();
    part.checksum = await cloudHistoryChecksum(part);
    const summary = manifest.parts[0];
    if (summary === undefined) throw new Error("fixture summary");
    summary.checksum = part.checksum;
    manifest.checksum = await cloudHistoryChecksum(manifest);
    await expect(async () => {
      for await (const row of readCloudHistoryFile(
        chunks(JSON.stringify(manifest) + "\n" + JSON.stringify(part) + "\n"),
      ))
        void row;
    }).rejects.toThrow("history_part_mismatch");
  });
  it("bounds wire schemas as well as the reader, and validates the resumed index inventory", () => {
    const [manifest, part] = text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      cloudHistoryManifestSchema.safeParse({
        ...manifest,
        source: { tenantId: "tenant", tenantName: "x".repeat(MAX_HISTORY_MANIFEST_BYTES) },
      }).success,
    ).toBe(false);
    const wide = structuredClone(part);
    if (!wide) throw new Error("missing fixture");
    const payload = wide.payload as Record<string, unknown[]>;
    const shifts = payload.shifts;
    if (!shifts?.[0]) throw new Error("missing fixture shift");
    shifts[0] = { ...shifts[0], productName: "я".repeat(MAX_HISTORY_PART_BYTES / 2) };
    expect(cloudHistoryPartSchema.safeParse(wide).success).toBe(false);
    const typed = cloudHistoryManifestSchema.parse(manifest);
    const state = {
      batchId: typed.checksum,
      source: typed.source,
      status: "pending",
      receivedIndices: [1],
      totalParts: 1,
      counts: typed.counts,
    };
    expect(cloudHistoryImportStateSchema.safeParse(state).success).toBe(false);
    expect(
      cloudHistoryImportStateSchema.safeParse({ ...state, receivedIndices: [0, 0] }).success,
    ).toBe(false);
  });
});
