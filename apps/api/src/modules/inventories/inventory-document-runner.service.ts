import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { strToU8, zipSync, type Zippable } from "fflate";

import { schema, type Db } from "@markiro/db";
import {
  createInventoryDocumentRegistry,
  generateInventoryAggregationXml,
  generateInventoryAggregationXmlV2,
  generateInventoryBalancesByProductionDateCsv,
  generateInventoryCurrentStockCsv,
  generateInventoryDisaggregationXml,
  generateInventoryFinalBoxContentsCsv,
  generateInventoryFinalBoxesTxt,
  generateInventoryWriteOffCsv,
  generateInventoryWriteOffTxt,
  getRegisteredInventoryDocumentFormat,
  InventoryDocumentGenerationError,
  InventoryDocumentRegistryError,
  type InventoryDocumentGenerationMetadata,
  type InventoryDocumentFormatDescriptor,
  type InventoryDocumentRegistry,
} from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import { ObjectStorageService } from "../storage/object-storage.service";
import {
  InventoryResultSourceError,
  InventoryResultSourceService,
  type InventoryResultSource,
} from "./inventory-result-source.service";

export interface InventoryDocumentZipArtifact {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  sha256: string;
  byteSize: number;
  rowCount: number;
  codeCount: number;
  boxCount: number;
  formatId: string;
  formatVersion: number;
  partNumber: number;
}

const ZIP_MTIME = new Date(2000, 0, 1, 0, 0, 0);
const SHA256 = /^[0-9a-f]{64}$/;
const PROCESSING_LEASE_MS = 20_000;

export const INVENTORY_DOCUMENT_GENERATOR_REGISTRY = Symbol(
  "INVENTORY_DOCUMENT_GENERATOR_REGISTRY",
);

export interface InventoryDocumentGeneratedPart {
  partNumber: number;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  rowCount: number;
  codeCount: number;
  boxCount: number;
}

export interface InventoryDocumentGenerator {
  descriptor: InventoryDocumentFormatDescriptor;
  allowsZeroByteArtifact?: true;
  generate(
    source: InventoryResultSource,
    metadata: InventoryDocumentGenerationMetadata,
  ): readonly InventoryDocumentGeneratedPart[] | Promise<readonly InventoryDocumentGeneratedPart[]>;
}

export class InventoryDocumentGeneratorRegistry {
  readonly #descriptors: InventoryDocumentRegistry;
  readonly #generators: ReadonlyMap<string, InventoryDocumentGenerator>;

  constructor(generators: readonly InventoryDocumentGenerator[]) {
    this.#descriptors = createInventoryDocumentRegistry(
      generators.map((generator) => generator.descriptor),
    );
    this.#generators = new Map(
      generators.map((generator) => {
        const descriptor = this.#descriptors.resolveRegistered(
          generator.descriptor.id,
          generator.descriptor.version,
        );
        return [
          generatorKey(descriptor.id, descriptor.version),
          { ...generator, descriptor },
        ] as const;
      }),
    );
  }

  listAvailable(): readonly InventoryDocumentFormatDescriptor[] {
    return this.#descriptors.listAvailable();
  }

  resolveForSelection(id: string, version: number): InventoryDocumentGenerator {
    const descriptor = this.#descriptors.resolve(id, version);
    return this.#resolve(descriptor);
  }

  resolveForExecution(id: string, version: number): InventoryDocumentGenerator {
    const descriptor = this.#descriptors.resolveRegistered(id, version);
    return this.#resolve(descriptor);
  }

  resolve(id: string, version: number): InventoryDocumentGenerator {
    return this.resolveForSelection(id, version);
  }

  #resolve(descriptor: InventoryDocumentFormatDescriptor): InventoryDocumentGenerator {
    const generator = this.#generators.get(generatorKey(descriptor.id, descriptor.version));
    if (!generator) throw new InventoryDocumentRegistryError("FORMAT_UNAVAILABLE");
    return generator;
  }
}

