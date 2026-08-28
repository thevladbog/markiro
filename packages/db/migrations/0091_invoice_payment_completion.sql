CREATE TABLE "invoice_payment_completions" (
	"tenant_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"billing_payment_id" uuid NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_payment_completions_tenant_invoice_uq" UNIQUE("tenant_id","invoice_id"),
	CONSTRAINT "invoice_payment_completions_payment_uq" UNIQUE("billing_payment_id")
);
--> statement-breakpoint
-- Install this boundary before foreign-key DDL and legacy backfill. CREATE TRIGGER takes a
-- SHARE ROW EXCLUSIVE lock on billing_payments, so any pre-migration INSERT transaction must
-- finish before the later READ COMMITTED validation/backfill statements take their snapshots.
CREATE FUNCTION "record_invoice_payment_completion"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	"invoice_total" numeric(14, 2);
	"confirmed_total" numeric(14, 2);
BEGIN
	SELECT "total"
	INTO "invoice_total"
	FROM "invoices"
	WHERE "tenant_id" = NEW."tenant_id"
	  AND "id" = NEW."invoice_id"
	  AND "status" IN ('issued', 'partially_paid')
	FOR UPDATE;

	IF NOT FOUND THEN
		RETURN NEW;
	END IF;

	SELECT coalesce(sum("amount"), 0)
	INTO "confirmed_total"
	FROM "billing_payments"
	WHERE "tenant_id" = NEW."tenant_id"
	  AND "invoice_id" = NEW."invoice_id";

	IF "confirmed_total" = "invoice_total" THEN
		INSERT INTO "invoice_payment_completions" ("tenant_id", "invoice_id", "billing_payment_id")
		VALUES (NEW."tenant_id", NEW."invoice_id", NEW."id")
		ON CONFLICT ("tenant_id", "invoice_id") DO NOTHING;

		IF NOT EXISTS (
			SELECT 1
			FROM "invoice_payment_completions"
			WHERE "tenant_id" = NEW."tenant_id"
			  AND "invoice_id" = NEW."invoice_id"
			  AND "billing_payment_id" = NEW."id"
		) THEN
			RAISE EXCEPTION 'invoice payment completion provenance conflict';
		END IF;
	END IF;

	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "billing_payments_record_completion"
AFTER INSERT ON "billing_payments"
FOR EACH ROW EXECUTE FUNCTION "record_invoice_payment_completion"();--> statement-breakpoint
ALTER TABLE "invoice_payment_completions" ADD CONSTRAINT "invoice_payment_completions_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payment_completions" ADD CONSTRAINT "invoice_payment_completions_tenant_payment_fk" FOREIGN KEY ("tenant_id","invoice_id","billing_payment_id") REFERENCES "public"."billing_payments"("tenant_id","invoice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "invoices" AS "invoice"
		WHERE "invoice"."status" = 'paid'
		  AND (
			SELECT count(*)
			FROM "billing_payments" AS "payment"
			WHERE "payment"."tenant_id" = "invoice"."tenant_id"
			  AND "payment"."invoice_id" = "invoice"."id"
			  AND "payment"."amount" = "invoice"."total"
		  ) = 0
	) THEN
		RAISE EXCEPTION 'cannot backfill invoice payment completion: paid invoice has no exact-total payment candidate';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "invoices" AS "invoice"
		WHERE "invoice"."status" = 'paid'
		  AND (
			SELECT count(*)
			FROM "billing_payments" AS "payment"
			WHERE "payment"."tenant_id" = "invoice"."tenant_id"
			  AND "payment"."invoice_id" = "invoice"."id"
			  AND "payment"."amount" = "invoice"."total"
		  ) > 1
	) THEN
		RAISE EXCEPTION 'cannot backfill invoice payment completion: paid invoice has multiple exact-total payment candidates';
	END IF;
END
$$;--> statement-breakpoint
INSERT INTO "invoice_payment_completions" ("tenant_id", "invoice_id", "billing_payment_id")
SELECT "invoice"."tenant_id", "invoice"."id", "payment"."id"
FROM "invoices" AS "invoice"
JOIN "billing_payments" AS "payment"
  ON "payment"."tenant_id" = "invoice"."tenant_id"
 AND "payment"."invoice_id" = "invoice"."id"
 AND "payment"."amount" = "invoice"."total"
WHERE "invoice"."status" = 'paid';
