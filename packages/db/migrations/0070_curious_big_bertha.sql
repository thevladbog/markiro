CREATE TYPE "public"."inventory_code_classification" AS ENUM('expected', 'protected', 'ineligible', 'unknown', 'voided');--> statement-breakpoint
CREATE TYPE "public"."inventory_correction_action" AS ENUM('void_scan', 'restore_scan', 'change_date', 'remove_item', 'invalidate_box', 'reprint');--> statement-breakpoint
CREATE TYPE "public"."inventory_late_event_resolution" AS ENUM('pending', 'replayed', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."inventory_participant_join_method" AS ENUM('assigned_line', 'task_barcode');--> statement-breakpoint
CREATE TYPE "public"."inventory_repack_box_state" AS ENUM('open', 'closed', 'invalidated');--> statement-breakpoint
CREATE TYPE "public"."inventory_repack_print_state" AS ENUM('not_ready', 'pending', 'printing', 'printed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inventory_scan_batch_outcome" AS ENUM('applied', 'rejected', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."inventory_scan_event_kind" AS ENUM('item', 'known_box', 'old_box');--> statement-breakpoint
CREATE TABLE "inventory_code_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"code_hash" char(64) NOT NULL,
	"snapshot_id" uuid,
	"first_accepted_event_id" uuid NOT NULL,
	"winning_device_id" uuid NOT NULL,
	"winning_scanned_at" timestamp with time zone NOT NULL,
	"observed_production_date" date,
	"classification" "inventory_code_classification" NOT NULL,
	"origin_classification" "inventory_code_classification" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_code_results_tenant_id_inventory_uq" UNIQUE("tenant_id","id","inventory_id"),
	CONSTRAINT "inventory_code_results_current_claim_uq" UNIQUE("tenant_id","inventory_id","code_hash"),
	CONSTRAINT "inventory_code_results_tenant_id_inventory_observed_date_uq" UNIQUE("tenant_id","id","inventory_id","observed_production_date"),
	CONSTRAINT "inventory_code_results_hash_check" CHECK ("inventory_code_results"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "inventory_code_results_snapshot_origin_check" CHECK ("inventory_code_results"."origin_classification" <> 'voided'
        and ("inventory_code_results"."classification" = "inventory_code_results"."origin_classification"
          or "inventory_code_results"."classification" = 'voided')
        and (("inventory_code_results"."origin_classification" = 'unknown' and "inventory_code_results"."snapshot_id" is null)
          or ("inventory_code_results"."origin_classification" in ('expected', 'protected', 'ineligible')
            and "inventory_code_results"."snapshot_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "inventory_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"action" "inventory_correction_action" NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" text,
	"actor_operator_id" uuid,
	"target_event_id" uuid,
	"target_code_result_id" uuid,
	"target_repack_box_id" uuid,
	"before_projection_digest" char(64) NOT NULL,
	"after_projection_digest" char(64) NOT NULL,
	"result_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_corrections_tenant_id_inventory_uq" UNIQUE("tenant_id","id","inventory_id"),
	CONSTRAINT "inventory_corrections_actor_check" CHECK (("inventory_corrections"."actor_user_id" is null) <> ("inventory_corrections"."actor_operator_id" is null)),
	CONSTRAINT "inventory_corrections_target_check" CHECK ("inventory_corrections"."target_event_id" is not null
        or "inventory_corrections"."target_code_result_id" is not null
        or "inventory_corrections"."target_repack_box_id" is not null),
	CONSTRAINT "inventory_corrections_reason_check" CHECK (octet_length(btrim("inventory_corrections"."reason")) between 1 and 1024),
	CONSTRAINT "inventory_corrections_digests_check" CHECK ("inventory_corrections"."before_projection_digest" ~ '^[0-9a-f]{64}$'
        and "inventory_corrections"."after_projection_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "inventory_corrections_revision_check" CHECK ("inventory_corrections"."result_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_device_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"configured_line_id" uuid NOT NULL,
	"join_method" "inventory_participant_join_method" NOT NULL,
	"different_line_confirmed" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pending_event_count" integer DEFAULT 0 NOT NULL,
	"open_box_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "inventory_device_participants_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_device_participants_tenant_inventory_device_uq" UNIQUE("tenant_id","inventory_id","device_id"),
	CONSTRAINT "inventory_device_participants_counts_check" CHECK ("inventory_device_participants"."pending_event_count" >= 0 and "inventory_device_participants"."open_box_count" >= 0),
	CONSTRAINT "inventory_device_participants_timestamps_check" CHECK ("inventory_device_participants"."left_at" is null or "inventory_device_participants"."left_at" >= "inventory_device_participants"."joined_at")
);
--> statement-breakpoint
CREATE TABLE "inventory_late_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"batch_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_digest" char(64) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_revision" integer NOT NULL,
	"reason" text NOT NULL,
	"resolution" "inventory_late_event_resolution" DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" text,
	CONSTRAINT "inventory_late_events_tenant_id_inventory_uq" UNIQUE("tenant_id","id","inventory_id"),
	CONSTRAINT "inventory_late_events_scope_batch_uq" UNIQUE("tenant_id","inventory_id","device_id","batch_id"),
	CONSTRAINT "inventory_late_events_scope_digest_uq" UNIQUE("tenant_id","inventory_id","device_id","payload_digest"),
	CONSTRAINT "inventory_late_events_batch_id_check" CHECK (octet_length("inventory_late_events"."batch_id") between 1 and 128),
	CONSTRAINT "inventory_late_events_payload_digest_check" CHECK ("inventory_late_events"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "inventory_late_events_revision_check" CHECK ("inventory_late_events"."closed_revision" >= 0),
	CONSTRAINT "inventory_late_events_reason_check" CHECK ("inventory_late_events"."reason" ~ '^[A-Z][A-Z0-9_]{0,127}$'),
	CONSTRAINT "inventory_late_events_resolution_check" CHECK (("inventory_late_events"."resolution" = 'pending'
          and "inventory_late_events"."resolved_at" is null
          and "inventory_late_events"."resolved_by_user_id" is null)
        or ("inventory_late_events"."resolution" in ('replayed', 'discarded')
          and "inventory_late_events"."resolved_at" is not null
          and "inventory_late_events"."resolved_by_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "inventory_repack_boxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"old_sscc_context" char(18),
	"new_sscc" char(18) NOT NULL,
	"owner_device_id" uuid NOT NULL,
	"capacity" integer NOT NULL,
	"production_date" date NOT NULL,
	"state" "inventory_repack_box_state" DEFAULT 'open' NOT NULL,
	"print_state" "inventory_repack_print_state" DEFAULT 'not_ready' NOT NULL,
	"print_attempt_count" integer DEFAULT 0 NOT NULL,
	"print_error_code" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"printed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_repack_boxes_tenant_id_inventory_uq" UNIQUE("tenant_id","id","inventory_id"),
	CONSTRAINT "inventory_repack_boxes_tenant_id_inventory_date_uq" UNIQUE("tenant_id","id","inventory_id","production_date"),
	CONSTRAINT "inventory_repack_boxes_tenant_sscc_uq" UNIQUE("tenant_id","new_sscc"),
	CONSTRAINT "inventory_repack_boxes_capacity_check" CHECK ("inventory_repack_boxes"."capacity" > 0),
	CONSTRAINT "inventory_repack_boxes_sscc_check" CHECK ("inventory_repack_boxes"."new_sscc" ~ '^[0-9]{18}$'
        and ("inventory_repack_boxes"."old_sscc_context" is null or "inventory_repack_boxes"."old_sscc_context" ~ '^[0-9]{18}$')),
	CONSTRAINT "inventory_repack_boxes_lifecycle_check" CHECK (("inventory_repack_boxes"."state" = 'open' and "inventory_repack_boxes"."closed_at" is null and "inventory_repack_boxes"."invalidated_at" is null)
        or ("inventory_repack_boxes"."state" = 'closed' and "inventory_repack_boxes"."closed_at" is not null and "inventory_repack_boxes"."invalidated_at" is null)
        or ("inventory_repack_boxes"."state" = 'invalidated' and "inventory_repack_boxes"."invalidated_at" is not null)),
	CONSTRAINT "inventory_repack_boxes_lifecycle_print_check" CHECK (("inventory_repack_boxes"."state" = 'open' and "inventory_repack_boxes"."print_state" = 'not_ready')
        or ("inventory_repack_boxes"."state" = 'closed'
          and "inventory_repack_boxes"."print_state" in ('pending', 'printing', 'printed', 'failed'))
        or "inventory_repack_boxes"."state" = 'invalidated'),
	CONSTRAINT "inventory_repack_boxes_print_state_check" CHECK (("inventory_repack_boxes"."print_state" = 'failed' and "inventory_repack_boxes"."print_error_code" is not null)
        or ("inventory_repack_boxes"."print_state" <> 'failed' and "inventory_repack_boxes"."print_error_code" is null)),
	CONSTRAINT "inventory_repack_boxes_print_error_code_check" CHECK ("inventory_repack_boxes"."print_error_code" is null or "inventory_repack_boxes"."print_error_code" ~ '^[A-Z][A-Z0-9_]{0,127}$'),
	CONSTRAINT "inventory_repack_boxes_print_attempt_count_check" CHECK (("inventory_repack_boxes"."print_state" = 'not_ready' and "inventory_repack_boxes"."print_attempt_count" = 0)
        or ("inventory_repack_boxes"."print_state" = 'pending' and "inventory_repack_boxes"."print_attempt_count" >= 0)
        or ("inventory_repack_boxes"."print_state" in ('printing', 'printed', 'failed')
          and "inventory_repack_boxes"."print_attempt_count" > 0)),
	CONSTRAINT "inventory_repack_boxes_printed_at_check" CHECK (("inventory_repack_boxes"."print_state" = 'printed' and "inventory_repack_boxes"."printed_at" is not null)
        or ("inventory_repack_boxes"."print_state" <> 'printed' and "inventory_repack_boxes"."printed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "inventory_repack_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"box_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"production_date" date NOT NULL,
	"active_observed_production_date" date,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "inventory_repack_items_tenant_id_inventory_uq" UNIQUE("tenant_id","id","inventory_id"),
	CONSTRAINT "inventory_repack_items_tenant_box_result_uq" UNIQUE("tenant_id","box_id","result_id"),
	CONSTRAINT "inventory_repack_items_removed_at_check" CHECK ("inventory_repack_items"."removed_at" is null or "inventory_repack_items"."removed_at" >= "inventory_repack_items"."added_at"),
	CONSTRAINT "inventory_repack_items_active_observed_date_check" CHECK (("inventory_repack_items"."removed_at" is null
          and "inventory_repack_items"."active_observed_production_date" is not null
          and "inventory_repack_items"."active_observed_production_date" = "inventory_repack_items"."production_date")
        or ("inventory_repack_items"."removed_at" is not null
          and "inventory_repack_items"."active_observed_production_date" is null))
);
--> statement-breakpoint
CREATE TABLE "inventory_scan_batches" (
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"batch_id" text NOT NULL,
	"payload_digest" char(64) NOT NULL,
	"sequence_ceiling" bigint NOT NULL,
	"outcome" "inventory_scan_batch_outcome" NOT NULL,
	"result" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_scan_batches_scope_batch_uq" UNIQUE("tenant_id","inventory_id","device_id","batch_id"),
	CONSTRAINT "inventory_scan_batches_scope_digest_uq" UNIQUE("tenant_id","inventory_id","device_id","payload_digest"),
	CONSTRAINT "inventory_scan_batches_batch_id_check" CHECK (octet_length("inventory_scan_batches"."batch_id") between 1 and 128),
	CONSTRAINT "inventory_scan_batches_payload_digest_check" CHECK ("inventory_scan_batches"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "inventory_scan_batches_sequence_check" CHECK ("inventory_scan_batches"."sequence_ceiling" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_scan_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"inventory_id" uuid NOT NULL,
	"batch_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"device_sequence" bigint NOT NULL,
	"operator_id" uuid NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL,
	"kind" "inventory_scan_event_kind" NOT NULL,
	"normalized_identity" text NOT NULL,
	"code_hash" char(64),
	"raw_payload" text,
	"active_production_date" date,
	"snapshot_revision" integer NOT NULL,
	"local_verdict" text NOT NULL,
	"authoritative_verdict" text NOT NULL,
	"first_winning_event_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_scan_events_tenant_inventory_event_uq" UNIQUE("tenant_id","inventory_id","event_id"),
	CONSTRAINT "inventory_scan_events_tenant_inventory_device_sequence_uq" UNIQUE("tenant_id","inventory_id","device_id","device_sequence"),
	CONSTRAINT "inventory_scan_events_sequence_check" CHECK ("inventory_scan_events"."device_sequence" >= 0),
	CONSTRAINT "inventory_scan_events_snapshot_revision_check" CHECK ("inventory_scan_events"."snapshot_revision" > 0),
	CONSTRAINT "inventory_scan_events_normalized_identity_check" CHECK (octet_length("inventory_scan_events"."normalized_identity") between 1 and 1024),
	CONSTRAINT "inventory_scan_events_code_hash_check" CHECK ("inventory_scan_events"."code_hash" is null or "inventory_scan_events"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "inventory_scan_events_raw_payload_check" CHECK ("inventory_scan_events"."raw_payload" is null or octet_length("inventory_scan_events"."raw_payload") between 1 and 2048),
	CONSTRAINT "inventory_scan_events_verdicts_check" CHECK (octet_length("inventory_scan_events"."local_verdict") between 1 and 64
        and octet_length("inventory_scan_events"."authoritative_verdict") between 1 and 64)
);
--> statement-breakpoint
ALTER TABLE "inventory_code_results" ADD CONSTRAINT "inventory_code_results_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_code_results" ADD CONSTRAINT "inventory_code_results_tenant_inventory_fk" FOREIGN KEY ("tenant_id","inventory_id") REFERENCES "public"."inventories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_code_results" ADD CONSTRAINT "inventory_code_results_tenant_snapshot_inventory_fk" FOREIGN KEY ("tenant_id","snapshot_id","inventory_id") REFERENCES "public"."inventory_snapshots"("tenant_id","id","inventory_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_code_results" ADD CONSTRAINT "inventory_code_results_tenant_snapshot_code_fk" FOREIGN KEY ("tenant_id","snapshot_id","code_hash") REFERENCES "public"."inventory_snapshot_codes"("tenant_id","snapshot_id","code_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_code_results" ADD CONSTRAINT "inventory_code_results_tenant_first_event_fk" FOREIGN KEY ("tenant_id","inventory_id","first_accepted_event_id") REFERENCES "public"."inventory_scan_events"("tenant_id","inventory_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_code_results" ADD CONSTRAINT "inventory_code_results_tenant_winning_device_fk" FOREIGN KEY ("tenant_id","winning_device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_corrections" ADD CONSTRAINT "inventory_corrections_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_corrections" ADD CONSTRAINT "inventory_corrections_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_corrections" ADD CONSTRAINT "inventory_corrections_tenant_inventory_fk" FOREIGN KEY ("tenant_id","inventory_id") REFERENCES "public"."inventories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_corrections" ADD CONSTRAINT "inventory_corrections_tenant_operator_fk" FOREIGN KEY ("tenant_id","actor_operator_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_corrections" ADD CONSTRAINT "inventory_corrections_tenant_event_fk" FOREIGN KEY ("tenant_id","inventory_id","target_event_id") REFERENCES "public"."inventory_scan_events"("tenant_id","inventory_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_corrections" ADD CONSTRAINT "inventory_corrections_tenant_result_fk" FOREIGN KEY ("tenant_id","target_code_result_id","inventory_id") REFERENCES "public"."inventory_code_results"("tenant_id","id","inventory_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_corrections" ADD CONSTRAINT "inventory_corrections_tenant_box_fk" FOREIGN KEY ("tenant_id","target_repack_box_id","inventory_id") REFERENCES "public"."inventory_repack_boxes"("tenant_id","id","inventory_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_device_participants" ADD CONSTRAINT "inventory_device_participants_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_device_participants" ADD CONSTRAINT "inventory_device_participants_tenant_inventory_fk" FOREIGN KEY ("tenant_id","inventory_id") REFERENCES "public"."inventories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_device_participants" ADD CONSTRAINT "inventory_device_participants_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_device_participants" ADD CONSTRAINT "inventory_device_participants_tenant_operator_fk" FOREIGN KEY ("tenant_id","operator_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_device_participants" ADD CONSTRAINT "inventory_device_participants_tenant_line_fk" FOREIGN KEY ("tenant_id","configured_line_id") REFERENCES "public"."lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_late_events" ADD CONSTRAINT "inventory_late_events_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_late_events" ADD CONSTRAINT "inventory_late_events_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_late_events" ADD CONSTRAINT "inventory_late_events_tenant_inventory_fk" FOREIGN KEY ("tenant_id","inventory_id") REFERENCES "public"."inventories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_late_events" ADD CONSTRAINT "inventory_late_events_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_repack_boxes" ADD CONSTRAINT "inventory_repack_boxes_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_repack_boxes" ADD CONSTRAINT "inventory_repack_boxes_tenant_inventory_fk" FOREIGN KEY ("tenant_id","inventory_id") REFERENCES "public"."inventories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_repack_boxes" ADD CONSTRAINT "inventory_repack_boxes_tenant_owner_device_fk" FOREIGN KEY ("tenant_id","owner_device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_repack_items" ADD CONSTRAINT "inventory_repack_items_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_repack_items" ADD CONSTRAINT "inventory_repack_items_tenant_box_date_fk" FOREIGN KEY ("tenant_id","box_id","inventory_id","production_date") REFERENCES "public"."inventory_repack_boxes"("tenant_id","id","inventory_id","production_date") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_repack_items" ADD CONSTRAINT "inventory_repack_items_tenant_result_fk" FOREIGN KEY ("tenant_id","result_id","inventory_id") REFERENCES "public"."inventory_code_results"("tenant_id","id","inventory_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_repack_items" ADD CONSTRAINT "inventory_repack_items_tenant_result_active_date_fk" FOREIGN KEY ("tenant_id","result_id","inventory_id","active_observed_production_date") REFERENCES "public"."inventory_code_results"("tenant_id","id","inventory_id","observed_production_date") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_scan_batches" ADD CONSTRAINT "inventory_scan_batches_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_scan_batches" ADD CONSTRAINT "inventory_scan_batches_tenant_inventory_fk" FOREIGN KEY ("tenant_id","inventory_id") REFERENCES "public"."inventories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_scan_batches" ADD CONSTRAINT "inventory_scan_batches_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_scan_events" ADD CONSTRAINT "inventory_scan_events_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_scan_events" ADD CONSTRAINT "inventory_scan_events_tenant_batch_fk" FOREIGN KEY ("tenant_id","inventory_id","device_id","batch_id") REFERENCES "public"."inventory_scan_batches"("tenant_id","inventory_id","device_id","batch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_scan_events" ADD CONSTRAINT "inventory_scan_events_tenant_operator_fk" FOREIGN KEY ("tenant_id","operator_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_scan_events" ADD CONSTRAINT "inventory_scan_events_tenant_first_winner_fk" FOREIGN KEY ("tenant_id","inventory_id","first_winning_event_id") REFERENCES "public"."inventory_scan_events"("tenant_id","inventory_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_code_results_progress_cursor_idx" ON "inventory_code_results" USING btree ("tenant_id","inventory_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "inventory_corrections_progress_cursor_idx" ON "inventory_corrections" USING btree ("tenant_id","inventory_id","result_revision","created_at","id");--> statement-breakpoint
CREATE INDEX "inventory_device_participants_close_blockers_idx" ON "inventory_device_participants" USING btree ("tenant_id","inventory_id","left_at","pending_event_count","open_box_count");--> statement-breakpoint
CREATE INDEX "inventory_late_events_resolution_idx" ON "inventory_late_events" USING btree ("tenant_id","inventory_id","resolution","received_at");--> statement-breakpoint
CREATE INDEX "inventory_repack_boxes_owner_open_idx" ON "inventory_repack_boxes" USING btree ("tenant_id","inventory_id","owner_device_id","state");--> statement-breakpoint
CREATE INDEX "inventory_repack_boxes_close_blockers_idx" ON "inventory_repack_boxes" USING btree ("tenant_id","inventory_id","state","print_state");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_repack_items_active_result_uq" ON "inventory_repack_items" USING btree ("tenant_id","inventory_id","result_id") WHERE "inventory_repack_items"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "inventory_repack_items_box_active_idx" ON "inventory_repack_items" USING btree ("tenant_id","inventory_id","box_id","removed_at");--> statement-breakpoint
CREATE INDEX "inventory_scan_batches_replay_idx" ON "inventory_scan_batches" USING btree ("tenant_id","inventory_id","device_id","received_at");--> statement-breakpoint
CREATE INDEX "inventory_scan_events_progress_cursor_idx" ON "inventory_scan_events" USING btree ("tenant_id","inventory_id","recorded_at","event_id");--> statement-breakpoint
CREATE INDEX "inventory_scan_events_batch_idx" ON "inventory_scan_events" USING btree ("tenant_id","inventory_id","device_id","batch_id");