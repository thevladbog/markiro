import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { receivingOperations } from "./traceability-receiving.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** Import evidence, not business records. Services must validate JSON and authorize access. */
export const receivingCsvPreviews = pgTable(
  "receiving_csv_previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    templateVersion: text("template_version").notNull(),
    fileBytes: bytea("file_bytes").notNull(),
    byteSize: integer("byte_size").notNull(),
    fileSha256: text("file_sha256").notNull(),
    fileName: text("file_name"),
    originalHeader: jsonb("original_header").$type<unknown>().notNull(),
    findings: jsonb("findings").$type<unknown>().notNull(),
    // SQL null means there is no applicable proposal; raw failure evidence remains above.
    proposedDraft: jsonb("proposed_draft").$type<unknown>(),
    previewDigest: text("preview_digest"),
    rowCount: integer("row_count").notNull(),
    // Historical attribution survives deletion of the cabinet account.
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (t) => [
    unique("receiving_csv_previews_tenant_id_uq").on(t.tenantId, t.id),
    unique("receiving_csv_previews_content_uq").on(t.tenantId, t.id, t.previewDigest),
    index("receiving_csv_previews_tenant_created_idx").on(t.tenantId, t.createdAt),
    check(
      "receiving_csv_previews_template_valid",
      sql`${t.templateVersion} = 'markiro-receiving-v1'`,
    ),
    check(
      "receiving_csv_previews_bytes_valid",
      sql`${t.byteSize} BETWEEN 0 AND 262144 AND ${t.byteSize} = octet_length(${t.fileBytes})`,
    ),
    check(
      "receiving_csv_previews_hash_valid",
      sql`${t.fileSha256} ~ '^[0-9a-f]{64}$' AND ${t.fileSha256} = encode(sha256(${t.fileBytes}), 'hex')`,
    ),
    check(
      "receiving_csv_previews_filename_valid",
      sql`length(${t.fileName}) BETWEEN 1 AND 200 AND ${t.fileName} !~ U&'[\\0001-\\001F\\007F-\\009F]'`,
    ),
    check("receiving_csv_previews_header_valid", sql`jsonb_typeof(${t.originalHeader}) = 'object'`),
    check("receiving_csv_previews_findings_valid", sql`jsonb_typeof(${t.findings}) = 'object'`),
    check("receiving_csv_previews_row_count_valid", sql`${t.rowCount} BETWEEN 0 AND 100`),
    check(
      "receiving_csv_previews_proposal_valid",
      sql`
      (${t.proposedDraft} IS NULL AND ${t.previewDigest} IS NULL)
      OR (${t.proposedDraft} IS NOT NULL AND jsonb_typeof(${t.proposedDraft}) = 'object'
        AND ${t.previewDigest} IS NOT NULL AND ${t.previewDigest} ~ '^[0-9a-f]{64}$'
        AND ${t.rowCount} BETWEEN 1 AND 100)`,
    ),
    check(
      "receiving_csv_previews_actor_valid",
      sql`length(btrim(${t.createdBy})) BETWEEN 1 AND 128`,
    ),
    check(
      "receiving_csv_previews_expiry_valid",
      sql`isfinite(${t.createdAt}) AND isfinite(${t.expiresAt}) AND ${t.expiresAt} = ${t.createdAt} + interval '24 hours'`,
    ),
  ],
);

/** Insert with the successful operation inside the business transaction; never infer from file hash. */
export const receivingCsvApplications = pgTable(
  "receiving_csv_applications",
  {
    tenantId: text("tenant_id").notNull(),
    previewId: uuid("preview_id").notNull(),
    command: text("command").notNull().default("receiving.csv.apply"),
    operationKey: uuid("operation_key").notNull(),
    inputDigest: text("input_digest").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.previewId] }),
    foreignKey({
      name: "receiving_csv_applications_preview_fk",
      columns: [t.tenantId, t.previewId, t.inputDigest],
      foreignColumns: [
        receivingCsvPreviews.tenantId,
        receivingCsvPreviews.id,
        receivingCsvPreviews.previewDigest,
      ],
    }),
    foreignKey({
      name: "receiving_csv_applications_operation_fk",
      columns: [t.tenantId, t.command, t.operationKey, t.inputDigest],
      foreignColumns: [
        receivingOperations.tenantId,
        receivingOperations.command,
        receivingOperations.operationKey,
        receivingOperations.inputDigest,
      ],
    }),
    check("receiving_csv_applications_command_valid", sql`${t.command} = 'receiving.csv.apply'`),
  ],
);
