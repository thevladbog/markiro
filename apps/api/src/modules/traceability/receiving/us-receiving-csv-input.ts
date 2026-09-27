import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import {
  parseReceivingCsv,
  type ReceivingCsvParseResult,
  type ReceivingCsvRawRow,
} from "@markiro/domain";
import {
  receivingCsvPreviewInputSchema,
  parseReceivingCsvRow,
  type ReceivingCsvPreviewInput,
  type ReceivingCsvRowResult,
} from "@markiro/platform-contracts";

export type PreparedReceivingCsvContent =
  | Extract<ReceivingCsvParseResult, { ok: false }>
  | { ok: true; rows: (ReceivingCsvRawRow & { validation: ReceivingCsvRowResult })[] };
export interface PreparedReceivingCsvFile {
  input: ReceivingCsvPreviewInput;
  originalHeader: unknown;
  fileBytes: Uint8Array;
  byteSize: number;
  fileSha256: string;
  content: PreparedReceivingCsvContent;
}

/** No I/O or authority: a future service must authorize, resolve and revalidate separately. */
export function prepareUsReceivingCsvFile(input: unknown): PreparedReceivingCsvFile {
  const parsed = receivingCsvPreviewInputSchema.safeParse(input);
  if (!parsed.success || typeof input !== "object" || input === null || !("header" in input))
    throw new BadRequestException({ code: "receiving_csv_input_invalid" });
  // Validation precedes decoding. Raw bytes include BOM and original line endings.
  const fileBytes = Buffer.from(parsed.data.fileBase64, "base64");
  const decoded = parseReceivingCsv(fileBytes, parsed.data.templateVersion);
  return {
    input: parsed.data,
    originalHeader: structuredClone(input.header),
    fileBytes,
    byteSize: fileBytes.byteLength,
    fileSha256: createHash("sha256").update(fileBytes).digest("hex"),
    content: decoded.ok
      ? {
          ok: true,
          rows: decoded.rows.map((row) => ({
            ...row,
            validation: parseReceivingCsvRow(row.cells),
          })),
        }
      : decoded,
  };
}
