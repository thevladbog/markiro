CREATE TABLE "commercial_offer_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"offer_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"object_key" text,
	"content_type" text,
	"sha256" text,
	"byte_size" integer,
	"renderer_version" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_offer_documents_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "commercial_offer_documents_offer_revision_format_uq" UNIQUE("offer_id","revision","format"),
	CONSTRAINT "commercial_offer_documents_revision_positive" CHECK ("commercial_offer_documents"."revision" > 0),
	CONSTRAINT "commercial_offer_documents_format_check" CHECK ("commercial_offer_documents"."format" in ('pdf', 'html')),
	CONSTRAINT "commercial_offer_documents_status_check" CHECK ("commercial_offer_documents"."status" in ('pending', 'ready', 'failed')),
	CONSTRAINT "commercial_offer_documents_ready_metadata_check" CHECK ("commercial_offer_documents"."status" <> 'ready' or ("commercial_offer_documents"."object_key" is not null and "commercial_offer_documents"."sha256" is not null and "commercial_offer_documents"."byte_size" is not null))
);
--> statement-breakpoint
CREATE TABLE "commercial_offer_print_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"offer_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"number" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"seller_snapshot" jsonb NOT NULL,
	"buyer_snapshot" jsonb NOT NULL,
	"lines_snapshot" jsonb NOT NULL,
	"subtotal" numeric(14, 2) NOT NULL,
	"vat_total" numeric(14, 2) NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"terms_markdown" text,
	"terms_html" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_offer_print_snapshots_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "commercial_offer_print_snapshots_offer_revision_uq" UNIQUE("offer_id","revision"),
	CONSTRAINT "commercial_offer_print_snapshots_revision_positive" CHECK ("commercial_offer_print_snapshots"."revision" > 0),
	CONSTRAINT "commercial_offer_print_snapshots_totals_nonnegative" CHECK ("commercial_offer_print_snapshots"."subtotal" >= 0 and "commercial_offer_print_snapshots"."vat_total" >= 0 and "commercial_offer_print_snapshots"."total" >= 0)
);
--> statement-breakpoint
ALTER TABLE "commercial_offers" ADD COLUMN "number" text;--> statement-breakpoint
ALTER TABLE "commercial_offers" ADD COLUMN "terms_markdown" text;--> statement-breakpoint
ALTER TABLE "commercial_offer_documents" ADD CONSTRAINT "commercial_offer_documents_tenant_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."commercial_offers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_offer_print_snapshots" ADD CONSTRAINT "commercial_offer_print_snapshots_tenant_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."commercial_offers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_offers" ADD CONSTRAINT "commercial_offers_number_uq" UNIQUE("number");