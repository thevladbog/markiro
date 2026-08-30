ALTER TABLE "invoice_documents" ADD COLUMN "print_variant" text DEFAULT 'clean' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_act_documents" ADD COLUMN "print_variant" text DEFAULT 'clean' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_print_variant_check" CHECK ("invoice_documents"."print_variant" in ('clean', 'signed'));--> statement-breakpoint
ALTER TABLE "billing_act_documents" ADD CONSTRAINT "billing_act_documents_print_variant_check" CHECK ("billing_act_documents"."print_variant" in ('clean', 'signed'));