const generatorKey = (id: string, version: number): string => `${id}@${version}`;

export const productionInventoryDocumentGeneratorRegistry = new InventoryDocumentGeneratorRegistry([
  {
    descriptor: getRegisteredInventoryDocumentFormat("inventory_xml_gismt_aggregation", 1),
    allowsZeroByteArtifact: true,
    generate: generateInventoryAggregationXml,
  },
  {
    descriptor: getRegisteredInventoryDocumentFormat("inventory_xml_gismt_aggregation", 2),
    allowsZeroByteArtifact: true,
    generate: generateInventoryAggregationXmlV2,
  },
  {
    descriptor: getRegisteredInventoryDocumentFormat("inventory_xml_gismt_disaggregation", 1),
    allowsZeroByteArtifact: true,
    generate: generateInventoryDisaggregationXml,
  },
  {
    descriptor: getRegisteredInventoryDocumentFormat("inventory_txt_write_off", 1),
    allowsZeroByteArtifact: true,
    generate: generateInventoryWriteOffTxt,
  },
  {
    descriptor: getRegisteredInventoryDocumentFormat("inventory_csv_write_off", 1),
    generate: generateInventoryWriteOffCsv,
  },
  {
    descriptor: getRegisteredInventoryDocumentFormat("inventory_csv_current_stock", 1),
    generate: generateInventoryCurrentStockCsv,
  },
  {
    descriptor: getRegisteredInventoryDocumentFormat("inventory_csv_final_box_contents", 1),
    generate: generateInventoryFinalBoxContentsCsv,
  },
  {
    descriptor: getRegisteredInventoryDocumentFormat("inventory_txt_final_boxes", 1),
    allowsZeroByteArtifact: true,
    generate: generateInventoryFinalBoxesTxt,
  },
  {
    descriptor: getRegisteredInventoryDocumentFormat(
      "inventory_csv_balances_by_production_date",
      1,
    ),
    generate: generateInventoryBalancesByProductionDateCsv,
  },
]);

type InventoryDocumentRunRow = typeof schema.inventoryDocumentRuns.$inferSelect;
type InventoryDocumentTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface AttemptContext {
  retryCount: number;
  retryLimit: number;
}

interface UploadedArtifact {
  formatId: string;
  formatVersion: number;
  part: InventoryDocumentGeneratedPart;
  objectKey: string;
  byteSize: number;
  sha256: string;
}

export const INVENTORY_DOCUMENT_SAFE_ERROR_CODES = [
  "FORMAT_UNKNOWN",
  "FORMAT_SUPERSEDED",
  "FORMAT_UNAVAILABLE",
  "INVENTORY_RESULT_NOT_CLOSED",
  "STALE_RESULT_REVISION",
  "VERIFIED_PRODUCTION_DATE_MISSING",
  "INVALID_ORGANIZATION_INN",
  "GENERATION_FAILED",
  "STORAGE_FAILED",
  "QUEUE_FAILED",
] as const;
type InventoryDocumentSafeErrorCode = (typeof INVENTORY_DOCUMENT_SAFE_ERROR_CODES)[number];

@Injectable()
export class InventoryDocumentRunnerService {
  private readonly logger = new Logger(InventoryDocumentRunnerService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly source: InventoryResultSourceService,
    private readonly storage: ObjectStorageService,
    @Inject(INVENTORY_DOCUMENT_GENERATOR_REGISTRY)
    private readonly generators: InventoryDocumentGeneratorRegistry,
  ) {}

