import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";
import {
  DomainError,
  INVENTORY_CHZ_STATUSES,
  inventorySnapshotContentDigest,
  parseLabelTemplate,
  type LabelTemplateSpec,
} from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import type { InventorySnapshotCountsDto } from "./dto";
import {
  STATION_INVENTORY_LIMITS,
  parseStationInventoryManifest,
  type StationInventoryLabelTemplateDescriptor,
  type StationInventoryManifest,
} from "./station-inventory.dto";
import {
  resolveStoredStationInventoryManifest,
  type StoredStationManifestFacts,
} from "./station-inventory-manifest-upgrade";

type InventoryTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface LockedInventory {
  id: string;
  number: string;
  status: "draft" | "preparing" | "ready" | "running" | "closed" | "completed";
  mode: "check" | "repack";
  productId: string;
  gtin14Snapshot: string;
  lineId: string;
  productionDateFrom: string;
  productionDateTo: string;
  boxLabelTemplateId: string | null;
  activeSnapshotId: string | null;
  stationManifest: unknown;
}

interface StartFacts {
  inventory: LockedInventory;
  snapshot: {
    id: string;
    revision: number;
    fixedAt: Date;
    combinedDigest: string;
    contentDigest: string;
    counts: InventorySnapshotCountsDto;
  };
  product: {
    id: string;
    name: string;
    printName: string | null;
    gtin14: string;
    egaisCode: string | null;
    shelfLifeDays: number | null;
    boxCapacity: number;
  };
  line: { id: string; name: string };
  boxLabelTemplate: StationInventoryLabelTemplateDescriptor | null;
}

@Injectable()
export class InventoryLifecycleService {
  constructor(@Inject(DB) private readonly db: Db) {}

