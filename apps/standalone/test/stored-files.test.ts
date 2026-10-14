import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import { EXPORT_FILE_CHUNK_BYTES, type ExportFile } from "../src/host/export-files.js";
import {
  decodeBase64,
  encodeBase64,
  fetchStoredFile,
  partFileId,
  sha256Hex,
  StoredFileMismatchError,
  storeExportFiles,
  type StoreRequest,
} from "../src/office/exports/stored-files.js";
import { fakeHostApi, type FakeHostApi } from "./support/office.js";

const BATCH = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";
const SHIFT = "c0000000-0000-4000-8000-000000000001";

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Bytes that are not a pattern: every offset differs. */
function noise(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let x = 123456789;
  for (let at = 0; at < length; at += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[at] = x & 0xff;
  }
  return bytes;
}

function session(api: FakeHostApi = fakeHostApi()) {
  return { api, call: <T>(operation: (token: string) => Promise<T>) => operation("token") };
}

function request(parts: StoreRequest["parts"]): StoreRequest {
  return {
    kind: "shift_export",
    targetType: "shift",
    targetId: SHIFT,
    batchId: BATCH,
    formatId: "shift_txt_flat",
    formatVersion: 1,
    parts,
  };
}

describe("the bytes on the wire", () => {
  it("round-trip through base64, blocks of any size and every byte value", () => {
    const bytes = noise(0x8000 * 2 + 17);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    expect(encodeBase64(new Uint8Array([0, 255, 128]))).toBe(
      Buffer.from([0, 255, 128]).toString("base64"),
    );
    expect(encodeBase64(new Uint8Array())).toBe("");
  });

  it("have the SHA-256 the host computes, in lower-case hex", async () => {
    const bytes = new TextEncoder().encode("hello");
    expect(await sha256Hex(bytes)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    // A view into a bigger buffer is hashed by its own bytes only.
    const wide = new Uint8Array([9, 9, ...bytes, 9]);
    expect(await sha256Hex(wide.subarray(2, 7))).toBe(await sha256Hex(bytes));
  });

  it("name a part's file by its batch and number, the same every time, as a UUID", async () => {
    const id = await partFileId(BATCH, 3);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await partFileId(BATCH, 3)).toBe(id);
    expect(await partFileId(BATCH, 4)).not.toBe(id);
  });
});

