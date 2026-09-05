import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { US_CAPABILITY } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import {
  createUsLocationSchema,
  createUsPartySchema,
  listUsLocationsQuerySchema,
  listUsPartiesQuerySchema,
  platformUuidSchema,
  updateUsLocationSchema,
  updateUsPartySchema,
  type UsLocation,
  type UsParty,
} from "@markiro/platform-contracts";
import { and, arrayContains, asc, eq, ilike, or } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import {
  authorizeUsMasterData,
  canonicalCoordinate,
  escapeLikePattern,
  isPartyNameConflict,
  locationPersistentSnapshot,
  locationResponse,
  parseMasterDataInput,
  partyResponse,
  type UsLocationList,
  type UsPartyList,
} from "./us-master-data-support";

/** US-only tenant store. Actor and tenant identifiers are supplied only by the
 * verified server session boundary. */
export class UsMasterDataStore {
  constructor(private readonly db: Db) {}

  async listParties(tenantId: string, actorUserId: string, query: unknown): Promise<UsPartyList> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const value = parseMasterDataInput(listUsPartiesQuerySchema, query);
      const search = value.search ? `%${escapeLikePattern(value.search)}%` : undefined;
      const rows = await tx
        .select()
        .from(schema.traceabilityParties)
        .where(
          and(
            eq(schema.traceabilityParties.tenantId, tenantId),
            value.archived === "all"
              ? undefined
              : eq(schema.traceabilityParties.archived, value.archived === "true"),
            search
              ? or(
                  ilike(schema.traceabilityParties.name, search),
                  ilike(schema.traceabilityParties.legalName, search),
                )
              : undefined,
          ),
        )
        .orderBy(asc(schema.traceabilityParties.name), asc(schema.traceabilityParties.id))
        .limit(value.limit)
        .offset(value.offset);
      return { items: rows.map(partyResponse), limit: value.limit, offset: value.offset };
    });
  }

  async getParty(tenantId: string, actorUserId: string, id: unknown): Promise<UsParty> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const partyId = parseMasterDataInput(platformUuidSchema, id);
      const [row] = await tx
        .select()
        .from(schema.traceabilityParties)
        .where(
          and(
            eq(schema.traceabilityParties.tenantId, tenantId),
            eq(schema.traceabilityParties.id, partyId),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundException({ code: "party_not_found" });
      return partyResponse(row);
    });
  }

  async createParty(
    tenantId: string,
    actorUserId: string,
    input: unknown,
    requestId: string,
  ): Promise<UsParty> {
    try {
      return await this.db.transaction(async (tx) => {
        await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.MASTER_DATA_WRITE);
        const value = parseMasterDataInput(createUsPartySchema, input);
        const now = new Date();
        const [row] = await tx
          .insert(schema.traceabilityParties)
          .values({ tenantId, ...value, createdAt: now, updatedAt: now })
          .returning();
        if (!row) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
        const response = partyResponse(row);
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId,
          action: "traceability.party.created",
          outcome: "success",
          targetType: "traceability_party",
          targetId: row.id,
          before: null,
          after: response,
          requestId,
        });
        return response;
      });
    } catch (error) {
      if (isPartyNameConflict(error)) {
        throw new ConflictException({ code: "party_name_taken" });
      }
      throw error;
    }
  }

  async updateParty(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<UsParty> {
    try {
      return await this.db.transaction(async (tx) => {
        await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.MASTER_DATA_WRITE);
        const partyId = parseMasterDataInput(platformUuidSchema, id);
        const patch = parseMasterDataInput(updateUsPartySchema, input);
        const [existing] = await tx
          .select()
          .from(schema.traceabilityParties)
          .where(
            and(
              eq(schema.traceabilityParties.tenantId, tenantId),
              eq(schema.traceabilityParties.id, partyId),
            ),
          )
          .limit(1)
          .for("update");
        if (!existing) throw new NotFoundException({ code: "party_not_found" });
        const current = partyResponse(existing);
        const merged = { ...current, ...patch };
        const validated = parseMasterDataInput(createUsPartySchema, {
          name: merged.name,
          legalName: merged.legalName,
          contactName: merged.contactName,
          contactPhone: merged.contactPhone,
          contactEmail: merged.contactEmail,
          notes: merged.notes,
        });
        const comparableCurrent = {
          name: current.name,
          legalName: current.legalName,
          contactName: current.contactName,
          contactPhone: current.contactPhone,
          contactEmail: current.contactEmail,
          notes: current.notes,
          archived: current.archived,
        };
        const comparableNext = {
          ...validated,
          archived: merged.archived,
        };
        if (isDeepStrictEqual(comparableCurrent, comparableNext)) return current;
        const now = new Date();
        const [updated] = await tx
          .update(schema.traceabilityParties)
          .set({ ...comparableNext, updatedAt: now })
          .where(
            and(
              eq(schema.traceabilityParties.tenantId, tenantId),
              eq(schema.traceabilityParties.id, partyId),
            ),
          )
          .returning();
        if (!updated) throw new NotFoundException({ code: "party_not_found" });
        const response = partyResponse(updated);
        const action =
          patch.archived !== undefined && patch.archived !== current.archived
            ? patch.archived
              ? "traceability.party.archived"
              : "traceability.party.restored"
            : "traceability.party.updated";
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId,
          action,
          outcome: "success",
          targetType: "traceability_party",
          targetId: partyId,
          before: current,
          after: response,
          requestId,
        });
        return response;
      });
    } catch (error) {
      if (isPartyNameConflict(error)) {
        throw new ConflictException({ code: "party_name_taken" });
      }
      throw error;
    }
  }

  async listLocations(
    tenantId: string,
    actorUserId: string,
    query: unknown,
  ): Promise<UsLocationList> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const value = parseMasterDataInput(listUsLocationsQuerySchema, query);
      const search = value.search ? `%${escapeLikePattern(value.search)}%` : undefined;
      const rows = await tx
        .select()
        .from(schema.traceabilityLocations)
        .where(
          and(
            eq(schema.traceabilityLocations.tenantId, tenantId),
            value.archived === "all"
              ? undefined
              : eq(schema.traceabilityLocations.archived, value.archived === "true"),
            value.partyId ? eq(schema.traceabilityLocations.partyId, value.partyId) : undefined,
            value.roles?.length
              ? arrayContains(schema.traceabilityLocations.roles, value.roles)
              : undefined,
            search
              ? or(
                  ilike(schema.traceabilityLocations.name, search),
                  ilike(schema.traceabilityLocations.businessName, search),
                )
              : undefined,
          ),
        )
        .orderBy(asc(schema.traceabilityLocations.name), asc(schema.traceabilityLocations.id))
        .limit(value.limit)
        .offset(value.offset);
      return { items: rows.map(locationResponse), limit: value.limit, offset: value.offset };
    });
  }

  async getLocation(tenantId: string, actorUserId: string, id: unknown): Promise<UsLocation> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const locationId = parseMasterDataInput(platformUuidSchema, id);
      const [row] = await tx
        .select()
        .from(schema.traceabilityLocations)
        .where(
          and(
            eq(schema.traceabilityLocations.tenantId, tenantId),
            eq(schema.traceabilityLocations.id, locationId),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundException({ code: "location_not_found" });
      return locationResponse(row);
    });
  }

  async createLocation(
    tenantId: string,
    actorUserId: string,
    input: unknown,
    requestId: string,
  ): Promise<UsLocation> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.MASTER_DATA_WRITE);
      const value = parseMasterDataInput(createUsLocationSchema, input);
      const [parent] = await tx
        .select({
          id: schema.traceabilityParties.id,
          archived: schema.traceabilityParties.archived,
        })
        .from(schema.traceabilityParties)
        .where(
          and(
            eq(schema.traceabilityParties.tenantId, tenantId),
            eq(schema.traceabilityParties.id, value.partyId),
          ),
        )
        .limit(1)
        .for("share");
      if (!parent) throw new NotFoundException({ code: "party_not_found" });
      if (parent.archived) throw new ForbiddenException({ code: "party_archived" });
      const now = new Date();
      const [row] = await tx
        .insert(schema.traceabilityLocations)
        .values({
          tenantId,
          ...value,
          latitude: canonicalCoordinate(value.latitude),
          longitude: canonicalCoordinate(value.longitude),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
      const response = locationResponse(row);
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "traceability.location.created",
        outcome: "success",
        targetType: "traceability_location",
        targetId: row.id,
        before: null,
        after: locationPersistentSnapshot(row),
        requestId,
      });
      return response;
    });
  }

  async updateLocation(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<UsLocation> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.MASTER_DATA_WRITE);
      const locationId = parseMasterDataInput(platformUuidSchema, id);
      const patch = parseMasterDataInput(updateUsLocationSchema, input);

      // Resolve the immutable parent key first, then lock parent before child.
      const [identity] = await tx
        .select({ partyId: schema.traceabilityLocations.partyId })
        .from(schema.traceabilityLocations)
        .where(
          and(
            eq(schema.traceabilityLocations.tenantId, tenantId),
            eq(schema.traceabilityLocations.id, locationId),
          ),
        )
        .limit(1);
      if (!identity) throw new NotFoundException({ code: "location_not_found" });
      const [parent] = await tx
        .select({
          id: schema.traceabilityParties.id,
          archived: schema.traceabilityParties.archived,
        })
        .from(schema.traceabilityParties)
        .where(
          and(
            eq(schema.traceabilityParties.tenantId, tenantId),
            eq(schema.traceabilityParties.id, identity.partyId),
          ),
        )
        .limit(1)
        .for("share");
      if (!parent) throw new NotFoundException({ code: "location_not_found" });
      const [existing] = await tx
        .select()
        .from(schema.traceabilityLocations)
        .where(
          and(
            eq(schema.traceabilityLocations.tenantId, tenantId),
            eq(schema.traceabilityLocations.id, locationId),
            eq(schema.traceabilityLocations.partyId, identity.partyId),
          ),
        )
        .limit(1)
        .for("update");
      if (!existing) throw new NotFoundException({ code: "location_not_found" });

      const archiveOnly = Object.keys(patch).length === 1 && patch.archived === true;
      if (parent.archived && !archiveOnly) {
        throw new ForbiddenException({ code: "party_archived" });
      }
      const persistent = locationPersistentSnapshot(existing);
      const validated = parseMasterDataInput(createUsLocationSchema, {
        partyId: existing.partyId,
        name: patch.name ?? persistent.name,
        businessName: patch.businessName ?? persistent.businessName,
        phoneNumber: patch.phoneNumber !== undefined ? patch.phoneNumber : persistent.phoneNumber,
        addressKind: patch.addressKind ?? persistent.addressKind,
        streetAddress:
          patch.streetAddress !== undefined ? patch.streetAddress : persistent.streetAddress,
        latitude: patch.latitude !== undefined ? patch.latitude : persistent.latitude,
        longitude: patch.longitude !== undefined ? patch.longitude : persistent.longitude,
        city: patch.city !== undefined ? patch.city : persistent.city,
        stateOrRegion:
          patch.stateOrRegion !== undefined ? patch.stateOrRegion : persistent.stateOrRegion,
        zipOrPostalCode:
          patch.zipOrPostalCode !== undefined ? patch.zipOrPostalCode : persistent.zipOrPostalCode,
        countryCode: patch.countryCode !== undefined ? patch.countryCode : persistent.countryCode,
        roles: patch.roles ?? persistent.roles,
      });
      const next = {
        ...validated,
        archived: patch.archived ?? persistent.archived,
        latitude: canonicalCoordinate(validated.latitude),
        longitude: canonicalCoordinate(validated.longitude),
      };
      const comparableCurrent = {
        partyId: persistent.partyId,
        name: persistent.name,
        businessName: persistent.businessName,
        phoneNumber: persistent.phoneNumber,
        addressKind: persistent.addressKind,
        streetAddress: persistent.streetAddress,
        latitude: canonicalCoordinate(persistent.latitude),
        longitude: canonicalCoordinate(persistent.longitude),
        city: persistent.city,
        stateOrRegion: persistent.stateOrRegion,
        zipOrPostalCode: persistent.zipOrPostalCode,
        countryCode: persistent.countryCode,
        roles: persistent.roles,
        archived: persistent.archived,
      };
      if (isDeepStrictEqual(comparableCurrent, next)) return locationResponse(existing);

      const now = new Date();
      const [updated] = await tx
        .update(schema.traceabilityLocations)
        .set({
          name: next.name,
          businessName: next.businessName,
          phoneNumber: next.phoneNumber,
          addressKind: next.addressKind,
          streetAddress: next.streetAddress,
          latitude: next.latitude,
          longitude: next.longitude,
          city: next.city,
          stateOrRegion: next.stateOrRegion,
          zipOrPostalCode: next.zipOrPostalCode,
          countryCode: next.countryCode,
          roles: next.roles,
          archived: next.archived,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.traceabilityLocations.tenantId, tenantId),
            eq(schema.traceabilityLocations.id, locationId),
          ),
        )
        .returning();
      if (!updated) throw new NotFoundException({ code: "location_not_found" });
      const after = locationPersistentSnapshot(updated);
      const action =
        patch.archived !== undefined && patch.archived !== persistent.archived
          ? patch.archived
            ? "traceability.location.archived"
            : "traceability.location.restored"
          : "traceability.location.updated";
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action,
        outcome: "success",
        targetType: "traceability_location",
        targetId: locationId,
        before: persistent,
        after,
        requestId,
      });
      return locationResponse(updated);
    });
  }
}
