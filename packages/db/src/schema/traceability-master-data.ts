import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth.js";

export const traceabilityLocationRole = pgEnum("traceability_location_role", [
  "supplier",
  "processor",
  "ship_from",
  "receive_at",
  "recipient",
  "tlc_source",
]);

export const traceabilityAddressKind = pgEnum("traceability_address_kind", [
  "street",
  "coordinates",
]);

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

export const traceabilityParties = pgTable(
  "traceability_parties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
    contactEmail: text("contact_email"),
    notes: text("notes"),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("traceability_parties_tenant_id_uq").on(table.tenantId, table.id),
    uniqueIndex("traceability_parties_active_name_uq")
      .on(table.tenantId, sql`lower(${table.name})`)
      .where(sql`${table.archived} = false`),
    check("traceability_parties_name_nonempty", sql`length(btrim(${table.name})) > 0`),
  ],
);

export const traceabilityLocations = pgTable(
  "traceability_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    partyId: uuid("party_id").notNull(),
    name: text("name").notNull(),
    businessName: text("business_name").notNull(),
    phoneNumber: text("phone_number"),
    addressKind: traceabilityAddressKind("address_kind").notNull().default("street"),
    streetAddress: text("street_address"),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    city: text("city"),
    stateOrRegion: text("state_or_region"),
    zipOrPostalCode: text("zip_or_postal_code"),
    countryCode: text("country_code"),
    roles: traceabilityLocationRole("roles").array().notNull().default([]),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("traceability_locations_tenant_id_uq").on(table.tenantId, table.id),
    foreignKey({
      name: "traceability_locations_tenant_party_fk",
      columns: [table.tenantId, table.partyId],
      foreignColumns: [traceabilityParties.tenantId, traceabilityParties.id],
    }),
    index("traceability_locations_tenant_party_idx").on(table.tenantId, table.partyId),
    index("traceability_locations_roles_idx").using("gin", table.roles),
    check("traceability_locations_name_nonempty", sql`length(btrim(${table.name})) > 0`),
    check(
      "traceability_locations_business_name_nonempty",
      sql`length(btrim(${table.businessName})) > 0`,
    ),
    check(
      "traceability_locations_country_code_format",
      sql`${table.countryCode} IS NULL OR ${table.countryCode} ~ '^[A-Z]{2}$'`,
    ),
    check(
      "traceability_locations_latitude_range",
      sql`${table.latitude} IS NULL OR ${table.latitude} BETWEEN -90 AND 90`,
    ),
    check(
      "traceability_locations_longitude_range",
      sql`${table.longitude} IS NULL OR ${table.longitude} BETWEEN -180 AND 180`,
    ),
    check(
      "traceability_locations_address_shape",
      sql`(${table.addressKind} = 'street' AND ${table.latitude} IS NULL AND ${table.longitude} IS NULL) OR (${table.addressKind} = 'coordinates' AND ${table.streetAddress} IS NULL)`,
    ),
    check(
      "traceability_locations_roles_shape",
      sql`cardinality(${table.roles}) <= 6 AND array_position(${table.roles}, NULL) IS NULL`,
    ),
  ],
);
