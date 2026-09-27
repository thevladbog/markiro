CREATE TABLE "receiving_csv_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"template_version" text NOT NULL,
	"file_bytes" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"file_sha256" text NOT NULL,
	"file_name" text,
	"original_header" jsonb NOT NULL,
	"findings" jsonb NOT NULL,
	"proposed_draft" jsonb,
	"preview_digest" text,
	"row_count" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	CONSTRAINT "receiving_csv_previews_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "receiving_csv_previews_template_valid" CHECK ("receiving_csv_previews"."template_version" = 'markiro-receiving-v1'),
	CONSTRAINT "receiving_csv_previews_bytes_valid" CHECK ("receiving_csv_previews"."byte_size" BETWEEN 0 AND 262144 AND "receiving_csv_previews"."byte_size" = octet_length("receiving_csv_previews"."file_bytes")),
	CONSTRAINT "receiving_csv_previews_hash_valid" CHECK ("receiving_csv_previews"."file_sha256" ~ '^[0-9a-f]{64}$' AND "receiving_csv_previews"."file_sha256" = encode(sha256("receiving_csv_previews"."file_bytes"), 'hex')),
	CONSTRAINT "receiving_csv_previews_filename_valid" CHECK (length("receiving_csv_previews"."file_name") BETWEEN 1 AND 200 AND "receiving_csv_previews"."file_name" !~ U&'[\0001-\001F\007F-\009F]'),
	CONSTRAINT "receiving_csv_previews_header_valid" CHECK (jsonb_typeof("receiving_csv_previews"."original_header") = 'object'),
	CONSTRAINT "receiving_csv_previews_findings_valid" CHECK (jsonb_typeof("receiving_csv_previews"."findings") = 'object'),
	CONSTRAINT "receiving_csv_previews_row_count_valid" CHECK ("receiving_csv_previews"."row_count" BETWEEN 0 AND 100),
	CONSTRAINT "receiving_csv_previews_proposal_valid" CHECK (
      ("receiving_csv_previews"."proposed_draft" IS NULL AND "receiving_csv_previews"."preview_digest" IS NULL)
      OR ("receiving_csv_previews"."proposed_draft" IS NOT NULL AND jsonb_typeof("receiving_csv_previews"."proposed_draft") = 'object'
        AND "receiving_csv_previews"."preview_digest" IS NOT NULL AND "receiving_csv_previews"."preview_digest" ~ '^[0-9a-f]{64}$'
        AND "receiving_csv_previews"."row_count" BETWEEN 1 AND 100)),
	CONSTRAINT "receiving_csv_previews_actor_valid" CHECK (length(btrim("receiving_csv_previews"."created_by")) BETWEEN 1 AND 128),
	CONSTRAINT "receiving_csv_previews_expiry_valid" CHECK (isfinite("receiving_csv_previews"."created_at") AND isfinite("receiving_csv_previews"."expires_at") AND "receiving_csv_previews"."expires_at" = "receiving_csv_previews"."created_at" + interval '24 hours')
);
--> statement-breakpoint
ALTER TABLE "receiving_csv_previews" ADD CONSTRAINT "receiving_csv_previews_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receiving_csv_previews_tenant_created_idx" ON "receiving_csv_previews" USING btree ("tenant_id","created_at");