  async run(runId: string, attempt: AttemptContext): Promise<void> {
    const claimed = await this.claim(runId);
    if (!claimed) return;

    const attemptedObjectKeys: string[] = [];
    const uploaded: UploadedArtifact[] = [];
    let infrastructureErrorCode: InventoryDocumentSafeErrorCode = "GENERATION_FAILED";
    let publicationAttempted = false;
    try {
      const selected = claimed.selectedFormats.map((selection) => ({
        selection,
        generator: this.generators.resolveForExecution(selection.id, selection.version),
      }));
      const source = await this.source.load(claimed.tenantId, claimed.inventoryId);
      if (source.resultRevision !== claimed.resultRevision) {
        throw new InventoryDocumentRunError("STALE_RESULT_REVISION");
      }
      const sourceSnapshotCompletedAt = new Date();
      const snapshotUpdated = await this.db
        .update(schema.inventoryDocumentRuns)
        .set({
          sourceSnapshotStartedAt: new Date(source.sourceSnapshotStartedAt),
          sourceSnapshotCompletedAt,
          updatedAt: sourceSnapshotCompletedAt,
        })
        .where(this.ownedProcessingAttempt(claimed))
        .returning({ id: schema.inventoryDocumentRuns.id });
      if (snapshotUpdated.length === 0) throw new InventoryDocumentClaimLostError();

      const rendered: Array<{
        formatId: string;
        formatVersion: number;
        part: InventoryDocumentGeneratedPart;
      }> = [];
      for (const { selection, generator } of selected) {
        const parts = await generator.generate(source, generationMetadata(claimed));
        validateGeneratedParts(generator, parts);
        rendered.push(
          ...parts.map((part) => ({
            formatId: selection.id,
            formatVersion: selection.version,
            part,
          })),
        );
      }
      const renderedFilenames = new Set<string>();
      for (const artifact of rendered) {
        const key = artifact.part.filename.normalize("NFC").toLowerCase();
        if (renderedFilenames.has(key)) {
          throw new InventoryDocumentRunError("GENERATION_FAILED");
        }
        renderedFilenames.add(key);
      }

      infrastructureErrorCode = "STORAGE_FAILED";
      for (const artifact of rendered) {
        await this.refreshLease(claimed);
        const body = Buffer.from(artifact.part.bytes);
        const sha256 = createHash("sha256").update(body).digest("hex");
        const objectKey = this.objectKey(claimed, artifact);
        attemptedObjectKeys.push(objectKey);
        const stored = await this.storage.putVerified(
          objectKey,
          body,
          artifact.part.mimeType,
          sha256,
        );
        uploaded.push({ ...artifact, objectKey, byteSize: stored.byteSize, sha256 });
      }

      infrastructureErrorCode = "GENERATION_FAILED";
      publicationAttempted = true;
      await this.publishReady(claimed, uploaded);
    } catch (error) {
      this.logger.warn(
        `inventory document run ${claimed.id} generation failed`,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      if (publicationAttempted) {
        try {
          if (await this.hasCommittedPublication(claimed)) return;
        } catch {
          throw error;
        }
      }
      await Promise.allSettled(attemptedObjectKeys.map((key) => this.storage.delete(key)));
      if (error instanceof InventoryDocumentClaimLostError) return;
      const safeError = safeDocumentErrorCode(error);
      if (safeError !== null) {
        await this.publishFailed(claimed, safeError);
        return;
      }
      if (attempt.retryCount < attempt.retryLimit) {
        await this.requeue(claimed);
      } else {
        await this.publishFailed(claimed, infrastructureErrorCode);
      }
      throw error;
    }
  }

  private async claim(runId: string): Promise<InventoryDocumentRunRow | undefined> {
    const [candidate] = await this.db
      .select()
      .from(schema.inventoryDocumentRuns)
      .where(eq(schema.inventoryDocumentRuns.id, runId))
      .limit(1);
    if (!candidate) return undefined;
    const leaseCutoff = new Date(Date.now() - PROCESSING_LEASE_MS);
    const [claimed] = await this.db
      .update(schema.inventoryDocumentRuns)
      .set({
        status: "processing",
        attemptCount: sql`${schema.inventoryDocumentRuns.attemptCount} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.inventoryDocumentRuns.tenantId, candidate.tenantId),
          eq(schema.inventoryDocumentRuns.id, runId),
          eq(schema.inventoryDocumentRuns.attemptCount, candidate.attemptCount),
          or(
            eq(schema.inventoryDocumentRuns.status, "queued"),
            and(
              eq(schema.inventoryDocumentRuns.status, "processing"),
              lte(schema.inventoryDocumentRuns.updatedAt, leaseCutoff),
            ),
          ),
        ),
      )
      .returning();
    return claimed;
  }

  private async refreshLease(claimed: InventoryDocumentRunRow): Promise<void> {
    const refreshed = await this.db
      .update(schema.inventoryDocumentRuns)
      .set({ updatedAt: new Date() })
      .where(this.ownedProcessingAttempt(claimed))
      .returning({ id: schema.inventoryDocumentRuns.id });
    if (refreshed.length === 0) throw new InventoryDocumentClaimLostError();
  }

  private objectKey(
    claimed: InventoryDocumentRunRow,
    artifact: Pick<UploadedArtifact, "formatId" | "formatVersion" | "part">,
  ): string {
    return `tenants/${claimed.tenantId}/inventory-documents/${claimed.id}/attempt-${claimed.attemptCount}/${artifact.formatId}-v${artifact.formatVersion}-part-${artifact.part.partNumber}`;
  }

  private async publishReady(
    claimed: InventoryDocumentRunRow,
    uploaded: readonly UploadedArtifact[],
  ): Promise<void> {
    const completedAt = new Date();
    await this.db.transaction(async (tx) => {
      const [inventory] = await tx
        .select({
          status: schema.inventories.status,
          resultRevision: schema.inventories.resultRevision,
        })
        .from(schema.inventories)
        .where(
          and(
            eq(schema.inventories.tenantId, claimed.tenantId),
            eq(schema.inventories.id, claimed.inventoryId),
          ),
        )
        .for("update");
      if (inventory?.status !== "closed" || inventory.resultRevision !== claimed.resultRevision) {
        throw new InventoryDocumentRunError("STALE_RESULT_REVISION");
      }
      await tx.insert(schema.inventoryDocumentArtifacts).values(
        uploaded.map(({ formatId, formatVersion, part, objectKey, byteSize, sha256 }) => ({
          tenantId: claimed.tenantId,
          runId: claimed.id,
          formatId,
          formatVersion,
          partNumber: part.partNumber,
          filename: part.filename,
          mimeType: part.mimeType,
          rowCount: part.rowCount,
          codeCount: part.codeCount,
          boxCount: part.boxCount,
          byteSize,
          sha256,
          objectKey,
        })),
      );
      const ready = await tx
        .update(schema.inventoryDocumentRuns)
        .set({ status: "ready", errorCode: null, completedAt, updatedAt: completedAt })
        .where(this.ownedProcessingAttempt(claimed))
        .returning({ id: schema.inventoryDocumentRuns.id });
      if (ready.length === 0) throw new InventoryDocumentClaimLostError();
      await this.writeAudit(tx, claimed, "inventory.document_run.completed", "success", {
        artifactCount: uploaded.length,
        attemptCount: claimed.attemptCount,
      });
    });
  }

  private async requeue(claimed: InventoryDocumentRunRow): Promise<void> {
    await this.db
      .update(schema.inventoryDocumentRuns)
      .set({ status: "queued", errorCode: null, completedAt: null, updatedAt: new Date() })
      .where(this.ownedProcessingAttempt(claimed));
  }

  private async publishFailed(
    claimed: InventoryDocumentRunRow,
    errorCode: InventoryDocumentSafeErrorCode,
  ): Promise<void> {
    const completedAt = new Date();
    await this.db.transaction(async (tx) => {
      const failed = await tx
        .update(schema.inventoryDocumentRuns)
        .set({ status: "failed", errorCode, completedAt, updatedAt: completedAt })
        .where(this.ownedProcessingAttempt(claimed))
        .returning({ id: schema.inventoryDocumentRuns.id });
      if (failed.length === 0) throw new InventoryDocumentClaimLostError();
      await this.writeAudit(tx, claimed, "inventory.document_run.failed", "failure", {
        errorCode,
        attemptCount: claimed.attemptCount,
      });
    });
  }

  private ownedProcessingAttempt(claimed: InventoryDocumentRunRow) {
    return and(
      eq(schema.inventoryDocumentRuns.tenantId, claimed.tenantId),
      eq(schema.inventoryDocumentRuns.id, claimed.id),
      eq(schema.inventoryDocumentRuns.status, "processing"),
      eq(schema.inventoryDocumentRuns.attemptCount, claimed.attemptCount),
    );
  }

  private async hasCommittedPublication(claimed: InventoryDocumentRunRow): Promise<boolean> {
    const [current] = await this.db
      .select({ status: schema.inventoryDocumentRuns.status })
      .from(schema.inventoryDocumentRuns)
      .where(
        and(
          eq(schema.inventoryDocumentRuns.tenantId, claimed.tenantId),
          eq(schema.inventoryDocumentRuns.id, claimed.id),
        ),
      )
      .limit(1);
    const artifacts = await this.db
      .select({ id: schema.inventoryDocumentArtifacts.id })
      .from(schema.inventoryDocumentArtifacts)
      .where(
        and(
          eq(schema.inventoryDocumentArtifacts.tenantId, claimed.tenantId),
          eq(schema.inventoryDocumentArtifacts.runId, claimed.id),
        ),
      );
    return current?.status === "ready" || artifacts.length > 0;
  }

  private async writeAudit(
    tx: InventoryDocumentTransaction,
    claimed: InventoryDocumentRunRow,
    action: string,
    outcome: "success" | "failure",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: claimed.tenantId,
      actorUserId: claimed.createdByUserId,
      action,
      outcome,
      targetType: "inventory_document_run",
      targetId: claimed.id,
      after: {
        inventoryId: claimed.inventoryId,
        resultRevision: claimed.resultRevision,
        selectedFormats: claimed.selectedFormats,
        ...metadata,
      },
    });
  }
}

class InventoryDocumentClaimLostError extends Error {}

class InventoryDocumentRunError extends Error {
  constructor(readonly code: InventoryDocumentSafeErrorCode) {
    super(code);
  }
}

function safeDocumentErrorCode(error: unknown): InventoryDocumentSafeErrorCode | null {
  if (error instanceof InventoryDocumentRunError || error instanceof InventoryResultSourceError) {
    return error.code;
  }
  if (error instanceof InventoryDocumentRegistryError) {
    switch (error.code) {
      case "FORMAT_UNKNOWN":
      case "FORMAT_SUPERSEDED":
      case "FORMAT_UNAVAILABLE":
        return error.code;
      case "INVALID_DESCRIPTOR":
      case "DUPLICATE_FORMAT_ID":
      case "DUPLICATE_FORMAT_VERSION":
        return "GENERATION_FAILED";
    }
  }
  if (error instanceof InventoryDocumentGenerationError) {
    switch (error.code) {
      case "VERIFIED_PRODUCTION_DATE_MISSING":
      case "INVALID_ORGANIZATION_INN":
        return error.code;
      default:
        return "GENERATION_FAILED";
    }
  }
  return null;
}

function generationMetadata(run: InventoryDocumentRunRow): InventoryDocumentGenerationMetadata {
  return {
    documentId: run.id,
    inventoryNumber: run.inventoryNumberSnapshot,
    fileDateTime: run.createdAt.toISOString(),
    operationDateTime: run.inventoryClosedAtSnapshot.toISOString(),
    organizationName: run.organizationNameSnapshot,
    organizationInn: run.organizationInnSnapshot ?? "",
  };
}

function validateGeneratedParts(
  generator: InventoryDocumentGenerator,
  parts: readonly InventoryDocumentGeneratedPart[],
): void {
  const { descriptor } = generator;
  if (parts.length === 0 || (!descriptor.supportsParts && parts.length !== 1)) {
    throw new InventoryDocumentRunError("GENERATION_FAILED");
  }
  const partNumbers = new Set<number>();
  const filenames = new Set<string>();
  for (const part of parts) {
    assertArchiveFilename(part.filename);
    if (
      !Number.isSafeInteger(part.partNumber) ||
      part.partNumber < 1 ||
      partNumbers.has(part.partNumber) ||
      filenames.has(part.filename.normalize("NFC").toLowerCase()) ||
      part.mimeType !== descriptor.mimeType ||
      !part.filename.endsWith(`.${descriptor.extension}`) ||
      (part.bytes.byteLength === 0 &&
        !(
          generator.allowsZeroByteArtifact === true &&
          (part.mimeType === "text/plain; charset=utf-8" ||
            part.mimeType === "application/xml; charset=utf-8") &&
          part.rowCount === 0 &&
          part.codeCount === 0 &&
          part.boxCount === 0
        )) ||
      ![part.rowCount, part.codeCount, part.boxCount].every(
        (count) => Number.isSafeInteger(count) && count >= 0,
      )
    ) {
      throw new InventoryDocumentRunError("GENERATION_FAILED");
    }
    partNumbers.add(part.partNumber);
    filenames.add(part.filename.normalize("NFC").toLowerCase());
  }
}

export function buildInventoryDocumentZip(
  runId: string,
  resultRevision: number,
  input: readonly InventoryDocumentZipArtifact[],
): Uint8Array {
  const artifacts = [...input].sort(
    (left, right) =>
      compareText(left.filename, right.filename) ||
      compareText(left.formatId, right.formatId) ||
      left.partNumber - right.partNumber,
  );
  const names = new Set<string>();
  for (const artifact of artifacts) {
    assertArchiveFilename(artifact.filename);
    const collisionKey = artifact.filename.normalize("NFC").toLowerCase();
    if (names.has(collisionKey)) {
      throw new Error("INVENTORY_DOCUMENT_ARCHIVE_FILENAME_COLLISION");
    }
    names.add(collisionKey);
    if (
      !SHA256.test(artifact.sha256) ||
      artifact.byteSize !== artifact.bytes.byteLength ||
      createHash("sha256").update(artifact.bytes).digest("hex") !== artifact.sha256
    ) {
      throw new Error("INVENTORY_DOCUMENT_ARCHIVE_ARTIFACT_INVALID");
    }
  }

  const manifest = {
    schemaVersion: 1,
    runId,
    resultRevision,
    artifacts: artifacts.map((artifact) => ({
      name: artifact.filename,
      mimeType: artifact.mimeType,
      bytes: artifact.byteSize,
      sha256: artifact.sha256,
      rowCount: artifact.rowCount,
      codeCount: artifact.codeCount,
      boxCount: artifact.boxCount,
      formatId: artifact.formatId,
      formatVersion: artifact.formatVersion,
      partNumber: artifact.partNumber,
    })),
  };
  const entries: Zippable = {
    "manifest.json": [strToU8(`${JSON.stringify(manifest, null, 2)}\n`), { mtime: ZIP_MTIME }],
  };
  for (const artifact of artifacts) {
    entries[artifact.filename] = [artifact.bytes, { mtime: ZIP_MTIME }];
  }
  return zipSync(entries, { level: 9, mtime: ZIP_MTIME });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertArchiveFilename(filename: string): void {
  const caseFolded = filename.normalize("NFC").toLowerCase();
  if (
    filename.length === 0 ||
    filename.length > 200 ||
    caseFolded === "manifest.json" ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes(":") ||
    filename.includes("..") ||
    filename.startsWith(".") ||
    filename.endsWith(".") ||
    filename.endsWith(" ") ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename) ||
    Array.from(filename).some((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) ||
    filename.normalize("NFC") !== filename
  ) {
    throw new Error("INVENTORY_DOCUMENT_ARCHIVE_FILENAME_INVALID");
  }
}
