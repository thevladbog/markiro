CREATE TABLE "invoice_payment_completions" (
	"tenant_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"billing_payment_id" uuid NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_payment_completions_tenant_invoice_uq" UNIQUE("tenant_id","invoice_id"),
	CONSTRAINT "invoice_payment_completions_payment_uq" UNIQUE("billing_payment_id")
);
--> statement-breakpoint
ALTER TABLE "invoice_payment_completions" ADD CONSTRAINT "invoice_payment_completions_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payment_completions" ADD CONSTRAINT "invoice_payment_completions_tenant_payment_fk" FOREIGN KEY ("tenant_id","invoice_id","billing_payment_id") REFERENCES "public"."billing_payments"("tenant_id","invoice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "invoice_payment_completions" ("tenant_id", "invoice_id", "billing_payment_id")
SELECT "invoice"."tenant_id", "invoice"."id", "payment"."id"
FROM "invoices" AS "invoice"
JOIN "billing_payments" AS "payment"
  ON "payment"."tenant_id" = "invoice"."tenant_id"
 AND "payment"."invoice_id" = "invoice"."id"
 AND "payment"."amount" = "invoice"."total"
WHERE "invoice"."status" = 'paid';--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "invoices" AS "invoice"
		LEFT JOIN "invoice_payment_completions" AS "completion"
		  ON "completion"."tenant_id" = "invoice"."tenant_id"
		 AND "completion"."invoice_id" = "invoice"."id"
		WHERE "invoice"."status" = 'paid'
		  AND "completion"."invoice_id" IS NULL
	) THEN
		RAISE EXCEPTION 'cannot identify the legacy completing payment for every paid invoice';
	END IF;
END
$$;
