import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";
import {
  DomainError,
  INVENTORY_CHZ_STATUSES,
  parseLabelTemplate,
  type LabelTemplateSpec,
} from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import type { InventorySnapshotCountsDto } from "./dto";
import {
  parseStationInventoryManifest,
  STATION_INVENTORY_LIMITS,
  type StationInventoryLabelTemplateDescriptor,
  type StationInventoryManifest,
} from "./station-inventory.dto";

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
    combinedDigest: string;
    counts: InventorySnapshotCountsDto;
  };
  product: { id: string; name: string; gtin14: string };
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
          return parseStationInventoryManifest(inventory.stationManifest);
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
    if (!snapshot || snapshot.revision !== 1 || !/^[0-9a-f]{64}$/.test(snapshot.combinedDigest)) {
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

    const [product] = await tx
      .select({
        id: schema.products.id,
        name: schema.products.name,
        gtin14: schema.products.gtin14,
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

    const [line] = await tx
      .select({ id: schema.lines.id, name: schema.lines.name })
      .from(schema.lines)
      .where(and(eq(schema.lines.tenantId, tenantId), eq(schema.lines.id, inventory.lineId)))
      .for("share");
    if (!line) throw new BadRequestException({ code: "INVENTORY_LINE_INVALID" });

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
        combinedDigest: snapshot.combinedDigest,
        counts,
      },
      product: { id: product.id, name: product.name, gtin14: product.gtin14 },
      line,
      boxLabelTemplate: await this.resolveBoxLabelTemplate(tx, tenantId, inventory),
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
      combinedDigest: snapshot.combinedDigest,
      codeCount:
        snapshot.counts.emitted +
        snapshot.counts.introduced +
        snapshot.counts.applied +
        snapshot.counts.retired +
        snapshot.counts.writtenOff +
        snapshot.counts.disaggregation,
      productId: product.id,
      productName: product.name,
      gtin14: product.gtin14,
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
