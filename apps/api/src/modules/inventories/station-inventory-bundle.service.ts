import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, gt, isNull } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";
import { inventorySnapshotPageDigest } from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import { SubscriptionReadOnlyException } from "../../subscriptions/subscription-errors";
import type {
  EffectiveEntitlements,
  EntitlementsExecutor,
} from "../../subscriptions/entitlements.types";
import {
  BOX_EXTENSION_DIGIT,
  deriveIssuerPrefix,
  SsccCapacityExhaustedException,
  SsccService,
} from "../sscc/sscc.service";
import {
  type StationInventoryBundleCodesDto,
  type StationInventoryBundleCodesQueryDto,
  type StationInventoryBundleManifestDto,
  type StationInventoryManifest,
} from "./station-inventory.dto";
import {
  resolveStoredStationInventoryManifest,
  type StoredStationManifestFacts,
} from "./station-inventory-manifest-upgrade";

type InventoryTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type InventoryExecutor = EntitlementsExecutor;

interface StoredManifestFacts extends StoredStationManifestFacts {
  startedAt: Date | null;
}

const INVENTORY_BOX_BLOCK_SIZE = 2000;

@Injectable()
export class StationInventoryBundleService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sscc: SsccService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async listRunningManifests(
    tenantId: string,
    lineId: string,
  ): Promise<StationInventoryManifest[]> {
    const access = await this.entitlements.resolveRecovery(tenantId, this.db, new Date());
    const rows = await this.selectStoredManifestFacts(this.db)
      .where(
        and(
          eq(schema.inventories.tenantId, tenantId),
          eq(schema.inventories.status, "running"),
          eq(schema.inventories.lineId, lineId),
        ),
      )
      .orderBy(asc(schema.inventories.number), asc(schema.inventories.id));
    return Promise.all(
      rows
        .filter((row) => this.isRecoveryEligible(access, row.startedAt))
        .map((row) => this.resolveStoredManifest(this.db, tenantId, row)),
    );
  }

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
      return { ...manifest, sscc: null, ssccRevokedFrom: [], ssccRevokedBlocks: [] };
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
      const sscc = await this.sscc.allocateOrderedForBundle(
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
      const ssccRevokedBlocks = await this.sscc.revokedBlocks(
        tenantId,
        issuerPrefix,
        BOX_EXTENSION_DIGIT,
        deviceId,
        tx,
      );
      return { ...manifest, sscc, ssccRevokedFrom, ssccRevokedBlocks };
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
      const cursor = query.cursor ?? null;
      const nextCursor = hasMore ? (items.at(-1)?.codeHash ?? null) : null;
      return {
        snapshotId: manifest.snapshotId,
        snapshotRevision: manifest.snapshotRevision,
        snapshotFixedAt: manifest.snapshotFixedAt,
        combinedDigest: manifest.combinedDigest,
        contentDigest: manifest.contentDigest,
        cursor,
        items,
        nextCursor,
        pageDigest: inventorySnapshotPageDigest({
          snapshotId: manifest.snapshotId,
          snapshotFixedAt: manifest.snapshotFixedAt,
          contentDigest: manifest.contentDigest,
          cursor,
          items,
          nextCursor,
        }),
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

  async loadStoredManifest(
    executor: InventoryExecutor,
    tenantId: string,
    inventoryId: string,
  ): Promise<StationInventoryManifest> {
    const [inventory] = await this.selectStoredManifestFacts(executor).where(
      and(
        eq(schema.inventories.tenantId, tenantId),
        eq(schema.inventories.id, inventoryId),
        eq(schema.inventories.status, "running"),
      ),
    );
    if (!inventory) throw new NotFoundException();

    const access = await this.entitlements.resolveRecovery(tenantId, executor, new Date());
    if (!this.isRecoveryEligible(access, inventory.startedAt)) {
      throw new SubscriptionReadOnlyException();
    }
    return this.resolveStoredManifest(executor, tenantId, inventory);
  }

  private async resolveStoredManifest(
    executor: InventoryExecutor,
    tenantId: string,
    inventory: StoredManifestFacts,
  ): Promise<StationInventoryManifest> {
    try {
      return await resolveStoredStationInventoryManifest(executor, tenantId, inventory);
    } catch {
      throw new ConflictException({ code: "INVENTORY_BUNDLE_INVALID" });
    }
  }

  private isRecoveryEligible(access: EffectiveEntitlements, startedAt: Date | null): boolean {
    if (access.access !== "read_only") return true;
    const endsAt = access.subscription?.endsAt ?? null;
    return endsAt !== null && startedAt !== null && startedAt < endsAt;
  }

  private selectStoredManifestFacts(executor: InventoryExecutor) {
    return executor
      .select({
        id: schema.inventories.id,
        number: schema.inventories.number,
        mode: schema.inventories.mode,
        productId: schema.inventories.productId,
        gtin14Snapshot: schema.inventories.gtin14Snapshot,
        lineId: schema.inventories.lineId,
        productionDateFrom: schema.inventories.productionDateFrom,
        productionDateTo: schema.inventories.productionDateTo,
        boxLabelTemplateId: schema.inventories.boxLabelTemplateId,
        activeSnapshotId: schema.inventories.activeSnapshotId,
        stationManifest: schema.inventories.stationManifest,
        authoritativeProductName: schema.products.name,
        authoritativeProductPrintName: schema.products.printName,
        authoritativeEgaisCode: schema.products.egaisCode,
        authoritativeShelfLifeDays: schema.products.shelfLifeDays,
        startedAt: schema.inventories.startedAt,
        snapshotId: schema.inventorySnapshots.id,
        snapshotRevision: schema.inventorySnapshots.revision,
        snapshotFixedAt: schema.inventorySnapshots.fixedAt,
        snapshotCombinedDigest: schema.inventorySnapshots.combinedDigest,
        emitted: schema.inventorySnapshots.emittedCount,
        introduced: schema.inventorySnapshots.introducedCount,
        applied: schema.inventorySnapshots.appliedCount,
        retired: schema.inventorySnapshots.retiredCount,
        writtenOff: schema.inventorySnapshots.writtenOffCount,
        disaggregation: schema.inventorySnapshots.disaggregationCount,
      })
      .from(schema.inventories)
      .leftJoin(
        schema.inventorySnapshots,
        and(
          eq(schema.inventorySnapshots.tenantId, schema.inventories.tenantId),
          eq(schema.inventorySnapshots.inventoryId, schema.inventories.id),
          eq(schema.inventorySnapshots.id, schema.inventories.activeSnapshotId),
        ),
      )
      .leftJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.inventories.tenantId),
          eq(schema.products.id, schema.inventories.productId),
        ),
      );
  }
}
