import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { handheldSource } from "../pickup-orders/document-source";
import { PickupOrdersService } from "../pickup-orders/pickup-orders.service";
import { quarantineReplacementSubmission } from "../device-licensing/device-replacement-evidence";
import type { CreateOrderResultDto, CreatePickupDocumentInput } from "../pickup-orders/dto";
import type { StationWriteoffBootstrapDto, StationWriteoffDto } from "./dto";

@Injectable()
export class StationWriteoffsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly pickupOrders: PickupOrdersService,
  ) {}

  /**
   * The device asserts `operatorId`, exactly as `station-scans` does, so the
   * permission is re-decided here against live data. A client-side check is an
   * affordance for the operator; this is the gate.
   *
   * The tenant predicate is also what makes another tenant's employee
   * unreachable: they simply have no policy row within this tenant.
   */
  private async assertCanWriteoff(tenantId: string, operatorId: string): Promise<void> {
    const rows = await this.db
      .select({ canWriteoff: schema.employeePickupPolicies.canWriteoff })
      .from(schema.employeePickupPolicies)
      .innerJoin(
        schema.employees,
        and(
          eq(schema.employees.tenantId, schema.employeePickupPolicies.tenantId),
          eq(schema.employees.id, schema.employeePickupPolicies.employeeId),
        ),
      )
      .where(
        and(
          eq(schema.employeePickupPolicies.tenantId, tenantId),
          eq(schema.employeePickupPolicies.employeeId, operatorId),
          eq(schema.employees.status, "active"),
        ),
      );
    if (rows[0]?.canWriteoff !== true) {
      throw new ForbiddenException("Operator may not write off");
    }
  }

  async create(
    tenantId: string,
    stationDeviceId: string,
    dto: StationWriteoffDto,
  ): Promise<CreateOrderResultDto> {
    const document: CreatePickupDocumentInput = {
      deviceSeq: dto.deviceSeq,
      operatorId: dto.operatorId,
      reason: "writeoff",
      writeoffReasonId: dto.writeoffReasonId,
      items: dto.items,
      boxes: dto.boxes,
      createdAt: dto.createdAt,
    };
    // A waiting target's well-formed payload is evidence even when its asserted
    // operator is invalid. Retain it before ordinary business authorization.
    await quarantineReplacementSubmission(
      this.db,
      tenantId,
      stationDeviceId,
      "writeoffs",
      String(dto.deviceSeq),
      document,
      async (tx) => {
        const [existing] = await tx
          .select({ id: schema.pickupOrders.id })
          .from(schema.pickupOrders)
          .where(
            and(
              eq(schema.pickupOrders.tenantId, tenantId),
              eq(schema.pickupOrders.stationDeviceId, stationDeviceId),
              eq(schema.pickupOrders.deviceSeq, dto.deviceSeq),
            ),
          );
        return Boolean(existing);
      },
    );
    await this.assertCanWriteoff(tenantId, dto.operatorId);
    return this.pickupOrders.createForDevice(tenantId, handheldSource(stationDeviceId), document);
  }

  async bootstrap(tenantId: string): Promise<StationWriteoffBootstrapDto> {
    const [reasons, products, operators] = await Promise.all([
      this.db
        .select({
          id: schema.pickupOrderReasons.id,
          name: schema.pickupOrderReasons.name,
          sortOrder: schema.pickupOrderReasons.sortOrder,
        })
        .from(schema.pickupOrderReasons)
        .where(
          and(
            eq(schema.pickupOrderReasons.tenantId, tenantId),
            eq(schema.pickupOrderReasons.archived, false),
          ),
        )
        .orderBy(asc(schema.pickupOrderReasons.sortOrder)),
      this.db
        .select({
          id: schema.products.id,
          gtin14: schema.products.gtin14,
          name: schema.products.name,
        })
        .from(schema.products)
        .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.archived, false))),
      this.db
        .select({
          employeeId: schema.employeePickupPolicies.employeeId,
          canWriteoff: schema.employeePickupPolicies.canWriteoff,
        })
        .from(schema.employeePickupPolicies)
        .where(eq(schema.employeePickupPolicies.tenantId, tenantId)),
    ]);
    return { generatedAt: new Date().toISOString(), reasons, products, operators };
  }
}
