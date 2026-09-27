import { createHash, webcrypto } from "node:crypto";
import {
  decodeReceivingCsvExport,
  encodeReceivingCsvExport,
  type ReceivingCsvPreviewInput,
} from "@markiro/platform-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { csvInput, csvPreview, csvAck, csvId, csvKey } from "./support/us-receiving-csv-fixture.js";
import { liveDraft } from "./support/us-receiving-command-fixture.js";
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());
const transport = (value: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockResolvedValue(Response.json(value, { status }));
describe("Receiving CSV browser transport", () => {
  it("captures input and uses only the exact same-origin preview route", async () => {
    const send = transport(csvPreview);
    const input: ReceivingCsvPreviewInput = structuredClone(csvInput);
    const pending = createUsBrowserClient(send).previewReceivingCsv(input);
    input.header.notes = "changed";
    expect(await pending).toEqual(csvPreview);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe("/api/us/traceability/receiving/imports/preview");
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify(csvInput),
    });
  });
  it.each([
    { ...csvPreview, fileSha256: "0".repeat(64) },
    { ...csvPreview, previewDigest: "0".repeat(64) },
    { ...csvPreview, fileName: "other.csv" },
  ])("rejects a preview of another captured file", async (value) => {
    await expect(
      createUsBrowserClient(transport(value)).previewReceivingCsv(csvInput),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("reads exact saved preview identity", async () => {
    expect(
      await createUsBrowserClient(transport(csvPreview)).getReceivingCsvPreview(csvId),
    ).toEqual(csvPreview);
    await expect(
      createUsBrowserClient(transport(csvPreview)).getReceivingCsvPreview(csvKey),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("sends the original header while validating its normalized proposal and digest", async () => {
    const value = structuredClone(csvPreview);
    if (!value.proposedDraft) throw new Error("Missing fixture draft");
    value.header.notes = "Dock A";
    value.proposedDraft.notes = "Dock A";
    value.previewDigest = createHash("sha256")
      .update(
        JSON.stringify({
          templateVersion: value.templateVersion,
          fileSha256: value.fileSha256,
          header: value.header,
          draft: value.proposedDraft,
        }),
      )
      .digest("hex");
    const input = { ...csvInput, header: { ...csvInput.header, notes: "  Dock A  " } };
    const send = transport(value);
    expect(await createUsBrowserClient(send).previewReceivingCsv(input)).toEqual(value);
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body)).header.notes).toBe("  Dock A  ");
    await expect(
      createUsBrowserClient(transport(value)).previewReceivingCsv(csvInput),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("preserves another original key/preview receipt and never auto-reads or retries", async () => {
    const value = structuredClone(csvAck);
    value.receipt.operationKey = csvId;
    value.receipt.importId = csvKey;
    const send = transport(value);
    const body = {
      operationKey: csvKey,
      expectedPreviewDigest: csvAck.request.expectedPreviewDigest,
    };
    const pending = createUsBrowserClient(send).applyReceivingCsv(csvId, body);
    body.operationKey = csvId;
    expect(await pending).toEqual(value);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects an acknowledgement for a different request", async () => {
    await expect(
      createUsBrowserClient(transport(csvAck)).applyReceivingCsv(csvId, {
        operationKey: csvId,
        expectedPreviewDigest: csvAck.request.expectedPreviewDigest,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects malformed input before transport", async () => {
    const send = transport(csvAck);
    const client = createUsBrowserClient(send);
    await expect(
      client.previewReceivingCsv({ ...csvInput, tenantId: "foreign" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(client.getReceivingCsvPreview("../profile")).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(client.applyReceivingCsv(csvId, {})).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    "receiving_csv_preview_expired",
    "receiving_csv_preview_stale",
    "receiving_csv_preview_conflict",
    "receiving_csv_preview_not_applicable",
  ])("keeps safe typed CSV conflicts: %s", async (code) => {
    await expect(
      createUsBrowserClient(transport({ code }, 409)).applyReceivingCsv(csvId, {
        operationKey: csvKey,
        expectedPreviewDigest: csvAck.request.expectedPreviewDigest,
      }),
    ).rejects.toMatchObject({ code });
  });
});

describe("saved Receiving CSV download", () => {
  const filename = `markiro-receiving-${liveDraft.id}-r${liveDraft.revision}-d${liveDraft.draftVersion}-l${liveDraft.lifecycle.lifecycleVersion}.csv`;
  const bytes = encodeReceivingCsvExport(liveDraft, "2026-09-26T10:00:00.000Z");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const response = (
    body: BodyInit = bytes as Uint8Array<ArrayBuffer>,
    headers: Record<string, string> = {},
    status = 200,
  ) =>
    new Response(body, {
      status,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Markiro-Export-SHA256": digest,
        ...headers,
      },
    });

  it("downloads original verified bytes for the selected saved version", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(response());
    const result = await createUsBrowserClient(send).exportReceivingCsv(liveDraft);
    expect(result.filename).toBe(filename);
    expect(Buffer.from(result.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(decodeReceivingCsvExport(result.bytes).record).toEqual(liveDraft);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(
      `/api/us/traceability/receiving/${liveDraft.id}/export.csv?expectedDraftVersion=${liveDraft.draftVersion}&expectedLifecycleVersion=${liveDraft.lifecycle.lifecycleVersion}`,
    );
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  });

  it.each([
    ["changed bytes", () => response(new Uint8Array([...bytes, 32]) as Uint8Array<ArrayBuffer>)],
    ["wrong MIME", () => response(undefined, { "Content-Type": "application/json" })],
    ["wrong digest", () => response(undefined, { "X-Markiro-Export-SHA256": "0".repeat(64) })],
    [
      "wrong filename",
      () => response(undefined, { "Content-Disposition": 'attachment; filename="other.csv"' }),
    ],
    [
      "oversized declared length",
      () => response(undefined, { "Content-Length": String(16 * 1024 * 1024 + 1) }),
    ],
  ] as const)("rejects %s", async (_label, makeResponse) => {
    await expect(
      createUsBrowserClient(
        vi.fn<typeof fetch>().mockResolvedValue(makeResponse()),
      ).exportReceivingCsv(liveDraft),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects a well-formed file for another saved version", async () => {
    const another = { ...liveDraft, draftVersion: liveDraft.draftVersion + 1 };
    const otherBytes = encodeReceivingCsvExport(another, "2026-09-26T10:00:00.000Z");
    const otherHash = createHash("sha256").update(otherBytes).digest("hex");
    await expect(
      createUsBrowserClient(
        vi.fn<typeof fetch>().mockResolvedValue(
          response(otherBytes as Uint8Array<ArrayBuffer>, {
            "X-Markiro-Export-SHA256": otherHash,
          }),
        ),
      ).exportReceivingCsv(liveDraft),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("bounds the streamed body even when Content-Length is absent", async () => {
    const oversized = new Uint8Array(16 * 1024 * 1024 + 1);
    const send = vi.fn<typeof fetch>().mockResolvedValue(response(oversized));
    await expect(createUsBrowserClient(send).exportReceivingCsv(liveDraft)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("maps a transport failure to unavailable without retaining its details", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("synthetic private URL"));
    await expect(createUsBrowserClient(send).exportReceivingCsv(liveDraft)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, { code: "session_required" }, "session_required"],
    [403, { code: "forbidden" }, "forbidden"],
    [409, { code: "receiving_export_stale" }, "receiving_export_stale"],
    [422, { code: "export_value_too_large", row: 1, column: "payload" }, "export_value_too_large"],
  ] as const)("maps safe %i failures", async (status, body, code) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
    await expect(createUsBrowserClient(send).exportReceivingCsv(liveDraft)).rejects.toMatchObject({
      code,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
