ALTER TABLE "commercial_offer_print_snapshots" ADD COLUMN "seller_bank_account_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "commercial_offer_print_snapshots" ADD COLUMN "buyer_bank_account_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "commercial_offers" ADD COLUMN "seller_bank_account_id" uuid;--> statement-breakpoint
ALTER TABLE "commercial_offers" ADD CONSTRAINT "commercial_offers_seller_account_fk" FOREIGN KEY ("seller_bank_account_id") REFERENCES "public"."operator_bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "seller_bank_account_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "seller_bank_account_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "buyer_bank_account_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_seller_bank_account_id_operator_bank_accounts_id_fk" FOREIGN KEY ("seller_bank_account_id") REFERENCES "public"."operator_bank_accounts"("id") ON DELETE no action ON UPDATE no action;
