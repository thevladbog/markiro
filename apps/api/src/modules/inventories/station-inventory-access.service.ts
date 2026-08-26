import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";

import { DB } from "../../auth/auth.module";
import { StationInventoryBundleService } from "./station-inventory-bundle.service";
import {
  parseInventoryTaskBarcode,
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
    const manifests = await this.bundles.listRunningManifests(tenantId, deviceLineId);
    return {
      items: manifests.map((manifest) => this.taskFromManifest(manifest)),
    };
  }

  async resolveBarcode(
    tenantId: string,
    deviceLineId: string | null,
    barcode: string,
  ): Promise<ResolveStationInventoryBarcodeResponseDto> {
    const inventoryId = parseInventoryTaskBarcode(barcode);
    if (inventoryId === null) throw new NotFoundException();
    const manifest = await this.bundles.loadStoredManifest(this.db, tenantId, inventoryId);
    const task = this.taskFromManifest(manifest);
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
      const joinMethod = input.barcode === undefined ? "assigned_line" : "task_barcode";
      const differentLineConfirmed = differentLine;

      const [existingParticipant] = await tx
        .select({
          operatorId: schema.inventoryDeviceParticipants.operatorId,
          configuredLineId: schema.inventoryDeviceParticipants.configuredLineId,
          joinMethod: schema.inventoryDeviceParticipants.joinMethod,
          differentLineConfirmed: schema.inventoryDeviceParticipants.differentLineConfirmed,
          leftAt: schema.inventoryDeviceParticipants.leftAt,
        })
        .from(schema.inventoryDeviceParticipants)
        .where(
          and(
            eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
            eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
            eq(schema.inventoryDeviceParticipants.deviceId, deviceId),
          ),
        )
        .for("update");
      if (existingParticipant?.leftAt === null) {
        if (
          existingParticipant.operatorId !== operator.id ||
          existingParticipant.configuredLineId !== deviceLineId ||
          existingParticipant.joinMethod !== joinMethod ||
          existingParticipant.differentLineConfirmed !== differentLineConfirmed
        ) {
          throw new ConflictException({ code: "INVENTORY_ACTIVE_PARTICIPANT_CONFLICT" });
        }
        return this.bundles.prepareJoinManifest(tx, tenantId, inventoryId, deviceId);
      }

      const manifest = await this.bundles.prepareJoinManifest(tx, tenantId, inventoryId, deviceId);
      const now = new Date();
      if (existingParticipant) {
        await tx
          .update(schema.inventoryDeviceParticipants)
          .set({
            operatorId: operator.id,
            configuredLineId: deviceLineId,
            joinMethod,
            differentLineConfirmed,
            joinedAt: now,
            leftAt: null,
            heartbeatAt: now,
            pendingEventCount: 0,
            openBoxCount: 0,
          })
          .where(
            and(
              eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
              eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
              eq(schema.inventoryDeviceParticipants.deviceId, deviceId),
            ),
          );
      } else {
        await tx.insert(schema.inventoryDeviceParticipants).values({
          tenantId,
          inventoryId,
          deviceId,
          operatorId: operator.id,
          configuredLineId: deviceLineId,
          joinMethod,
          differentLineConfirmed,
          joinedAt: now,
          heartbeatAt: now,
        });
      }
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
          differentLineConfirmed,
        },
      });
      return manifest;
    });
  }

  private taskFromManifest(manifest: StationInventoryManifest): StationInventoryTaskDto {
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
