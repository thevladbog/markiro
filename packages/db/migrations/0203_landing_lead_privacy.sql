-- MKR-PD-01 / MKR-PD-02 2026.10/01 do not authorize attribution in requests.
-- Data-only and repeatable: keep inquiry state and request-id replay protection.
UPDATE landing_leads SET first_utm = NULL, first_referrer = NULL
WHERE first_utm IS NOT NULL OR first_referrer IS NOT NULL;
--> statement-breakpoint
UPDATE landing_lead_events SET payload = payload - 'utm' - 'referrer'
WHERE payload ?| ARRAY['utm', 'referrer'];
--> statement-breakpoint
-- Old encrypted owner notifications may contain attribution. Do not replay them.
-- Use the mail worker's advisory lock so it cannot restore a scrubbed payload.
DO $$
DECLARE delivery record;
BEGIN
  FOR delivery IN SELECT id FROM email_deliveries
    WHERE kind = 'landing-lead-notification' ORDER BY id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(delivery.id::text, 0));
    UPDATE email_deliveries SET
      encrypted_payload = NULL, payload_nonce = NULL, payload_tag = NULL,
      status = CASE WHEN status IN ('queued', 'retrying', 'sending') THEN 'canceled'::email_delivery_status ELSE status END,
      terminal_at = coalesce(terminal_at, now()), attempt_id = NULL, attempt_deadline = NULL,
      error_category = NULL, error_code = NULL, error_text = NULL
    WHERE id = delivery.id;
  END LOOP;
END $$;
--> statement-breakpoint
-- Complete erasure for leads already anonymized by the earlier, partial cleanup.
-- Include encrypted mail digests that referenced one of those leads.
DO $$
DECLARE delivery record;
BEGIN
  FOR delivery IN SELECT d.id FROM email_deliveries AS d
    WHERE d.public_request_id IN (
      SELECT e.public_request_id FROM landing_lead_events AS e
      JOIN landing_leads AS l ON l.id = e.lead_id WHERE l.anonymized_at IS NOT NULL
    ) OR (d.kind = 'landing-lead-digest' AND EXISTS (
      SELECT 1 FROM lead_notifications AS n JOIN landing_leads AS l ON l.anonymized_at IS NOT NULL
      WHERE n.kind = 'daily_digest' AND d.source_id = 'lead-digest:' || n.digest_date::text
        AND jsonb_path_exists(n.payload, '$.sections.*[*] ? (@ == $id)', jsonb_build_object('id', l.id::text))
    )) ORDER BY d.id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(delivery.id::text, 0));
    DELETE FROM email_deliveries WHERE id = delivery.id;
  END LOOP;
END $$;
--> statement-breakpoint
UPDATE landing_leads SET company = NULL, product_group = NULL, inn = NULL,
  owner_note = NULL, tenant_id = NULL, next_touch_at = NULL
WHERE anonymized_at IS NOT NULL;
--> statement-breakpoint
UPDATE landing_lead_events AS e SET payload = jsonb_strip_nulls(jsonb_build_object(
  'consentVersion', CASE WHEN e.payload ->> 'consentVersion' ~ '^MKR-PD-02/[0-9]{4}\.[0-9]{2}/[0-9]{2}$' THEN e.payload ->> 'consentVersion' END,
  'locale', CASE WHEN e.payload ->> 'locale' IN ('ru', 'en') THEN e.payload ->> 'locale' END
)) FROM landing_leads AS l WHERE e.lead_id = l.id AND l.anonymized_at IS NOT NULL;
--> statement-breakpoint
UPDATE lead_notifications AS n SET payload = '{}',
  status = CASE WHEN n.status = 'pending' THEN 'skipped' ELSE n.status END,
  last_error_code = CASE WHEN n.status = 'pending' THEN 'lead_anonymized' ELSE n.last_error_code END
FROM landing_leads AS l WHERE n.lead_id = l.id AND l.anonymized_at IS NOT NULL;