describe("storeExportFiles", () => {
  it("sends a file of one chunk whole in the call that starts it, with its own SHA-256", async () => {
    const api = fakeHostApi();
    const bytes = new TextEncoder().encode("<a>Привет</a>");
    const outcome = await storeExportFiles(
      session(api),
      request([{ partNo: 1, name: "Отчет_1.xml", bytes }]),
    );
    expect(outcome.ok).toBe(true);
    expect(api.beginExportFile).toHaveBeenCalledTimes(1);
    const begin = api.beginExportFile.mock.calls[0]?.[1];
    expect(begin).toMatchObject({
      batchId: BATCH,
      partNo: 1,
      kind: "shift_export",
      targetType: "shift",
      targetId: SHIFT,
      formatId: "shift_txt_flat",
      formatVersion: 1,
      fileName: "Отчет_1.xml",
      sizeBytes: bytes.length,
      sha256: sha(bytes),
    });
    expect([...decodeBase64(begin?.contentBase64 ?? "")]).toEqual([...bytes]);
    expect(begin?.generator).toMatch(/^markiro-autonom /);
    expect(api.putExportFileChunk).not.toHaveBeenCalled();
    expect(api.completeExportFile).not.toHaveBeenCalled();
  });

  it("sends a larger file by chunks of 1 MiB in order and seals it", async () => {
    const api = fakeHostApi();
    const bytes = noise(EXPORT_FILE_CHUNK_BYTES * 2 + 5);
    const outcome = await storeExportFiles(
      session(api),
      request([{ partNo: 1, name: "a.xml", bytes }]),
    );
    expect(outcome.ok).toBe(true);
    const begin = api.beginExportFile.mock.calls[0]?.[1];
    expect(begin?.contentBase64).toBeUndefined();
    expect(begin?.sizeBytes).toBe(bytes.length);
    expect(api.putExportFileChunk.mock.calls.map((call) => call[2])).toEqual([0, 1, 2]);
    const sent = api.putExportFileChunk.mock.calls.flatMap((call) => [...decodeBase64(call[3])]);
    expect(Uint8Array.from(sent)).toEqual(bytes);
    expect(api.completeExportFile).toHaveBeenCalledTimes(1);
    // Chunks go before the seal.
    expect(api.putExportFileChunk.mock.invocationCallOrder.at(-1)).toBeLessThan(
      api.completeExportFile.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("goes on from the chunk the host already holds", async () => {
    const api = fakeHostApi();
    api.beginExportFile.mockImplementation(async (_token, begin) => ({
      id: begin.id,
      chunkCount: 3,
      receivedChunks: 2,
      ready: false,
    }));
    const bytes = noise(EXPORT_FILE_CHUNK_BYTES * 2 + 5);
    await storeExportFiles(session(api), request([{ partNo: 1, name: "a.xml", bytes }]));
    expect(api.putExportFileChunk.mock.calls.map((call) => call[2])).toEqual([2]);
  });

  it("sends a chunk again once after a lost call, and not at all after the host's refusal", async () => {
    const lost = new HostError({ kind: "transport", code: "unreachable", message: "x" });
    const refusal = new HostError({
      kind: "api",
      code: "export_store_full",
      message: "full",
      status: 507,
      details: {},
    });
    const bytes = noise(EXPORT_FILE_CHUNK_BYTES + 1);
    const flaky = fakeHostApi();
    flaky.putExportFileChunk.mockRejectedValueOnce(lost);
    expect(
      (await storeExportFiles(session(flaky), request([{ partNo: 1, name: "a.xml", bytes }]))).ok,
    ).toBe(true);
    expect(flaky.putExportFileChunk).toHaveBeenCalledTimes(3);

    const full = fakeHostApi();
    full.putExportFileChunk.mockRejectedValue(refusal);
    const outcome = await storeExportFiles(
      session(full),
      request([{ partNo: 1, name: "a.xml", bytes }]),
    );
    expect(outcome).toEqual({
      ok: false,
      reason: "host",
      messageKey: "errors.api.export_store_full",
      stored: 0,
    });
    expect(full.putExportFileChunk).toHaveBeenCalledTimes(1);
    expect(full.completeExportFile).not.toHaveBeenCalled();
  });

  it("stops at the first part the host refuses and says how many it stored", async () => {
    const api = fakeHostApi();
    api.beginExportFile.mockImplementationOnce(async (_token, begin) => ({
      id: begin.id,
      chunkCount: 1,
      receivedChunks: 1,
      ready: true,
    }));
    api.beginExportFile.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    const parts = [1, 2, 3].map((partNo) => ({
      partNo,
      name: `a${partNo}.xml`,
      bytes: new TextEncoder().encode(`part ${partNo}`),
    }));
    const outcome = await storeExportFiles(session(api), request(parts));
    expect(outcome).toMatchObject({ ok: false, reason: "host", stored: 1 });
    expect(api.beginExportFile).toHaveBeenCalledTimes(2);
  });

  it("sends nothing of an export of more parts than the host stores", async () => {
    const api = fakeHostApi();
    const parts = Array.from({ length: 1001 }, (_, index) => ({
      partNo: index + 1,
      name: `a${index}.xml`,
      bytes: new Uint8Array([1]),
    }));
    expect(await storeExportFiles(session(api), request(parts))).toEqual({
      ok: false,
      reason: "too_many_parts",
      messageKey: "office.storedFiles.tooManyParts",
    });
    expect(api.beginExportFile).not.toHaveBeenCalled();
  });
});

describe("fetchStoredFile", () => {
  function stored(bytes: Uint8Array): Pick<ExportFile, "id" | "sha256" | "sizeBytes"> {
    return {
      id: "7a1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8",
      sha256: sha(bytes),
      sizeBytes: bytes.length,
    };
  }

  function serving(bytes: Uint8Array, claimed = stored(bytes)) {
    const api = fakeHostApi();
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += EXPORT_FILE_CHUNK_BYTES) {
      chunks.push(bytes.subarray(at, at + EXPORT_FILE_CHUNK_BYTES));
    }
    api.openExportFileDownload.mockResolvedValue({
      file: {
        ...claimed,
        batchId: BATCH,
        partNo: 1,
        kind: "shift_export",
        targetType: "shift",
        targetId: SHIFT,
        shiftId: SHIFT,
        formatId: "shift_txt_flat",
        formatVersion: 1,
        fileName: "a.txt",
        mediaType: "text/plain; charset=utf-8",
        generator: "g",
        createdAt: "2026-10-08T07:30:00Z",
        userName: null,
      },
      chunkCount: chunks.length,
    });
    api.getExportFileChunk.mockImplementation(async (_token, _id, seq) => ({
      contentBase64: encodeBase64(chunks[seq] ?? new Uint8Array()),
    }));
    return api;
  }

  it("gives back the exact bytes of a file of several chunks", async () => {
    const bytes = noise(EXPORT_FILE_CHUNK_BYTES * 2 + 123);
    const api = serving(bytes);
    const got = await fetchStoredFile(session(api), stored(bytes));
    expect(got).toEqual(bytes);
    expect(api.getExportFileChunk.mock.calls.map((call) => call[2])).toEqual([0, 1, 2]);
  });

  it("refuses bytes whose SHA-256 is not the stored one, and says nothing was saved", async () => {
    const bytes = noise(1000);
    const tampered = bytes.slice();
    tampered.set([(tampered[10] ?? 0) ^ 1], 10);
    const api = serving(tampered, stored(bytes));
    await expect(fetchStoredFile(session(api), stored(bytes))).rejects.toBeInstanceOf(
      StoredFileMismatchError,
    );
  });

  it("refuses bytes of another size", async () => {
    const bytes = noise(1000);
    const api = serving(bytes.subarray(0, 900), stored(bytes));
    await expect(fetchStoredFile(session(api), stored(bytes))).rejects.toBeInstanceOf(
      StoredFileMismatchError,
    );
  });

  it("lets the host's own refusal of a damaged file through", async () => {
    const api = fakeHostApi();
    const refusal = new HostError({
      kind: "api",
      code: "export_file_corrupted",
      message: "x",
      status: 500,
      details: {},
    });
    api.openExportFileDownload.mockRejectedValue(refusal);
    await expect(fetchStoredFile(session(api), stored(noise(10)))).rejects.toBe(refusal);
    expect(api.getExportFileChunk).not.toHaveBeenCalled();
  });
});
