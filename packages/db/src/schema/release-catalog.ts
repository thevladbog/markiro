import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const namespace = () => ({
  product: text("product").notNull(),
  channel: text("channel").notNull(),
});
const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const releaseCatalogEpochs = pgTable(
  "release_catalog_epochs",
  {
    id: uuid("id").primaryKey(),
    ...namespace(),
    enabled: boolean("enabled").notNull().default(false),
    createdAt: created(),
  },
  (t) => [
    unique("rc_epochs_scope_uq").on(t.id, t.product, t.channel),
    uniqueIndex("rc_active_epoch_uq")
      .on(t.product, t.channel)
      .where(sql`${t.enabled}`),
    check(
      "rc_epochs_scope_ck",
      sql`${t.product} in ('station','handheld','standalone','signer') and ${t.channel} in ('beta','stable') and (${t.product}<>'signer' or ${t.channel}='stable')`,
    ),
  ],
);

export const releaseCatalogReceipts = pgTable(
  "release_catalog_receipts",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    sha256: text("sha256").notNull(),
    ledgerKey: text("ledger_key").notNull(),
    ledgerVersionId: text("ledger_version_id").notNull(),
    createdAt: created(),
  },
  (t) => [
    check(
      "rc_receipt_shape_ck",
      sql`${t.kind} in ('publication','reservation','channel','confirmation') and ${t.sha256} ~ '^[0-9a-f]{64}$' and ${t.ledgerKey} = '_publication-ledger/' || ${t.id}::text || '.json' and octet_length(${t.ledgerVersionId}) between 1 and 1024 and lower(btrim(${t.ledgerVersionId})) <> 'null' and ${t.ledgerVersionId} !~ '[[:cntrl:]]'`,
    ),
  ],
);

export const releaseCatalogIntents = pgTable(
  "release_catalog_intents",
  {
    id: uuid("id").primaryKey(),
    epochId: uuid("epoch_id").notNull(),
    ownerFingerprint: text("owner_fingerprint").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    ...namespace(),
    version: text("version").notNull(),
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    state: text("state").notNull().default("pending"),
    createdAt: created(),
  },
  (t) => [
    unique("rc_intent_owner_key_uq").on(t.ownerFingerprint, t.idempotencyKey),
    unique("rc_intent_version_uq").on(t.product, t.channel, t.version),
    unique("rc_intent_scope_uq").on(t.id, t.product, t.channel, t.version),
    foreignKey({
      name: "rc_intent_epoch_fk",
      columns: [t.epochId, t.product, t.channel],
      foreignColumns: [
        releaseCatalogEpochs.id,
        releaseCatalogEpochs.product,
        releaseCatalogEpochs.channel,
      ],
    }),
    check(
      "rc_intent_shape_ck",
      sql`${t.ownerFingerprint} ~ '^[0-9a-f]{64}$' and ${t.requestDigest} ~ '^[0-9a-f]{64}$' and ${t.version} ~ '^[0-9][0-9A-Za-z.+-]{0,127}$' and jsonb_typeof(${t.request})='object' and ${t.state} in ('pending','verified','committed','failed')`,
    ),
  ],
);

export const releaseCatalogPublications = pgTable(
  "release_catalog_publications",
  {
    id: uuid("id").primaryKey(),
    intentId: uuid("intent_id").notNull(),
    ...namespace(),
    version: text("version").notNull(),
    requestDigest: text("request_digest").notNull(),
    sourceSha: text("source_sha").notNull(),
    fileCount: integer("file_count").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => releaseCatalogReceipts.id),
    createdAt: created(),
  },
  (t) => [
    unique("rc_publication_intent_uq").on(t.intentId),
    unique("rc_publication_version_uq").on(t.product, t.channel, t.version),
    unique("rc_publication_scope_uq").on(t.id, t.product, t.channel),
    unique("rc_publication_file_scope_uq").on(t.id, t.product, t.channel, t.version),
    foreignKey({
      name: "rc_publication_intent_fk",
      columns: [t.intentId, t.product, t.channel, t.version],
      foreignColumns: [
        releaseCatalogIntents.id,
        releaseCatalogIntents.product,
        releaseCatalogIntents.channel,
        releaseCatalogIntents.version,
      ],
    }),
    check(
      "rc_publication_shape_ck",
      sql`${t.requestDigest} ~ '^[0-9a-f]{64}$' and ${t.sourceSha} ~ '^[0-9a-f]{40}$' and ${t.fileCount} between 1 and 16 and jsonb_typeof(${t.metadata})='object'`,
    ),
  ],
);

