import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";

import { DB } from "../../auth/auth.module";
import { StationInventoryBundleService } from "./station-inventory-bundle.service";
import {
  parseInventoryTaskBarcode,
  parseStationInventoryManifest,
  type JoinStationInventoryDto,
  type ResolveStationInventoryBarcodeResponseDto,
  type StationInventoryBundleManifestDto,
  type StationInventoryManifest,
  type StationInventoryTaskDto,
  type StationInventoryTaskListDto,
} from "./station-inventory.dto";

@Injectable()
export class StationInventoryAccessService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly bundles: StationInventoryBundleService,
  ) {}

  async list(tenantId: string, deviceLineId: string | null): Promise<StationInventoryTaskListDto> {
    if (deviceLineId === null) return { items: [] };
    const rows = await this.db
      .select({ stationManifest: schema.inventories.stationManifest })
      .from(schema.inventories)
      .where(
        and(
          eq(schema.inventories.tenantId, tenantId),
          eq(schema.inventories.status, "running"),
          eq(schema.inventories.lineId, deviceLineId),
        ),
      )
      .orderBy(asc(schema.inventories.number), asc(schema.inventories.id));
    return {
      items: rows.map((row) => this.taskFromStoredManifest(row.stationManifest, deviceLineId)),
    };
  }

  async resolveBarcode(
    tenantId: string,
    deviceLineId: string | null,
    barcode: string,
  ): Promise<ResolveStationInventoryBarcodeResponseDto> {
    const inventoryId = parseInventoryTaskBarcode(barcode);
    if (inventoryId === null) throw new NotFoundException();
    const [inventory] = await this.db
      .select({ stationManifest: schema.inventories.stationManifest })
      .from(schema.inventories)
      .where(
        and(
          eq(schema.inventories.tenantId, tenantId),
          eq(schema.inventories.id, inventoryId),
          eq(schema.inventories.status, "running"),
        ),
      );
    if (!inventory) throw new NotFoundException();
    const task = this.taskFromStoredManifest(inventory.stationManifest);
    return {
      task,
      deviceLineId,
      requiresDifferentLineConfirmation: deviceLineId !== task.lineId,
    };
  }

  join(
    tenantId: string,
    deviceId: string,
    deviceLineId: string | null,
    inventoryId: string,
    input: JoinStationInventoryDto,
  ): Promise<StationInventoryBundleManifestDto> {
    if (deviceLineId === null) {
      throw new ConflictException({ code: "INVENTORY_DEVICE_LINE_REQUIRED" });
    }
    return this.db.transaction(async (tx) => {
      const [inventory] = await tx
        .select({
          id: schema.inventories.id,
          status: schema.inventories.status,
          lineId: schema.inventories.lineId,
          activeSnapshotId: schema.inventories.activeSnapshotId,
        })
        .from(schema.inventories)
        .where(
          and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
        )
        .for("update");
      if (!inventory) throw new NotFoundException();
      if (inventory.status !== "running" || inventory.activeSnapshotId === null) {
        throw new ConflictException({ code: "INVENTORY_NOT_RUNNING" });
      }

      const [operator] = await tx
        .select({ id: schema.employees.id })
        .from(schema.employees)
        .innerJoin(
          schema.operatorCredentials,
          and(
            eq(schema.operatorCredentials.tenantId, schema.employees.tenantId),
            eq(schema.operatorCredentials.employeeId, schema.employees.id),
          ),
        )
        .where(
          and(
            eq(schema.employees.tenantId, tenantId),
            eq(schema.employees.id, input.operatorId),
            eq(schema.employees.status, "active"),
            eq(schema.operatorCredentials.active, true),
          ),
        );
      if (!operator) {
        throw new ConflictException({ code: "INVENTORY_OPERATOR_UNAVAILABLE" });
      }

      const differentLine = deviceLineId !== inventory.lineId;
      const barcodeInventoryId =
        input.barcode === undefined ? null : parseInventoryTaskBarcode(input.barcode);
      if (input.barcode !== undefined && barcodeInventoryId !== inventoryId) {
        throw new ConflictException({ code: "INVENTORY_TASK_BARCODE_INVALID" });
      }
      if (differentLine && input.barcode === undefined) {
        throw new ConflictException({ code: "INVENTORY_TASK_BARCODE_REQUIRED" });
      }
      if (differentLine && input.confirmDifferentLine !== true) {
        throw new ConflictException({ code: "INVENTORY_DIFFERENT_LINE_CONFIRMATION_REQUIRED" });
      }

      const manifest = await this.bundles.prepareJoinManifest(tx, tenantId, inventoryId, deviceId);
      const now = new Date();
      const joinMethod = differentLine ? "task_barcode" : "assigned_line";
      await tx
        .insert(schema.inventoryDeviceParticipants)
        .values({
          tenantId,
          inventoryId,
          deviceId,
          operatorId: operator.id,
          configuredLineId: deviceLineId,
          joinMethod,
          differentLineConfirmed: differentLine,
          joinedAt: now,
          heartbeatAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.inventoryDeviceParticipants.tenantId,
            schema.inventoryDeviceParticipants.inventoryId,
            schema.inventoryDeviceParticipants.deviceId,
          ],
          set: {
            operatorId: operator.id,
            configuredLineId: deviceLineId,
            joinMethod,
            differentLineConfirmed: differentLine,
            joinedAt: now,
            leftAt: null,
            heartbeatAt: now,
            pendingEventCount: 0,
            openBoxCount: 0,
          },
        });
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId: null,
        action: "inventory.station.joined",
        outcome: "success",
        targetType: "inventory",
        targetId: inventoryId,
        after: {
          tenantId,
          inventoryId,
          snapshotId: manifest.snapshotId,
          snapshotRevision: manifest.snapshotRevision,
          deviceId,
          operatorId: operator.id,
          configuredLineId: deviceLineId,
          inventoryLineId: inventory.lineId,
          joinMethod,
          taskBarcodeUsed: input.barcode !== undefined,
          differentLineConfirmed: differentLine,
        },
      });
      return manifest;
    });
  }

  private taskFromStoredManifest(value: unknown, expectedLineId?: string): StationInventoryTaskDto {
    let manifest: StationInventoryManifest;
    try {
      manifest = parseStationInventoryManifest(value);
    } catch {
      throw new ConflictException({ code: "INVENTORY_BUNDLE_INVALID" });
    }
    if (expectedLineId !== undefined && manifest.lineId !== expectedLineId) {
      throw new ConflictException({ code: "INVENTORY_BUNDLE_INVALID" });
    }
    return {
      inventoryId: manifest.inventoryId,
      inventoryNumber: manifest.inventoryNumber,
      productName: manifest.productName,
      mode: manifest.mode,
      lineId: manifest.lineId,
      lineName: manifest.lineName,
      productionDateFrom: manifest.productionDateFrom,
      productionDateTo: manifest.productionDateTo,
    };
  }
}
