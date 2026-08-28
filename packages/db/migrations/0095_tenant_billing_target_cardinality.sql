ALTER TYPE "public"."offer_status" ADD VALUE 'superseded' BEFORE 'paid';--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_published_offer_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD.status <> 'draft' THEN
		IF TG_OP = 'DELETE' THEN
			RAISE EXCEPTION 'published commercial offers are immutable';
		END IF;
		IF (to_jsonb(NEW) - ARRAY['status', 'paid_at', 'updated_at'])
			IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'paid_at', 'updated_at']) THEN
			RAISE EXCEPTION 'published commercial offer terms are immutable';
		END IF;
		IF NEW.status NOT IN ('published', 'superseded', 'paid', 'cancelled', 'expired')
			OR (OLD.status = 'superseded' AND NEW.status <> 'superseded') THEN
			RAISE EXCEPTION 'invalid published commercial offer transition';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tenant_billing_request_links
    WHERE offer_id IS NOT NULL
    GROUP BY tenant_id, offer_id
    HAVING count(DISTINCT request_id) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'tenant_billing_request_link_target_ambiguity:offer';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM tenant_billing_request_links
    WHERE invoice_id IS NOT NULL
    GROUP BY tenant_id, invoice_id
    HAVING count(DISTINCT request_id) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'tenant_billing_request_link_target_ambiguity:invoice';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM tenant_billing_request_links
    WHERE act_id IS NOT NULL
    GROUP BY tenant_id, act_id
    HAVING count(DISTINCT request_id) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'tenant_billing_request_link_target_ambiguity:act';
  END IF;
END $$;--> statement-breakpoint
DROP INDEX "tenant_billing_request_links_offer_uq";--> statement-breakpoint
DROP INDEX "tenant_billing_request_links_invoice_uq";--> statement-breakpoint
DROP INDEX "tenant_billing_request_links_act_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_billing_request_links_offer_uq" ON "tenant_billing_request_links" USING btree ("tenant_id","offer_id") WHERE "tenant_billing_request_links"."offer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_billing_request_links_invoice_uq" ON "tenant_billing_request_links" USING btree ("tenant_id","invoice_id") WHERE "tenant_billing_request_links"."invoice_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_billing_request_links_act_uq" ON "tenant_billing_request_links" USING btree ("tenant_id","act_id") WHERE "tenant_billing_request_links"."act_id" is not null;
