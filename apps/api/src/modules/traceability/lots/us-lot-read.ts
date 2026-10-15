import { schema } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { platformUuidSchema, type TraceabilityLot } from "@markiro/platform-contracts";
import { NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { RawLot } from "../demo/us-dataset-terminal-read-contract";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { lotResponse } from "./us-lot-support";

export type UsLotReaders = Readonly<{
  authorize: typeof authorizeUsMasterData;
  lot(tx: UsMasterDataTransaction, tenantId: string, id: string): Promise<RawLot | undefined>;
}>;

async function freshLot(tx: UsMasterDataTransaction, tenantId: string, id: string) {
  const [row] = await tx
    .select()
    .from(schema.traceabilityLots)
    .where(and(eq(schema.traceabilityLots.tenantId, tenantId), eq(schema.traceabilityLots.id, id)))
    .limit(1);
  return row;
}

export const freshUsLotReaders: UsLotReaders = {
  authorize: authorizeUsMasterData,
  lot: freshLot,
};

export async function readUsLotCore(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  readers: UsLotReaders,
): Promise<TraceabilityLot> {
  await readers.authorize(tx, tenantId, actorUserId, US_CAPABILITY.READ);
  const lotId = parseMasterDataInput(platformUuidSchema, id);
  const row = await readers.lot(tx, tenantId, lotId);
  if (!row) throw new NotFoundException({ code: "lot_not_found" });
  return lotResponse(row);
}
