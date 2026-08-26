ALTER TABLE "inventory_scan_batches" DROP CONSTRAINT "inventory_scan_batches_scope_digest_uq";--> statement-breakpoint
ALTER TABLE "inventory_scan_events" ADD CONSTRAINT "inventory_scan_events_tenant_inventory_winner_identity_uq" UNIQUE("tenant_id","inventory_id","event_id","device_id","scanned_at");--> statement-breakpoint
INSERT INTO "inventory_event_claim_outcomes" (
  "tenant_id", "inventory_id", "source_event_id", "code_hash", "status",
  "winning_event_id", "winning_device_id", "winning_scanned_at"
)
SELECT
  source."tenant_id",
  source."inventory_id",
  source."event_id",
  target."code_hash",
  CASE WHEN winner."first_accepted_event_id" = source."event_id" THEN 'claimed' ELSE 'duplicate' END,
  winner."first_accepted_event_id",
  winner."winning_device_id",
  winner."winning_scanned_at"
FROM "inventory_scan_events" source
JOIN "inventories" inventory
  ON inventory."tenant_id" = source."tenant_id"
 AND inventory."id" = source."inventory_id"
JOIN LATERAL (
  SELECT source."code_hash"
   WHERE source."kind" = 'item' AND source."code_hash" IS NOT NULL
  UNION ALL
  SELECT snapshot_code."code_hash"
    FROM "inventory_snapshot_codes" snapshot_code
   WHERE source."kind" = 'known_box'
     AND snapshot_code."tenant_id" = source."tenant_id"
     AND snapshot_code."snapshot_id" = inventory."active_snapshot_id"
     AND snapshot_code."parent_sscc" = substring(source."normalized_identity" FROM 11)
) target ON true
JOIN "inventory_code_results" winner
  ON winner."tenant_id" = source."tenant_id"
 AND winner."inventory_id" = source."inventory_id"
 AND winner."code_hash" = target."code_hash"
ON CONFLICT ("tenant_id", "inventory_id", "source_event_id", "code_hash") DO NOTHING;--> statement-breakpoint
ALTER TABLE "inventory_event_claim_outcomes" ADD CONSTRAINT "inventory_event_claim_outcomes_winner_device_fk" FOREIGN KEY ("tenant_id","winning_device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_event_claim_outcomes" ADD CONSTRAINT "inventory_event_claim_outcomes_winner_identity_fk" FOREIGN KEY ("tenant_id","inventory_id","winning_event_id","winning_device_id","winning_scanned_at") REFERENCES "public"."inventory_scan_events"("tenant_id","inventory_id","event_id","device_id","scanned_at") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_event_claim_outcomes" ADD CONSTRAINT "inventory_event_claim_outcomes_identity_check" CHECK (("inventory_event_claim_outcomes"."status" = 'claimed' and "inventory_event_claim_outcomes"."source_event_id" = "inventory_event_claim_outcomes"."winning_event_id")
        or ("inventory_event_claim_outcomes"."status" = 'duplicate' and "inventory_event_claim_outcomes"."source_event_id" <> "inventory_event_claim_outcomes"."winning_event_id"));
