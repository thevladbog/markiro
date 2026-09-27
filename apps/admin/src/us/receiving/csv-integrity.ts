import { parseReceivingCsv } from "@markiro/domain";
import {
  receivingDraftSchema,
  type ReceivingCsvPreview,
  type ReceivingCsvPreviewInput,
} from "@markiro/platform-contracts";

export async function receivingCsvHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Bind saved evidence to the captured upload; never trust hash labels alone. */
export async function matchesReceivingCsvPreview(
  value: ReceivingCsvPreview,
  input: ReceivingCsvPreviewInput,
): Promise<boolean> {
  const bytes = Uint8Array.from(atob(input.fileBase64), (character) => character.charCodeAt(0));
  const fileSha256 = await receivingCsvHash(bytes);
  if (
    value.templateVersion !== input.templateVersion ||
    value.fileName !== (input.fileName ?? null) ||
    value.byteSize !== bytes.byteLength ||
    value.fileSha256 !== fileSha256 ||
    JSON.stringify(value.header) !== JSON.stringify(input.header)
  )
    return false;
  const content = parseReceivingCsv(bytes, input.templateVersion);
  if (!content.ok) return JSON.stringify(value.fileError) === JSON.stringify(content.error);
  if (
    value.fileError !== null ||
    content.rows.length !== value.rows.length ||
    content.rows.some((row, index) => {
      const saved = value.rows[index];
      return (
        !saved ||
        row.rowNumber !== saved.rowNumber ||
        row.lineNumber !== saved.lineNumber ||
        JSON.stringify(row.cells) !== JSON.stringify(saved.cells)
      );
    })
  )
    return false;
  if (!value.proposedDraft) return value.previewDigest === null;
  const expected = await receivingCsvHash(
    new TextEncoder().encode(
      JSON.stringify({
        templateVersion: input.templateVersion,
        fileSha256,
        header: input.header,
        draft: receivingDraftSchema.parse(value.proposedDraft),
      }),
    ),
  );
  return value.previewDigest === expected;
}
