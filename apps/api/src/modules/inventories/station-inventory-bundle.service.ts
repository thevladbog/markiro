import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, gt, isNull } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";

import { DB } from "../../auth/auth.module";
import {
  BOX_EXTENSION_DIGIT,
  deriveIssuerPrefix,
  SsccCapacityExhaustedException,
  SsccService,
} from "../sscc/sscc.service";
import {
  parseStationInventoryManifest,
  type StationInventoryBundleCodesDto,
  type StationInventoryBundleCodesQueryDto,
  type StationInventoryBundleManifestDto,
  type StationInventoryManifest,
} from "./station-inventory.dto";

type InventoryTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type InventoryExecutor = Pick<Db, "select">;

const INVENTORY_BOX_BLOCK_SIZE = 2000;

@Injectable()
export class StationInventoryBundleService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sscc: SsccService,
  ) {}

  getManifest(
    tenantId: string,
    inventoryId: string,
    deviceId: string,
  ): Promise<StationInventoryBundleManifestDto> {
    return this.db.transaction(async (tx) => {
      await this.assertActiveParticipant(tx, tenantId, inventoryId, deviceId);
      return this.prepareJoinManifest(tx, tenantId, inventoryId, deviceId);
    });
  }

  async prepareJoinManifest(
    tx: InventoryTx,
    tenantId: string,
    inventoryId: string,
    deviceId: string,
  ): Promise<StationInventoryBundleManifestDto> {
    const manifest = await this.loadStoredManifest(tx, tenantId, inventoryId);
    if (manifest.mode === "check") {
      return { ...manifest, sscc: null, ssccRevokedFrom: [] };
    }

    if (manifest.boxLabelTemplate === null) {
      throw new ConflictException({ code: "INVENTORY_BUNDLE_INVALID" });
    }

    const [profile] = await tx
      .select({ gln: schema.orgProfiles.gln })
      .from(schema.orgProfiles)
      .where(eq(schema.orgProfiles.tenantId, tenantId));
    let issuerPrefix: string;
    try {
      if (!profile?.gln) throw new BadRequestException();
      issuerPrefix = deriveIssuerPrefix(profile.gln, "organisation profile");
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      throw new ConflictException({ code: "INVENTORY_SSCC_UNAVAILABLE" });
    }

    try {
      const sscc = await this.sscc.allocateForBundle(
        tenantId,
        issuerPrefix,
        BOX_EXTENSION_DIGIT,
        deviceId,
        INVENTORY_BOX_BLOCK_SIZE,
        tx,
      );
      const ssccRevokedFrom = await this.sscc.revokedFromSerials(
        tenantId,
        issuerPrefix,
        BOX_EXTENSION_DIGIT,
        deviceId,
        tx,
      );
      return { ...manifest, sscc, ssccRevokedFrom };
    } catch (error) {
      if (!(error instanceof SsccCapacityExhaustedException)) throw error;
      throw new ConflictException({ code: "INVENTORY_SSCC_UNAVAILABLE" });
    }
  }

  getCodes(
    tenantId: string,
    inventoryId: string,
    deviceId: string,
    query: StationInventoryBundleCodesQueryDto,
  ): Promise<StationInventoryBundleCodesDto> {
    return this.db.transaction(async (tx) => {
      await this.assertActiveParticipant(tx, tenantId, inventoryId, deviceId);
      const manifest = await this.loadStoredManifest(tx, tenantId, inventoryId);
      const predicates = [
        eq(schema.inventorySnapshotCodes.tenantId, tenantId),
        eq(schema.inventorySnapshotCodes.snapshotId, manifest.snapshotId),
      ];
      if (query.cursor !== undefined) {
        predicates.push(gt(schema.inventorySnapshotCodes.codeHash, query.cursor));
      }
      const rows = await tx
        .select({
          codeHash: schema.inventorySnapshotCodes.codeHash,
          canonicalRaw: schema.inventorySnapshotCodes.canonicalRaw,
          gtin14: schema.inventorySnapshotCodes.gtin14,
          serial: schema.inventorySnapshotCodes.serial,
          sourceStatus: schema.inventorySnapshotCodes.sourceStatus,
          sourceState: schema.inventorySnapshotCodes.sourceState,
          sourceProductionDate: schema.inventorySnapshotCodes.sourceProductionDate,
          parentSscc: schema.inventorySnapshotCodes.parentSscc,
          expected: schema.inventorySnapshotCodes.expected,
          protected: schema.inventorySnapshotCodes.protected,
        })
        .from(schema.inventorySnapshotCodes)
        .where(and(...predicates))
        .orderBy(asc(schema.inventorySnapshotCodes.codeHash))
        .limit(query.limit + 1);

      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(0, query.limit) : rows;
      return {
        snapshotId: manifest.snapshotId,
        snapshotRevision: manifest.snapshotRevision,
        combinedDigest: manifest.combinedDigest,
        items,
        nextCursor: hasMore ? (items.at(-1)?.codeHash ?? null) : null,
      };
    });
  }

  private async assertActiveParticipant(
    executor: InventoryExecutor,
    tenantId: string,
    inventoryId: string,
    deviceId: string,
  ): Promise<void> {
    const [participant] = await executor
      .select({ id: schema.inventoryDeviceParticipants.id })
      .from(schema.inventoryDeviceParticipants)
      .where(
        and(
          eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
          eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
          eq(schema.inventoryDeviceParticipants.deviceId, deviceId),
          isNull(schema.inventoryDeviceParticipants.leftAt),
        ),
      );
    if (!participant) throw new NotFoundException();
  }

  private async loadStoredManifest(
    executor: InventoryExecutor,
    tenantId: string,
    inventoryId: string,
  ): Promise<StationInventoryManifest> {
    const [inventory] = await executor
      .select({
        id: schema.inventories.id,
        status: schema.inventories.status,
        mode: schema.inventories.mode,
        productId: schema.inventories.productId,
        lineId: schema.inventories.lineId,
        activeSnapshotId: schema.inventories.activeSnapshotId,
        stationManifest: schema.inventories.stationManifest,
      })
      .from(schema.inventories)
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    if (!inventory || inventory.status !== "running" || inventory.activeSnapshotId === null) {
      throw new NotFoundException();
    }

    let manifest: StationInventoryManifest;
    try {
      manifest = parseStationInventoryManifest(inventory.stationManifest);
    } catch {
      throw new ConflictException({ code: "INVENTORY_BUNDLE_INVALID" });
    }
    const [snapshot] = await executor
      .select({
        id: schema.inventorySnapshots.id,
        revision: schema.inventorySnapshots.revision,
        combinedDigest: schema.inventorySnapshots.combinedDigest,
        emitted: schema.inventorySnapshots.emittedCount,
        introduced: schema.inventorySnapshots.introducedCount,
        applied: schema.inventorySnapshots.appliedCount,
        retired: schema.inventorySnapshots.retiredCount,
        writtenOff: schema.inventorySnapshots.writtenOffCount,
        disaggregation: schema.inventorySnapshots.disaggregationCount,
      })
      .from(schema.inventorySnapshots)
      .where(
        and(
          eq(schema.inventorySnapshots.tenantId, tenantId),
          eq(schema.inventorySnapshots.inventoryId, inventoryId),
          eq(schema.inventorySnapshots.id, inventory.activeSnapshotId),
        ),
      );
    const codeCount = snapshot
      ? snapshot.emitted +
        snapshot.introduced +
        snapshot.applied +
        snapshot.retired +
        snapshot.writtenOff +
        snapshot.disaggregation
      : -1;
    if (
      !snapshot ||
      snapshot.revision !== 1 ||
      manifest.inventoryId !== inventory.id ||
      manifest.snapshotId !== snapshot.id ||
      manifest.snapshotRevision !== snapshot.revision ||
      manifest.combinedDigest !== snapshot.combinedDigest ||
      manifest.codeCount !== codeCount ||
      manifest.mode !== inventory.mode ||
      manifest.productId !== inventory.productId ||
      manifest.lineId !== inventory.lineId
    ) {
      throw new ConflictException({ code: "INVENTORY_BUNDLE_INVALID" });
    }
    return manifest;
  }
}
