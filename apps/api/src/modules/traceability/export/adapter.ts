import {
  buildUsExportWorkbook,
  canonicalExportDigest,
  ExportWorkbookInputError,
  traceExportRegistryHash,
  type ExportArtifactFailure,
  type WorkbookModel,
} from "@markiro/domain";
import {
  usExportInputV1Schema,
  type ExportFinding,
  type ExportInputV1,
} from "@markiro/platform-contracts";
import { ZodError } from "zod";
import { renderUsExportXlsx, UsExportXlsxError, type UsExportXlsxFailure } from "./xlsx-writer.js";

export type UsExportArtifactFailure = ExportArtifactFailure | UsExportXlsxFailure;

export class UsExportError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "REGISTRY_MISMATCH",
    readonly sourceRecord: string,
  ) {
    super(`${code}: ${sourceRecord}`);
    this.name = "UsExportError";
  }
}

export interface UsExportCoreResult {
  readonly workbook: Uint8Array | null;
  readonly workbookSha256: string | null;
  readonly registryVersion: 1;
  readonly registryHash: string;
  readonly inputDigest: string;
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly findings: readonly ExportFinding[];
  readonly failure: UsExportArtifactFailure | null;
}

const SHEET_KEYS = {
  Metadata: "metadata",
  Definitions: "definitions",
  Receiving: "receiving",
  Transformation: "transformation",
  Shipping: "shipping",
  Validation: "validation",
} as const;

function countExportRows(
  model: WorkbookModel | null,
): Record<(typeof SHEET_KEYS)[keyof typeof SHEET_KEYS], number> {
  const counts = {
    metadata: 0,
    definitions: 0,
    receiving: 0,
    transformation: 0,
    shipping: 0,
    validation: 0,
  };
  for (const sheet of model?.sheets ?? []) {
    const key = SHEET_KEYS[sheet.name as keyof typeof SHEET_KEYS];
    if (key === undefined) throw new Error(`Unknown export workbook sheet: ${sheet.name}`);
    counts[key] = sheet.rows.length;
  }
  return counts;
}

/** Internal US-07 composition only; US-09 owns authorization, frozen request state and publication. */
export async function renderUsExportCore(input: ExportInputV1): Promise<UsExportCoreResult> {
  let frozen: ExportInputV1;
  try {
    frozen = usExportInputV1Schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const registryLiteralMismatch =
        error.issues.length > 0 &&
        error.issues.every(
          (issue) =>
            issue.code === "invalid_value" &&
            issue.path.length === 2 &&
            issue.path[0] === "metadata" &&
            (issue.path[1] === "registryId" || issue.path[1] === "registryVersion"),
        );
      throw new UsExportError(
        registryLiteralMismatch ? "REGISTRY_MISMATCH" : "INVALID_INPUT",
        registryLiteralMismatch ? "metadata" : "input",
      );
    }
    throw error;
  }
  const registryHash = traceExportRegistryHash();
  if (
    frozen.metadata.registryId !== "fda_sortable_xlsx" ||
    frozen.metadata.registryVersion !== 1 ||
    frozen.metadata.registryHash !== registryHash
  )
    throw new UsExportError("REGISTRY_MISMATCH", "metadata");

  let built: ReturnType<typeof buildUsExportWorkbook>;
  try {
    built = buildUsExportWorkbook(frozen);
  } catch (error) {
    if (error instanceof ExportWorkbookInputError)
      throw new UsExportError("INVALID_INPUT", error.sourceRecord);
    throw error;
  }
  const inputDigest = canonicalExportDigest(frozen);
  const rowCounts = countExportRows(built.model);
  if (built.model === null) {
    const failure = built.failure;
    if (failure === null) throw new Error("Export workbook model missing without artifact failure");
    return {
      workbook: null,
      workbookSha256: null,
      registryVersion: 1,
      registryHash,
      inputDigest,
      rowCounts,
      findings: built.findings,
      failure,
    };
  }
  try {
    const rendered = await renderUsExportXlsx(built.model);
    return {
      workbook: rendered.bytes,
      workbookSha256: rendered.sha256,
      registryVersion: 1,
      registryHash,
      inputDigest,
      rowCounts,
      findings: built.findings,
      failure: null,
    };
  } catch (error) {
    if (!(error instanceof UsExportXlsxError)) throw error;
    return {
      workbook: null,
      workbookSha256: null,
      registryVersion: 1,
      registryHash,
      inputDigest,
      rowCounts,
      findings: built.findings,
      failure: error.failure,
    };
  }
}
