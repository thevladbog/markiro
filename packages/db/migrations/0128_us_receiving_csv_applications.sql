CREATE TABLE "receiving_csv_applications" (
	"tenant_id" text NOT NULL,
	"preview_id" uuid NOT NULL,
	"command" text DEFAULT 'receiving.csv.apply' NOT NULL,
	"operation_key" uuid NOT NULL,
	"input_digest" text NOT NULL,
	CONSTRAINT "receiving_csv_applications_tenant_id_preview_id_pk" PRIMARY KEY("tenant_id","preview_id"),
	CONSTRAINT "receiving_csv_applications_command_valid" CHECK ("receiving_csv_applications"."command" = 'receiving.csv.apply')
);
--> statement-breakpoint
ALTER TABLE "receiving_operations" DROP CONSTRAINT "receiving_operations_command_valid";--> statement-breakpoint
-- Candidate keys must exist before the composite foreign keys below.
ALTER TABLE "receiving_operations" ADD CONSTRAINT "receiving_operations_content_uq" UNIQUE("tenant_id","command","operation_key","input_digest");--> statement-breakpoint
ALTER TABLE "receiving_csv_previews" ADD CONSTRAINT "receiving_csv_previews_content_uq" UNIQUE("tenant_id","id","preview_digest");--> statement-breakpoint
ALTER TABLE "receiving_csv_applications" ADD CONSTRAINT "receiving_csv_applications_preview_fk" FOREIGN KEY ("tenant_id","preview_id","input_digest") REFERENCES "public"."receiving_csv_previews"("tenant_id","id","preview_digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_csv_applications" ADD CONSTRAINT "receiving_csv_applications_operation_fk" FOREIGN KEY ("tenant_id","command","operation_key","input_digest") REFERENCES "public"."receiving_operations"("tenant_id","command","operation_key","input_digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_operations" ADD CONSTRAINT "receiving_operations_command_valid" CHECK ("receiving_operations"."command" IN ('receiving.create', 'receiving.save', 'receiving.finalize', 'receiving.amend', 'receiving.void', 'receiving.csv.apply'));