export const releaseCatalogObjects = pgTable(
  "release_catalog_objects",
  {
    publicPath: text("public_path").primaryKey(),
    publicationId: uuid("publication_id").notNull(),
    ...namespace(),
    version: text("version").notNull(),
    name: text("name").notNull(),
    bucket: text("bucket").notNull(),
    key: text("key").notNull(),
    versionId: text("version_id").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentType: text("content_type").notNull(),
  },
  (t) => [
    uniqueIndex("rc_object_name_uq").on(t.publicationId, sql`lower(${t.name})`),
    foreignKey({
      name: "rc_object_publication_fk",
      columns: [t.publicationId, t.product, t.channel, t.version],
      foreignColumns: [
        releaseCatalogPublications.id,
        releaseCatalogPublications.product,
        releaseCatalogPublications.channel,
        releaseCatalogPublications.version,
      ],
    }),
    check(
      "rc_object_path_ck",
      sql`${t.name} ~ '^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$' and ${t.publicPath} = '/' || ${t.product} || '/' || ${t.channel} || case when ${t.product}='standalone' then '' else '/releases' end || '/' || ${t.version} || '/' || ${t.name}`,
    ),
    check(
      "rc_object_shape_ck",
      sql`${t.sha256} ~ '^[0-9a-f]{64}$' and ${t.sizeBytes} between 1 and 536870912 and ${t.bucket} ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' and left(${t.key},length(${t.product})+1)=${t.product} || '/' and octet_length(${t.key}) between 1 and 1024 and octet_length(${t.versionId}) between 1 and 1024 and lower(btrim(${t.versionId}))<>'null' and btrim(${t.versionId})<>'' and ${t.versionId} !~ '[[:cntrl:]]' and ${t.contentType} in ('application/octet-stream','application/zip','application/json','application/vnd.android.package-archive','text/plain','text/plain; charset=utf-8','text/markdown')`,
    ),
  ],
);

export const releaseCatalogReservations = pgTable(
  "release_catalog_reservations",
  {
    id: uuid("id").primaryKey(),
    ...namespace(),
    kind: text("kind").notNull(),
    version: text("version"),
    publicPath: text("public_path"),
    upperBound: text("upper_bound"),
    requestDigest: text("request_digest"),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => releaseCatalogReceipts.id),
    createdAt: created(),
  },
  (t) => [
    check(
      "rc_reservation_scope_ck",
      sql`${t.product} in ('station','handheld','standalone','signer') and ${t.channel} in ('beta','stable') and (${t.product}<>'signer' or ${t.channel}='stable')`,
    ),
    check(
      "rc_reservation_shape_ck",
      sql`(${t.kind}='path' and ${t.publicPath} is not null and ${t.version} is not null and ${t.upperBound} is null) or (${t.kind}='version' and ${t.publicPath} is null and ${t.version} is not null and ${t.upperBound} is null) or (${t.kind}='range' and ${t.publicPath} is null and ${t.version} is null and ${t.upperBound} is not null) or (${t.kind}='closed' and ${t.publicPath} is null and ${t.version} is null and ${t.upperBound} is null)`,
    ),
  ],
);

export const releaseCatalogChannels = pgTable(
  "release_catalog_channels",
  {
    ...namespace(),
    revision: bigint("revision", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    publicationId: uuid("publication_id"),
    readable: boolean("readable").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.product, t.channel] }),
    foreignKey({
      name: "rc_channel_publication_fk",
      columns: [t.publicationId, t.product, t.channel],
      foreignColumns: [
        releaseCatalogPublications.id,
        releaseCatalogPublications.product,
        releaseCatalogPublications.channel,
      ],
    }),
    check(
      "rc_channel_shape_ck",
      sql`${t.product} in ('station','handheld','standalone','signer') and ${t.channel} in ('beta','stable') and (${t.product}<>'signer' or ${t.channel}='stable') and ${t.revision}>=0 and ((${t.revision}=0 and ${t.publicationId} is null) or (${t.revision}>0 and ${t.publicationId} is not null))`,
    ),
  ],
);

export const releaseCatalogChannelEvents = pgTable(
  "release_catalog_channel_events",
  {
    id: uuid("id").primaryKey(),
    ...namespace(),
    expectedRevision: bigint("expected_revision", { mode: "bigint" }).notNull(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    previousPublicationId: uuid("previous_publication_id"),
    publicationId: uuid("publication_id").notNull(),
    kind: text("kind").notNull(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => releaseCatalogReceipts.id),
    pointer: jsonb("pointer").$type<Record<string, unknown>>().notNull(),
    createdAt: created(),
  },
  (t) => [
    unique("rc_event_revision_uq").on(t.product, t.channel, t.revision),
    foreignKey({
      name: "rc_event_publication_fk",
      columns: [t.publicationId, t.product, t.channel],
      foreignColumns: [
        releaseCatalogPublications.id,
        releaseCatalogPublications.product,
        releaseCatalogPublications.channel,
      ],
    }),
    foreignKey({
      name: "rc_event_previous_fk",
      columns: [t.previousPublicationId, t.product, t.channel],
      foreignColumns: [
        releaseCatalogPublications.id,
        releaseCatalogPublications.product,
        releaseCatalogPublications.channel,
      ],
    }),
    check(
      "rc_event_shape_ck",
      sql`${t.expectedRevision}>=0 and ${t.expectedRevision}<9223372036854775807 and ${t.revision}=${t.expectedRevision}+1 and ${t.kind} in ('forward','rollback') and jsonb_typeof(${t.pointer})='object'`,
    ),
  ],
);

export const releaseCatalogOidcBindings = pgTable(
  "release_catalog_oidc_bindings",
  {
    tokenHash: text("token_hash").primaryKey(),
    intentId: uuid("intent_id")
      .notNull()
      .references(() => releaseCatalogIntents.id),
    principalHash: text("principal_hash").notNull(),
    createdAt: created(),
  },
  (t) => [
    check(
      "rc_oidc_hash_ck",
      sql`${t.tokenHash} ~ '^[0-9a-f]{64}$' and ${t.principalHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);
