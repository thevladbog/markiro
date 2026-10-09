import { ForbiddenException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

export type WarehouseReader = Pick<Db, "select">;
export async function assertWarehouseDevice(
  db: WarehouseReader,
  tenantId: string,
  deviceId: string,
): Promise<void> {
  const [device] = await db
    .select({ id: schema.stationDevices.id })
    .from(schema.stationDevices)
    .where(
      and(
        eq(schema.stationDevices.tenantId, tenantId),
        eq(schema.stationDevices.id, deviceId),
        eq(schema.stationDevices.kind, "station"),
        isNull(schema.stationDevices.revokedAt),
      ),
    );
  if (!device) throw new ForbiddenException({ code: "WAREHOUSE_DEVICE_DENIED" });
}
export async function assertWarehouseOperator(
  db: WarehouseReader,
  tenantId: string,
  operatorId: string,
): Promise<void> {
  const [operator] = await db
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
        eq(schema.employees.id, operatorId),
        eq(schema.employees.status, "active"),
        eq(schema.operatorCredentials.active, true),
      ),
    );
  if (!operator) throw new ForbiddenException({ code: "WAREHOUSE_OPERATOR_DENIED" });
}
