import { BUILD_INFO } from "../info/build-info.js";
import { HostError } from "../../host/client.js";
import { errorMessageKey } from "../../host/errors.js";
import {
  EXPORT_FILE_CHUNK_BYTES,
  EXPORT_FILE_MAX_PARTS,
  type ExportFile,
  type ExportFileKind,
  type ExportTargetType,
} from "../../host/export-files.js";
import type { OfficeSessionValue } from "../office-session.js";

/**
 * The host keeps every file the office generates (host migration `0029`): the
 * office renders it with `@markiro/domain` exactly as before, hands its exact
 * bytes to the host first (`storeExportFiles`), and the shift's drawer and the
 * cards give the same bytes back (`fetchStoredFile`), their SHA-256 checked on
 * both sides. A file the host cannot keep (its store is full, the file is too
 * large, the host does not answer) never stops an export: the office's own copy
 * in the Documents folder is made all the same, and the dialog says why the
 * host has none.
 */

/** The session pieces the store needs; a test passes its own. */
export type StoreSession = Pick<OfficeSessionValue, "api" | "call">;

/** What generated the file: the office build (the format's own version is stored beside it). */
export function generatorName(): string {
  const commit = BUILD_INFO.commit ?? "dev";
  return `markiro-autonom ${commit}`;
}

/** One file of an export: the part's number from 1, its name and its exact bytes. */
export interface StorePart {
  partNo: number;
  name: string;
  bytes: Uint8Array;
}

export interface StoreRequest {
  kind: ExportFileKind;
  targetType: ExportTargetType;
  targetId: string;
  /** The export's `documentId`, or a UUID of its own for a form and a disaggregation file. */
  batchId: string;
  formatId: string;
  formatVersion: number;
  parts: readonly StorePart[];
}

export type StoreOutcome =
  | { ok: true; files: ExportFile["id"][] }
  /** The export has more parts than the host stores (`EXPORT_FILE_MAX_PARTS`); none is sent. */
  | { ok: false; reason: "too_many_parts"; messageKey: string }
  /** The host refused or did not answer; `messageKey` says in words (`errorMessageKey`). */
  | { ok: false; reason: "host"; messageKey: string; stored: number };

/** The bytes as base64, cut in blocks so no call is handed a megabyte of arguments. */
export function encodeBase64(bytes: Uint8Array): string {
  const block = 0x8000;
  let binary = "";
  for (let at = 0; at < bytes.length; at += block) {
    binary += String.fromCharCode(...bytes.subarray(at, at + block));
  }
  return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/** SHA-256 of `bytes`, lower-case hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The id of a part's file: a UUID derived from the export's batch and the part's
 * number, so that starting the same part again (a lost answer, a second press that
 * found the same batch) is the same file and not a second one.
 */
export async function partFileId(batchId: string, partNo: number): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${batchId}:${partNo}`),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A chunk is sent again once after a failed call (a host that stalled for a moment). */
async function withOneRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (first) {
    // A refusal is the host's answer and repeating it changes nothing.
    if (first instanceof HostError && first.kind === "api") throw first;
    return run();
  }
}

/**
 * Hands the parts to the host, one file at a time, each by chunks of at most
 * 1 MiB: a file of one chunk goes in the call that starts it; a larger one
 * is started, sent chunk by chunk (each retried once) and sealed, where the
 * host checks the whole against the SHA-256 declared here. The first failure
 * ends it; the parts stored before it stay stored. The caller's folder copy
 * does not wait for this: it is made whatever this answers.
 */
export async function storeExportFiles(
  session: StoreSession,
  request: StoreRequest,
): Promise<StoreOutcome> {
  if (request.parts.length > EXPORT_FILE_MAX_PARTS) {
    return {
      ok: false,
      reason: "too_many_parts",
      messageKey: "office.storedFiles.tooManyParts",
    };
  }
  const generator = generatorName();
  const ids: string[] = [];
  for (const part of request.parts) {
    try {
      const id = await partFileId(request.batchId, part.partNo);
      const sha256 = await sha256Hex(part.bytes);
      const whole = part.bytes.length <= EXPORT_FILE_CHUNK_BYTES;
      const begin = {
        id,
        batchId: request.batchId,
        partNo: part.partNo,
        kind: request.kind,
        targetType: request.targetType,
        targetId: request.targetId,
        formatId: request.formatId,
        formatVersion: request.formatVersion,
        fileName: part.name,
        sizeBytes: part.bytes.length,
        sha256,
        generator,
        ...(whole ? { contentBase64: encodeBase64(part.bytes) } : {}),
      };
      const started = await session.call((token) => session.api.beginExportFile(token, begin));
      if (!started.ready) {
        for (
          let seq = started.receivedChunks;
          seq * EXPORT_FILE_CHUNK_BYTES < part.bytes.length;
          seq += 1
        ) {
          const chunk = encodeBase64(
            part.bytes.subarray(seq * EXPORT_FILE_CHUNK_BYTES, (seq + 1) * EXPORT_FILE_CHUNK_BYTES),
          );
          await withOneRetry(() =>
            session.call((token) => session.api.putExportFileChunk(token, id, seq, chunk)),
          );
        }
        await withOneRetry(() =>
          session.call((token) => session.api.completeExportFile(token, id)),
        );
      }
      ids.push(id);
    } catch (error) {
      return {
        ok: false,
        reason: "host",
        messageKey: errorMessageKey(error),
        stored: ids.length,
      };
    }
  }
  return { ok: true, files: ids };
}

/** The bytes the host gave are not the file's SHA-256 or size: nothing is saved. */
export class StoredFileMismatchError extends Error {
  constructor() {
    super("the downloaded bytes do not match the stored SHA-256");
    this.name = "StoredFileMismatchError";
  }
}

/**
 * The exact bytes of a stored file: the host checks them against the SHA-256
 * they were stored with (and writes the `shift.export.download` row), serves
 * them by chunks, and this checks the whole once more before anything is saved.
 * A file that fails either check is an error (`export_file_corrupted` from
 * the host, `StoredFileMismatchError` here) and yields no bytes.
 */
export async function fetchStoredFile(
  session: StoreSession,
  file: Pick<ExportFile, "id" | "sha256" | "sizeBytes">,
): Promise<Uint8Array> {
  const opened = await session.call((token) => session.api.openExportFileDownload(token, file.id));
  const parts: Uint8Array[] = [];
  let size = 0;
  for (let seq = 0; seq < opened.chunkCount; seq += 1) {
    const chunk = await withOneRetry(() =>
      session.call((token) => session.api.getExportFileChunk(token, file.id, seq)),
    );
    const bytes = decodeBase64(chunk.contentBase64);
    parts.push(bytes);
    size += bytes.length;
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  if (size !== opened.file.sizeBytes || (await sha256Hex(whole)) !== opened.file.sha256) {
    throw new StoredFileMismatchError();
  }
  return whole;
}

/** The i18n key of the words for a failed download. */
export function downloadErrorKey(error: unknown): string {
  return error instanceof StoredFileMismatchError
    ? "office.storedFiles.corrupted"
    : errorMessageKey(error);
}
