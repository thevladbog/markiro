import { ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assertUsRequestReportModel } from "./us-request-package-inputs";
import { buildUsRequestManifest, type UsRequestManifestV1 } from "./us-request-package-manifest";
import {
  US_REQUEST_PACKAGE_LIMITS as limits,
  type UsRequestPackageByteFile,
  type UsRequestPackageInputs,
} from "./us-request-package-types";
import {
  encodeUsRequestPackageArchive,
  verifyUsRequestPackageArchive,
} from "./us-request-package-zip";
import type { UsRequestPayloadResult } from "./us-request-payloads";
import { renderUsRequestReportPdf } from "./us-request-report-pdf";
import { stableStringify } from "./us-request-snapshot";

export interface UsRequestPackageResult {
  runId: string;
  revision: number;
  mode: UsRequestPayloadResult["mode"];
  files: readonly UsRequestPackageByteFile[];
  manifest: UsRequestManifestV1;
  zip: UsRequestPackageByteFile<"package.zip">;
}
const invalid = () =>
  new ServiceUnavailableException({ code: "us_request_package_inputs_invalid" });
const sizeLimit = () => new ServiceUnavailableException({ code: "us_request_package_size_limit" });
function hasFiniteCode(error: unknown, code: string): boolean {
  try {
    return (
      error instanceof ServiceUnavailableException &&
      stableStringify(error.getResponse()) === stableStringify({ code })
    );
  } catch {
    return false;
  }
}
const names = ["records.xlsx", "plan.pdf", "validation.json"] as const;
const fileSchema = z
  .object({
    name: z.enum(names),
    mediaType: z.string(),
    byteSize: z.number().refine(Number.isSafeInteger).positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.instanceof(Buffer),
  })
  .strict();
function plainData(value: object): void {
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== Object.keys(value).length ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some((d) => !("value" in d))
  )
    throw invalid();
}
function copyInputs(inputs: UsRequestPackageInputs): UsRequestPackageInputs {
  try {
    plainData(inputs);
    const parsed = z
      .object({ model: z.unknown(), preReportFiles: z.array(z.unknown()).max(3) })
      .strict()
      .parse(inputs);
    const model = inputs.model;
    if (parsed.model !== model) throw invalid();
    assertUsRequestReportModel(model);
    const ownedModel = structuredClone(model);
    const parsedFiles = parsed.preReportFiles.map((file) => {
      if (!file || typeof file !== "object") throw invalid();
      plainData(file);
      return fileSchema.parse(file);
    });
    let total = 0;
    for (const file of parsedFiles) {
      const max =
        file.name === "records.xlsx"
          ? limits.workbook
          : file.name === "plan.pdf"
            ? limits.plan
            : limits.validation;
      if (file.bytes.length > max) throw sizeLimit();
      total += file.bytes.length;
      if (total > limits.entriesTotal) throw sizeLimit();
      if (
        file.byteSize !== file.bytes.length ||
        createHash("sha256").update(file.bytes).digest("hex") !== file.sha256
      )
        throw invalid();
    }
    const descriptors = parsedFiles.map(({ bytes, ...descriptor }) => {
      void bytes;
      return descriptor;
    });
    if (stableStringify(descriptors) !== stableStringify(ownedModel.preReportFiles))
      throw invalid();
    return {
      model: ownedModel,
      preReportFiles: parsedFiles.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })),
    };
  } catch (error) {
    if (hasFiniteCode(error, "us_request_package_size_limit")) throw sizeLimit();
    if (hasFiniteCode(error, "us_request_package_model_invalid"))
      throw new ServiceUnavailableException({ code: "us_request_package_model_invalid" });
    throw invalid();
  }
}

/** Internal pure composition; callers obtain authorized, bound real upstream bytes first. */
export async function assembleUsRequestPackage(
  inputs: UsRequestPackageInputs,
): Promise<UsRequestPackageResult> {
  const copiedInputs = copyInputs(inputs);
  let report: UsRequestPackageByteFile<"request-report.pdf">;
  try {
    report = await renderUsRequestReportPdf(copiedInputs.model);
  } catch (error) {
    if (hasFiniteCode(error, "us_request_package_size_limit")) throw sizeLimit();
    throw new ServiceUnavailableException({ code: "us_request_report_render_failed" });
  }
  const bundle = buildUsRequestManifest(copiedInputs, report);
  const files = [...bundle.payloadFiles, bundle.manifest, bundle.sums];
  const zip = encodeUsRequestPackageArchive(files);
  verifyUsRequestPackageArchive(zip.bytes, { files, manifest: bundle.model });
  return {
    runId: copiedInputs.model.identity.runId,
    revision: copiedInputs.model.identity.runRevision,
    mode: copiedInputs.model.identity.mode,
    files: files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })),
    manifest: structuredClone(bundle.model),
    zip: { ...zip, bytes: Buffer.from(zip.bytes) },
  };
}
