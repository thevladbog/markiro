DROP TRIGGER "commercial_offer_lines_immutable_published" ON "commercial_offer_lines";--> statement-breakpoint
DROP FUNCTION "reject_published_offer_line_mutation"();--> statement-breakpoint
ALTER TABLE "commercial_offers" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."offer_status" RENAME TO "offer_status_0071_old";--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('draft', 'published', 'superseded', 'paid', 'cancelled', 'expired');--> statement-breakpoint
ALTER TABLE "commercial_offers" ALTER COLUMN "status" TYPE "public"."offer_status"
  USING ("status"::text::"public"."offer_status");--> statement-breakpoint
ALTER TABLE "commercial_offers" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
DROP TYPE "public"."offer_status_0071_old";--> statement-breakpoint
CREATE FUNCTION "reject_published_offer_line_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	parent_status "public"."offer_status";
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		SELECT status INTO parent_status
		FROM commercial_offers
		WHERE id = OLD.offer_id;
		IF parent_status IS DISTINCT FROM 'draft' THEN
			RAISE EXCEPTION 'published commercial offer lines are immutable';
		END IF;
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		SELECT status INTO parent_status
		FROM commercial_offers
		WHERE id = NEW.offer_id;
		IF parent_status IS DISTINCT FROM 'draft' THEN
			RAISE EXCEPTION 'published commercial offer lines are immutable';
		END IF;
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "commercial_offer_lines_immutable_published"
BEFORE INSERT OR UPDATE OR DELETE ON "commercial_offer_lines"
FOR EACH ROW EXECUTE FUNCTION "reject_published_offer_line_mutation"();--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    WITH current_generations AS (
      SELECT tenant_id, family_id, revision,
             max(revision) OVER (PARTITION BY tenant_id, family_id) AS max_revision
      FROM commercial_offers
      WHERE status <> 'draft'
    )
    SELECT 1
    FROM current_generations
    WHERE revision = max_revision
    GROUP BY tenant_id, family_id, revision
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commercial_offer_current_revision_ambiguous';
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM billing_acts AS act
    INNER JOIN tenant_billing_request_links AS link
      ON link.tenant_id = act.tenant_id AND link.act_id = act.id
    WHERE act.request_id IS NOT NULL AND act.request_id <> link.request_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_act_request_link_mismatch';
  END IF;
END $$;--> statement-breakpoint
WITH current_generation AS (
  SELECT tenant_id, family_id, max(revision) AS revision
  FROM commercial_offers
  WHERE status <> 'draft'
  GROUP BY tenant_id, family_id
)
UPDATE commercial_offers AS offer
SET status = 'superseded', updated_at = now()
FROM current_generation AS current
WHERE offer.tenant_id = current.tenant_id
  AND offer.family_id = current.family_id
  AND offer.status = 'published'
  AND offer.revision < current.revision;--> statement-breakpoint
UPDATE billing_acts AS act
SET request_id = link.request_id, updated_at = now()
FROM tenant_billing_request_links AS link
WHERE act.tenant_id = link.tenant_id
  AND act.id = link.act_id
  AND act.request_id IS NULL;--> statement-breakpoint
INSERT INTO tenant_billing_request_links (tenant_id, request_id, act_id)
SELECT act.tenant_id, act.request_id, act.id
FROM billing_acts AS act
WHERE act.request_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM tenant_billing_request_links AS link
    WHERE link.tenant_id = act.tenant_id AND link.act_id = act.id
  );
