import { schema } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { platformUuidSchema, type UsLocation, type UsParty } from "@markiro/platform-contracts";
import { NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { orderedMasterDataRows, parseMasterDataIds } from "./us-master-data-batch";
import {
  authorizeUsMasterData,
  locationResponse,
  parseMasterDataInput,
  partyResponse,
  type LocationRow,
  type PartyRow,
  type UsMasterDataTransaction,
} from "./us-master-data-support";

export type UsMasterDataReaders = Readonly<{
  authorize: typeof authorizeUsMasterData;
  party(tx: UsMasterDataTransaction, tenantId: string, id: string): Promise<PartyRow | undefined>;
  parties(
    tx: UsMasterDataTransaction,
    tenantId: string,
    ids: readonly string[],
  ): Promise<PartyRow[]>;
  location(
    tx: UsMasterDataTransaction,
    tenantId: string,
    id: string,
  ): Promise<LocationRow | undefined>;
  locations(
    tx: UsMasterDataTransaction,
    tenantId: string,
    ids: readonly string[],
  ): Promise<LocationRow[]>;
}>;

async function freshParty(tx: UsMasterDataTransaction, tenantId: string, id: string) {
  const [row] = await tx
    .select()
    .from(schema.traceabilityParties)
    .where(
      and(eq(schema.traceabilityParties.tenantId, tenantId), eq(schema.traceabilityParties.id, id)),
    )
    .limit(1);
  return row;
}

async function freshParties(tx: UsMasterDataTransaction, tenantId: string, ids: readonly string[]) {
  return tx
    .select()
    .from(schema.traceabilityParties)
    .where(
      and(
        eq(schema.traceabilityParties.tenantId, tenantId),
        inArray(schema.traceabilityParties.id, [...ids]),
      ),
    );
}

async function freshLocation(tx: UsMasterDataTransaction, tenantId: string, id: string) {
  const [row] = await tx
    .select()
    .from(schema.traceabilityLocations)
    .where(
      and(
        eq(schema.traceabilityLocations.tenantId, tenantId),
        eq(schema.traceabilityLocations.id, id),
      ),
    )
    .limit(1);
  return row;
}

async function freshLocations(
  tx: UsMasterDataTransaction,
  tenantId: string,
  ids: readonly string[],
) {
  return tx
    .select()
    .from(schema.traceabilityLocations)
    .where(
      and(
        eq(schema.traceabilityLocations.tenantId, tenantId),
        inArray(schema.traceabilityLocations.id, [...ids]),
      ),
    );
}

export const freshUsMasterDataReaders: UsMasterDataReaders = {
  authorize: authorizeUsMasterData,
  party: freshParty,
  parties: freshParties,
  location: freshLocation,
  locations: freshLocations,
};

export async function readUsPartyCore(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  readers: UsMasterDataReaders,
): Promise<UsParty> {
  await readers.authorize(tx, tenantId, actorUserId, US_CAPABILITY.READ);
  const partyId = parseMasterDataInput(platformUuidSchema, id);
  const row = await readers.party(tx, tenantId, partyId);
  if (!row) throw new NotFoundException({ code: "party_not_found" });
  return partyResponse(row);
}

export async function readUsPartiesCore(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  inputIds: unknown,
  readers: UsMasterDataReaders,
): Promise<UsParty[]> {
  await readers.authorize(tx, tenantId, actorUserId, US_CAPABILITY.READ);
  const ids = parseMasterDataIds(inputIds);
  if (ids.length === 0) return [];
  const rows = await readers.parties(tx, tenantId, ids);
  return orderedMasterDataRows(ids, rows, (row) => row.id, "party_not_found").map(partyResponse);
}

export async function readUsLocationCore(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  readers: UsMasterDataReaders,
): Promise<UsLocation> {
  await readers.authorize(tx, tenantId, actorUserId, US_CAPABILITY.READ);
  const locationId = parseMasterDataInput(platformUuidSchema, id);
  const row = await readers.location(tx, tenantId, locationId);
  if (!row) throw new NotFoundException({ code: "location_not_found" });
  return locationResponse(row);
}

export async function readUsLocationsCore(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  inputIds: unknown,
  readers: UsMasterDataReaders,
): Promise<UsLocation[]> {
  await readers.authorize(tx, tenantId, actorUserId, US_CAPABILITY.READ);
  const ids = parseMasterDataIds(inputIds);
  if (ids.length === 0) return [];
  const rows = await readers.locations(tx, tenantId, ids);
  return orderedMasterDataRows(ids, rows, (row) => row.id, "location_not_found").map(
    locationResponse,
  );
}
