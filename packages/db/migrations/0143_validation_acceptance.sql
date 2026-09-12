CREATE TABLE "validation_code_acceptances" (
	"tenant_id" text NOT NULL,
	"shift_id" uuid NOT NULL,
	"code_hash" char(64) NOT NULL,
	"terminal_id" text,
	"scanned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "validation_code_acceptances_tenant_id_shift_id_code_hash_pk" PRIMARY KEY("tenant_id","shift_id","code_hash"),
	CONSTRAINT "validation_acceptance_hash_check" CHECK ("validation_code_acceptances"."code_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "validation_code_acceptances" ADD CONSTRAINT "validation_code_acceptances_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_code_acceptances" ADD CONSTRAINT "validation_acceptance_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Only the effective registry proves legacy ordinary acceptance. Released rows and raw losing scans cannot be inferred.
INSERT INTO validation_code_acceptances (tenant_id, shift_id, code_hash, terminal_id, scanned_at)
SELECT r.tenant_id, r.shift_id, r.code_hash, r.terminal_id, r.scanned_at
FROM code_registry r JOIN shifts s ON s.tenant_id = r.tenant_id AND s.id = r.shift_id
WHERE s.mode = 'validation' AND s.validation_print_mode = 'duplicate_dm'
ON CONFLICT (tenant_id, shift_id, code_hash) DO NOTHING;
