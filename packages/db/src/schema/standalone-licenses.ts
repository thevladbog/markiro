import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { platformUsers } from "./platform-auth.js";

/**
 * A «Markiro Автоном» site: one host identity (`host.json` hostId) bound to a
 * tenant (spec 2026-10-13 §6.2). A new host id of the same site is a rebind:
 * the history keeps every host id and the sequence of license files goes on.
 */
export const standaloneSites = pgTable(
  "standalone_sites",
  {
    id: uuid("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    hostId: uuid("host_id").notNull(),
    name: text("name").notNull(),
    requestInn: text("request_inn"),
    lastActivationRequest: jsonb("last_activation_request")
      .$type<Record<string, unknown>>()
      .notNull(),
    hostHistory: jsonb("host_history").$type<unknown[]>().notNull(),
    lastIssuedSequence: integer("last_issued_sequence").notNull().default(0),
    requestId: uuid("request_id").notNull(),
    createdByPlatformUserId: text("created_by_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("standalone_sites_tenant_id_uq").on(t.tenantId, t.id),
    unique("standalone_sites_host_id_uq").on(t.hostId),
    unique("standalone_sites_tenant_request_uq").on(t.tenantId, t.requestId),
    check("standalone_sites_name_check", sql`length(btrim(${t.name})) between 1 and 200`),
    check(
      "standalone_sites_request_inn_check",
      sql`${t.requestInn} is null or ${t.requestInn} ~ '^[0-9]{10}([0-9]{2})?$'`,
    ),
    check("standalone_sites_sequence_check", sql`${t.lastIssuedSequence} >= 0`),
    check(
      "standalone_sites_payload_check",
      sql`jsonb_typeof(${t.lastActivationRequest}) = 'object' and octet_length(${t.lastActivationRequest}::text) <= 65536 and case when jsonb_typeof(${t.hostHistory}) = 'array' then jsonb_array_length(${t.hostHistory}) between 1 and 100 else false end`,
    ),
  ],
);

/** The issuance journal: every signed `.mklic` file, append-only, ordered per site. */
export const standaloneLicenseIssuances = pgTable(
  "standalone_license_issuances",
  {
    id: uuid("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    siteId: uuid("site_id").notNull(),
    sequence: integer("sequence").notNull(),
    requestId: uuid("request_id").notNull(),
    hostId: uuid("host_id").notNull(),
    plan: text("plan").$type<"demo" | "subscription">().notNull(),
    planVersionId: uuid("plan_version_id").notNull(),
    entitlementRevision: bigint("entitlement_revision", { mode: "bigint" }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    compact: text("compact").notNull(),
    sha256: text("sha256").notNull(),
    kid: text("kid").notNull(),
    graceDays: integer("grace_days").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    /**
     * Owner decision 2026-10-13: `subscription` derives the rights from the
     * tenant's cloud subscription; `offline` from the operator's offline terms
     * (a catalog plan version and a term of at most a year) for a tenant
     * without a cabinet — it never grants cloud access. Spec 2026-10-16:
     * `offline_assignments` derives the rights from the direct assignments of a
     * tenant without a cabinet; `offline` rows stay in the journal read-only.
     */
    source: text("source").$type<"subscription" | "offline" | "offline_assignments">().notNull(),
    validUntilReason: text("valid_until_reason")
      .$type<"subscription_end" | "entitlement_reduction" | "one_year_cap" | "offline_term">()
      .notNull(),
    /** The plan and add-on rows an `offline_assignments` file was issued from (spec 2026-10-16). */
    sourceAssignments:
      jsonb("source_assignments").$type<
        Array<{ kind: "plan" | "addon"; id: string; catalogVersionId: string }>
      >(),
    replacesId: uuid("replaces_id"),
    issuedByPlatformUserId: text("issued_by_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
  },
  (t) => [
    unique("standalone_license_issuances_site_sequence_uq").on(t.siteId, t.sequence),
    unique("standalone_license_issuances_site_id_uq").on(t.siteId, t.id),
    unique("standalone_license_issuances_tenant_site_request_uq").on(
      t.tenantId,
      t.siteId,
      t.requestId,
    ),
    index("standalone_license_issuances_tenant_site_idx").on(t.tenantId, t.siteId, t.sequence),
    foreignKey({
      name: "standalone_license_issuances_tenant_site_fk",
      columns: [t.tenantId, t.siteId],
      foreignColumns: [standaloneSites.tenantId, standaloneSites.id],
    }),
    foreignKey({
      name: "standalone_license_issuances_site_replaces_fk",
      columns: [t.siteId, t.replacesId],
      foreignColumns: [t.siteId, t.id],
    }),
    check(
      "standalone_license_issuances_shape_check",
      sql`${t.sequence} > 0 and ${t.graceDays} between 0 and 60 and ${t.plan} in ('demo','subscription') and (${t.plan} <> 'demo' or ${t.graceDays} = 0) and ${t.sha256} ~ '^[0-9a-f]{64}$' and length(btrim(${t.kid})) between 1 and 128 and octet_length(${t.compact}) between 1 and 16384 and ${t.entitlementRevision} >= 0 and ${t.validUntilReason} in ('subscription_end','entitlement_reduction','one_year_cap','offline_term') and ${t.source} in ('subscription','offline','offline_assignments') and ((${t.source} = 'offline') = (${t.validUntilReason} = 'offline_term')) and (${t.source} not in ('offline','offline_assignments') or ${t.plan} = 'subscription') and ((${t.source} = 'offline_assignments') = (${t.sourceAssignments} is not null)) and (${t.sourceAssignments} is null or (jsonb_typeof(${t.sourceAssignments}) = 'array' and jsonb_array_length(${t.sourceAssignments}) between 1 and 65))`,
    ),
    check(
      "standalone_license_issuances_interval_check",
      sql`isfinite(${t.issuedAt}) and isfinite(${t.validFrom}) and isfinite(${t.validUntil}) and ${t.issuedAt} = ${t.validFrom} and ${t.validUntil} > ${t.validFrom} and ${t.validUntil} - ${t.validFrom} <= interval '365 days'`,
    ),
    check(
      "standalone_license_issuances_payload_check",
      sql`jsonb_typeof(${t.payload}) = 'object' and octet_length(${t.payload}::text) <= 16384`,
    ),
  ],
);
