import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EXPORT_FILE_CHUNK_BYTES,
  EXPORT_FILE_MAX_BYTES,
  EXPORT_FILE_MAX_PARTS,
  EXPORT_RETENTION_MAX_DAYS,
  EXPORT_RETENTION_MIN_DAYS,
  FORM_FORMATS,
  exportFileBeginSchema,
  exportFileChunkPutSchema,
  exportFileChunkSchema,
  exportFileListSchema,
  exportFileOpenedSchema,
  exportFileProgressSchema,
  exportFileSchema,
  exportFilesPath,
  exportSettingsSchema,
  exportSettingsUpdateSchema,
} from "../src/host/export-files.js";
import { API_ERROR_CODES, errorMessageKey } from "../src/host/errors.js";
import { HostError } from "../src/host/client.js";
import ru from "../src/i18n/ru.json";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

describe.each([
  ["export-file.json", exportFileSchema],
  ["export-file-begin.json", exportFileBeginSchema],
  ["export-file-chunk-put.json", exportFileChunkPutSchema],
  ["export-file-progress.json", exportFileProgressSchema],
  ["export-file-list.json", exportFileListSchema],
  ["export-file-opened.json", exportFileOpenedSchema],
  ["export-file-chunk.json", exportFileChunkSchema],
  ["export-settings.json", exportSettingsSchema],
  ["export-settings-update.json", exportSettingsUpdateSchema],
] as const)("stored-files fixture %s (host migration 0029)", (name, schema) => {
  it("parses without losing a field", () => {
    expect(schema.parse(fixture(name))).toEqual(fixture(name));
  });
});

describe("the requests are strict as the host's are", () => {
  it.each([
    [
      "a begin with a field the host does not know",
      exportFileBeginSchema,
      "export-file-begin.json",
    ],
    ["a chunk with one", exportFileChunkPutSchema, "export-file-chunk-put.json"],
    ["a settings update with one", exportSettingsUpdateSchema, "export-settings-update.json"],
  ] as const)("refuses %s", (_name, schema, file) => {
    expect(schema.safeParse({ ...(fixture(file) as object), extra: 1 }).success).toBe(false);
  });

  it("refuses a digest that is not 64 lower-case hex digits and a kind it does not list", () => {
    const begin = fixture("export-file-begin.json") as Record<string, unknown>;
    expect(exportFileBeginSchema.safeParse({ ...begin, sha256: "ABC" }).success).toBe(false);
    expect(exportFileBeginSchema.safeParse({ ...begin, kind: "pdf" }).success).toBe(false);
    expect(exportFileBeginSchema.safeParse({ ...begin, sizeBytes: 0 }).success).toBe(false);
  });
});

describe("the limits are markiro_proto::export_files'", () => {
  it("are the same numbers", () => {
    expect([
      EXPORT_FILE_CHUNK_BYTES,
      EXPORT_FILE_MAX_BYTES,
      EXPORT_FILE_MAX_PARTS,
      EXPORT_RETENTION_MIN_DAYS,
      EXPORT_RETENTION_MAX_DAYS,
    ]).toEqual([1_048_576, 268_435_456, 1000, 30, 3650]);
    expect(FORM_FORMATS).toEqual([
      "form_box",
      "form_pallet",
      "form_placard",
      "form_placards",
      "form_task",
      "form_act",
    ]);
  });
});

describe("exportFilesPath", () => {
  it("names a shift, or a target with its id, and the kind when asked", () => {
    expect(exportFilesPath({ shiftId: "a" })).toBe("/v1/office/export-files?shiftId=a");
    expect(exportFilesPath({ targetType: "pallet", targetId: "b", kind: "form" })).toBe(
      "/v1/office/export-files?targetType=pallet&targetId=b&kind=form",
    );
  });
});

describe("the store's refusals have words", () => {
  it.each(["export_store_full", "export_file_too_large", "export_file_corrupted"])(
    "%s is a host code with a text of its own",
    (code) => {
      expect(API_ERROR_CODES).toContain(code);
      const error = new HostError({ kind: "api", code, message: "x", status: 507, details: {} });
      expect(errorMessageKey(error)).toBe(`errors.api.${code}`);
      const text = (ru.errors.api as Record<string, string>)[code];
      expect(text?.length).toBeGreaterThan(20);
    },
  );
});