  start(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
  ): Promise<StationInventoryManifest> {
    return this.db.transaction(async (tx) => {
      const inventory = await this.lockInventory(tx, tenantId, inventoryId);
      if (inventory.status !== "ready" && inventory.status !== "running") {
        throw new ConflictException({ code: "INVENTORY_START_REQUIRES_READY" });
      }

      if (inventory.status === "running") {
        try {
          const facts = await this.loadStoredManifestFacts(tx, tenantId, inventory);
          return await resolveStoredStationInventoryManifest(tx, tenantId, facts);
        } catch {
          throw new ConflictException({ code: "INVENTORY_STORED_MANIFEST_INVALID" });
        }
      }

      const facts = await this.loadStartFacts(tx, tenantId, inventory);
      const generatedManifest = this.toManifest(facts);
      let manifest: StationInventoryManifest;
      try {
        manifest = parseStationInventoryManifest(generatedManifest);
      } catch {
        throw new ConflictException({ code: "INVENTORY_STORED_MANIFEST_INVALID" });
      }
      const startedAt = new Date();
      await tx
        .update(schema.inventories)
        .set({
          status: "running",
          stationManifest: manifest,
          startedByUserId: actorUserId,
          startedAt,
          updatedAt: startedAt,
        })
        .where(
          and(
            eq(schema.inventories.tenantId, tenantId),
            eq(schema.inventories.id, inventory.id),
            eq(schema.inventories.status, "ready"),
          ),
        );
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "inventory.started",
        outcome: "success",
        targetType: "inventory",
        targetId: inventory.id,
        after: {
          tenantId,
          actorUserId,
          inventoryId: inventory.id,
          snapshotId: facts.snapshot.id,
          snapshotRevision: facts.snapshot.revision,
          combinedDigest: facts.snapshot.combinedDigest,
          counts: facts.snapshot.counts,
          productId: facts.product.id,
          productName: facts.product.name,
          gtin14: facts.product.gtin14,
          boxCapacity: facts.product.boxCapacity,
          lineId: facts.line.id,
          lineName: facts.line.name,
          mode: inventory.mode,
        },
      });

      return manifest;
    });
  }

  private async lockInventory(
    tx: InventoryTx,
    tenantId: string,
    inventoryId: string,
  ): Promise<LockedInventory> {
    const [inventory] = await tx
      .select({
        id: schema.inventories.id,
        number: schema.inventories.number,
        status: schema.inventories.status,
        mode: schema.inventories.mode,
        productId: schema.inventories.productId,
        gtin14Snapshot: schema.inventories.gtin14Snapshot,
        lineId: schema.inventories.lineId,
        productionDateFrom: schema.inventories.productionDateFrom,
        productionDateTo: schema.inventories.productionDateTo,
        boxLabelTemplateId: schema.inventories.boxLabelTemplateId,
        activeSnapshotId: schema.inventories.activeSnapshotId,
        stationManifest: schema.inventories.stationManifest,
      })
      .from(schema.inventories)
      .where(and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)))
      .for("update");
    if (!inventory) throw new NotFoundException();
    return inventory;
  }

  private async loadStartFacts(
    tx: InventoryTx,
    tenantId: string,
    inventory: LockedInventory,
  ): Promise<StartFacts> {
    if (inventory.activeSnapshotId === null) {
      throw new ConflictException({ code: "INVENTORY_SNAPSHOT_INCOMPLETE" });
    }
    const [snapshot] = await tx
      .select({
        id: schema.inventorySnapshots.id,
        revision: schema.inventorySnapshots.revision,
        combinedDigest: schema.inventorySnapshots.combinedDigest,
        fixedAt: schema.inventorySnapshots.fixedAt,
        productName: schema.inventorySnapshots.productName,
        lineName: schema.inventorySnapshots.lineName,
        boxCapacity: schema.inventorySnapshots.boxCapacity,
        emitted: schema.inventorySnapshots.emittedCount,
        introduced: schema.inventorySnapshots.introducedCount,
        applied: schema.inventorySnapshots.appliedCount,
        retired: schema.inventorySnapshots.retiredCount,
        writtenOff: schema.inventorySnapshots.writtenOffCount,
        disaggregation: schema.inventorySnapshots.disaggregationCount,
        protected: schema.inventorySnapshots.protectedCount,
        expected: schema.inventorySnapshots.expectedCount,
        packages: schema.inventorySnapshots.packageCount,
        loose: schema.inventorySnapshots.looseCount,
      })
      .from(schema.inventorySnapshots)
      .where(
        and(
          eq(schema.inventorySnapshots.tenantId, tenantId),
          eq(schema.inventorySnapshots.inventoryId, inventory.id),
          eq(schema.inventorySnapshots.id, inventory.activeSnapshotId),
        ),
      )
      .for("share");
    if (
      !snapshot ||
      snapshot.revision !== 1 ||
      !/^[0-9a-f]{64}$/.test(snapshot.combinedDigest) ||
      snapshot.productName.length === 0 ||
      snapshot.lineName.length === 0
    ) {
      throw new ConflictException({ code: "INVENTORY_SNAPSHOT_INCOMPLETE" });
    }

    const inputs = await tx
      .select({ status: schema.inventorySnapshotInputs.status })
      .from(schema.inventorySnapshotInputs)
      .where(
        and(
          eq(schema.inventorySnapshotInputs.tenantId, tenantId),
          eq(schema.inventorySnapshotInputs.inventoryId, inventory.id),
          eq(schema.inventorySnapshotInputs.snapshotId, snapshot.id),
        ),
      )
      .for("share");
    const inputStatuses = new Set(inputs.map((input) => input.status));
    if (
      inputs.length !== INVENTORY_CHZ_STATUSES.length ||
      !INVENTORY_CHZ_STATUSES.every((status) => inputStatuses.has(status))
    ) {
      throw new ConflictException({ code: "INVENTORY_SNAPSHOT_INCOMPLETE" });
    }

    const contentRows = await tx
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
      .where(
        and(
          eq(schema.inventorySnapshotCodes.tenantId, tenantId),
          eq(schema.inventorySnapshotCodes.snapshotId, snapshot.id),
        ),
      )
      .orderBy(asc(schema.inventorySnapshotCodes.codeHash))
      .for("share");
    if (
      contentRows.length !==
      snapshot.emitted +
        snapshot.introduced +
        snapshot.applied +
        snapshot.retired +
        snapshot.writtenOff +
        snapshot.disaggregation
    ) {
      throw new ConflictException({ code: "INVENTORY_SNAPSHOT_INCOMPLETE" });
    }

    const [product] = await tx
      .select({
        id: schema.products.id,
        printName: schema.products.printName,
        gtin14: schema.products.gtin14,
        egaisCode: schema.products.egaisCode,
        shelfLifeDays: schema.products.shelfLifeDays,
        status: schema.products.status,
      })
      .from(schema.products)
      .where(
        and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, inventory.productId)),
      )
      .for("share");
    if (!product) throw new BadRequestException({ code: "INVENTORY_PRODUCT_INVALID" });
    if (product.status !== "active") {
      throw new UnprocessableEntityException({ code: "INVENTORY_PRODUCT_INACTIVE" });
    }
    if (product.gtin14 !== inventory.gtin14Snapshot) {
      throw new ConflictException({ code: "INVENTORY_PRODUCT_GTIN_CHANGED" });
    }
    if (
      !Number.isInteger(snapshot.boxCapacity) ||
      snapshot.boxCapacity === null ||
      snapshot.boxCapacity <= 0
    ) {
      throw new ConflictException({ code: "INVENTORY_BOX_CAPACITY_INVALID" });
    }

    const counts: InventorySnapshotCountsDto = {
      emitted: snapshot.emitted,
      introduced: snapshot.introduced,
      applied: snapshot.applied,
      retired: snapshot.retired,
      writtenOff: snapshot.writtenOff,
      disaggregation: snapshot.disaggregation,
      protected: snapshot.protected,
      expected: snapshot.expected,
      packages: snapshot.packages,
      loose: snapshot.loose,
    };
    return {
      inventory,
      snapshot: {
        id: snapshot.id,
        revision: snapshot.revision,
        fixedAt: snapshot.fixedAt,
        combinedDigest: snapshot.combinedDigest,
        contentDigest: inventorySnapshotContentDigest(contentRows),
        counts,
      },
      product: {
        id: product.id,
        name: snapshot.productName,
        printName: product.printName,
        gtin14: product.gtin14,
        egaisCode: product.egaisCode,
        shelfLifeDays: product.shelfLifeDays,
        boxCapacity: snapshot.boxCapacity,
      },
      line: { id: inventory.lineId, name: snapshot.lineName },
      boxLabelTemplate: await this.resolveBoxLabelTemplate(tx, tenantId, inventory),
    };
  }

  private async loadStoredManifestFacts(
    tx: InventoryTx,
    tenantId: string,
    inventory: LockedInventory,
  ): Promise<StoredStationManifestFacts> {
    if (inventory.activeSnapshotId === null) {
      throw new Error("Running inventory has no active snapshot");
    }
    const [snapshot] = await tx
      .select({
        id: schema.inventorySnapshots.id,
        revision: schema.inventorySnapshots.revision,
        fixedAt: schema.inventorySnapshots.fixedAt,
        combinedDigest: schema.inventorySnapshots.combinedDigest,
        productName: schema.inventorySnapshots.productName,
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
          eq(schema.inventorySnapshots.inventoryId, inventory.id),
          eq(schema.inventorySnapshots.id, inventory.activeSnapshotId),
        ),
      )
      .for("share");
    if (!snapshot) throw new Error("Running inventory snapshot is missing");
    const [product] = await tx
      .select({
        printName: schema.products.printName,
        egaisCode: schema.products.egaisCode,
        shelfLifeDays: schema.products.shelfLifeDays,
      })
      .from(schema.products)
      .where(
        and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, inventory.productId)),
      )
      .for("share");
    if (!product) throw new Error("Running inventory product is missing");

    return {
      id: inventory.id,
      number: inventory.number,
      mode: inventory.mode,
      productId: inventory.productId,
      gtin14Snapshot: inventory.gtin14Snapshot,
      lineId: inventory.lineId,
      productionDateFrom: inventory.productionDateFrom,
      productionDateTo: inventory.productionDateTo,
      boxLabelTemplateId: inventory.boxLabelTemplateId,
      activeSnapshotId: inventory.activeSnapshotId,
      stationManifest: inventory.stationManifest,
      authoritativeProductName: snapshot.productName,
      authoritativeProductPrintName: product.printName,
      authoritativeEgaisCode: product.egaisCode,
      authoritativeShelfLifeDays: product.shelfLifeDays,
      snapshotId: snapshot.id,
      snapshotRevision: snapshot.revision,
      snapshotFixedAt: snapshot.fixedAt,
      snapshotCombinedDigest: snapshot.combinedDigest,
      emitted: snapshot.emitted,
      introduced: snapshot.introduced,
      applied: snapshot.applied,
      retired: snapshot.retired,
      writtenOff: snapshot.writtenOff,
      disaggregation: snapshot.disaggregation,
    };
  }

  private async resolveBoxLabelTemplate(
    tx: InventoryTx,
    tenantId: string,
    inventory: LockedInventory,
  ): Promise<StationInventoryLabelTemplateDescriptor | null> {
    if (inventory.mode === "check") return null;
    if (inventory.boxLabelTemplateId === null) {
      throw new ConflictException({ code: "INVENTORY_PRINT_CONFIGURATION_INVALID" });
    }
    const [template] = await tx
      .select({
        id: schema.labelTemplates.id,
        name: schema.labelTemplates.name,
        spec: schema.labelTemplates.spec,
      })
      .from(schema.labelTemplates)
      .where(
        and(
          eq(schema.labelTemplates.tenantId, tenantId),
          eq(schema.labelTemplates.id, inventory.boxLabelTemplateId),
        ),
      )
      .for("share");
    if (!template) {
      throw new ConflictException({ code: "INVENTORY_PRINT_CONFIGURATION_INVALID" });
    }
    let spec: LabelTemplateSpec;
    try {
      spec = parseLabelTemplate(template.spec);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      throw new ConflictException({ code: "INVENTORY_PRINT_CONFIGURATION_INVALID" });
    }
    return { id: template.id, name: template.name, spec };
  }

  private toManifest(facts: StartFacts): StationInventoryManifest {
    const { inventory, snapshot, product, line, boxLabelTemplate } = facts;
    return {
      inventoryId: inventory.id,
      inventoryNumber: inventory.number,
      snapshotId: snapshot.id,
      snapshotRevision: 1,
      snapshotFixedAt: snapshot.fixedAt.toISOString(),
      combinedDigest: snapshot.combinedDigest,
      contentDigest: snapshot.contentDigest,
      codeCount:
        snapshot.counts.emitted +
        snapshot.counts.introduced +
        snapshot.counts.applied +
        snapshot.counts.retired +
        snapshot.counts.writtenOff +
        snapshot.counts.disaggregation,
      productId: product.id,
      productName: product.name,
      productPrintName: product.printName,
      egaisCode: product.egaisCode,
      shelfLifeDays: product.shelfLifeDays,
      gtin14: product.gtin14,
      boxCapacity: product.boxCapacity,
      mode: inventory.mode,
      lineId: line.id,
      lineName: line.name,
      productionDateFrom: inventory.productionDateFrom,
      productionDateTo: inventory.productionDateTo,
      boxLabelTemplate,
      limits: STATION_INVENTORY_LIMITS,
    };
  }
}
