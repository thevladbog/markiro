CREATE TABLE "offline_grant_activation_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preparation_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"tenant_name" text NOT NULL,
	"subscription_id" uuid NOT NULL,
	"owner_kind" text NOT NULL,
	"station_device_id" uuid,
	"kiosk_id" uuid,
	"device_name" text NOT NULL,
	"credential_epoch" integer NOT NULL,
	"assignment_id" uuid,
	"configuration_id" uuid NOT NULL,
	"client_report_id" uuid NOT NULL,
	"verified_grant_id" uuid NOT NULL,
	"keyset_revision" text NOT NULL,
	"entitlement_revision" text NOT NULL,
	"reservation_state" text DEFAULT 'prepared' NOT NULL,
	CONSTRAINT "offline_grant_activation_members_preparation_owner_uq" UNIQUE("preparation_id","owner_kind","station_device_id","kiosk_id"),
	CONSTRAINT "offline_grant_activation_members_owner_check" CHECK (("offline_grant_activation_members"."owner_kind" in ('station','handheld') and "offline_grant_activation_members"."station_device_id" is not null and "offline_grant_activation_members"."kiosk_id" is null and "offline_grant_activation_members"."assignment_id" is not null) or ("offline_grant_activation_members"."owner_kind" = 'kiosk' and "offline_grant_activation_members"."kiosk_id" is not null and "offline_grant_activation_members"."station_device_id" is null and "offline_grant_activation_members"."assignment_id" is null)),
	CONSTRAINT "offline_grant_activation_members_snapshot_check" CHECK ("offline_grant_activation_members"."credential_epoch" > 0 and "offline_grant_activation_members"."entitlement_revision" ~ '^(0|[1-9][0-9]*)$' and length(btrim("offline_grant_activation_members"."tenant_name")) between 1 and 300 and length(btrim("offline_grant_activation_members"."device_name")) between 1 and 300 and length(btrim("offline_grant_activation_members"."keyset_revision")) between 1 and 512 and "offline_grant_activation_members"."reservation_state" in ('prepared','released'))
);
--> statement-breakpoint
CREATE TABLE "offline_grant_activation_preparations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"base_policy_id" uuid NOT NULL,
	"rollout_policy_id" uuid,
	"preview_request_id" uuid NOT NULL,
	"preview_digest" text NOT NULL,
	"preparation_digest" text NOT NULL,
	"prepare_request_id" uuid NOT NULL,
	"prepare_request_hash" text NOT NULL,
	"prepare_response" jsonb NOT NULL,
	"decision_reference" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"prepared_by_platform_user_id" text NOT NULL,
	"prepared_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirm_request_id" uuid,
	"confirm_request_hash" text,
	"confirm_response" jsonb,
	"confirmed_by_platform_user_id" text,
	"confirmed_at" timestamp with time zone,
	"cancel_request_id" uuid,
	"cancel_request_hash" text,
	"cancel_response" jsonb,
	"cancelled_by_platform_user_id" text,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	CONSTRAINT "offline_grant_activation_prepare_request_uq" UNIQUE("prepare_request_id"),
	CONSTRAINT "offline_grant_activation_confirm_request_uq" UNIQUE("confirm_request_id"),
	CONSTRAINT "offline_grant_activation_cancel_request_uq" UNIQUE("cancel_request_id"),
	CONSTRAINT "offline_grant_activation_preparation_digest_uq" UNIQUE("preparation_digest"),
	CONSTRAINT "offline_grant_activation_state_check" CHECK ("offline_grant_activation_preparations"."state" in ('prepared','confirmed','cancelled','needs_review') and
        (("offline_grant_activation_preparations"."state" = 'prepared' and "offline_grant_activation_preparations"."rollout_policy_id" is null and "offline_grant_activation_preparations"."confirm_request_id" is null and "offline_grant_activation_preparations"."confirm_request_hash" is null and "offline_grant_activation_preparations"."confirm_response" is null and "offline_grant_activation_preparations"."confirmed_by_platform_user_id" is null and "offline_grant_activation_preparations"."confirmed_at" is null and "offline_grant_activation_preparations"."cancel_request_id" is null and "offline_grant_activation_preparations"."cancel_request_hash" is null and "offline_grant_activation_preparations"."cancel_response" is null and "offline_grant_activation_preparations"."cancelled_by_platform_user_id" is null and "offline_grant_activation_preparations"."cancelled_at" is null and "offline_grant_activation_preparations"."cancellation_reason" is null)
        or ("offline_grant_activation_preparations"."state" = 'confirmed' and "offline_grant_activation_preparations"."rollout_policy_id" is not null and "offline_grant_activation_preparations"."confirm_request_id" is not null and "offline_grant_activation_preparations"."confirm_request_hash" is not null and "offline_grant_activation_preparations"."confirm_response" is not null and "offline_grant_activation_preparations"."confirmed_by_platform_user_id" is not null and "offline_grant_activation_preparations"."confirmed_at" is not null and "offline_grant_activation_preparations"."cancel_request_id" is null and "offline_grant_activation_preparations"."cancel_request_hash" is null and "offline_grant_activation_preparations"."cancel_response" is null and "offline_grant_activation_preparations"."cancelled_by_platform_user_id" is null and "offline_grant_activation_preparations"."cancelled_at" is null and "offline_grant_activation_preparations"."cancellation_reason" is null)
        or ("offline_grant_activation_preparations"."state" = 'needs_review' and "offline_grant_activation_preparations"."rollout_policy_id" is null and "offline_grant_activation_preparations"."confirm_request_id" is not null and "offline_grant_activation_preparations"."confirm_request_hash" is not null and "offline_grant_activation_preparations"."confirm_response" is not null and "offline_grant_activation_preparations"."confirmed_by_platform_user_id" is not null and "offline_grant_activation_preparations"."confirmed_at" is not null and "offline_grant_activation_preparations"."cancel_request_id" is null and "offline_grant_activation_preparations"."cancel_request_hash" is null and "offline_grant_activation_preparations"."cancel_response" is null and "offline_grant_activation_preparations"."cancelled_by_platform_user_id" is null and "offline_grant_activation_preparations"."cancelled_at" is null and "offline_grant_activation_preparations"."cancellation_reason" is null)
        or ("offline_grant_activation_preparations"."state" = 'cancelled' and "offline_grant_activation_preparations"."rollout_policy_id" is null and (("offline_grant_activation_preparations"."confirm_request_id" is null and "offline_grant_activation_preparations"."confirm_request_hash" is null and "offline_grant_activation_preparations"."confirm_response" is null and "offline_grant_activation_preparations"."confirmed_by_platform_user_id" is null and "offline_grant_activation_preparations"."confirmed_at" is null) or ("offline_grant_activation_preparations"."confirm_request_id" is not null and "offline_grant_activation_preparations"."confirm_request_hash" is not null and "offline_grant_activation_preparations"."confirm_response" is not null and "offline_grant_activation_preparations"."confirmed_by_platform_user_id" is not null and "offline_grant_activation_preparations"."confirmed_at" is not null)) and "offline_grant_activation_preparations"."cancel_request_id" is not null and "offline_grant_activation_preparations"."cancel_request_hash" is not null and "offline_grant_activation_preparations"."cancel_response" is not null and "offline_grant_activation_preparations"."cancelled_by_platform_user_id" is not null and "offline_grant_activation_preparations"."cancelled_at" is not null and "offline_grant_activation_preparations"."cancellation_reason" is not null))),
	CONSTRAINT "offline_grant_activation_interval_check" CHECK (isfinite("offline_grant_activation_preparations"."prepared_at") and isfinite("offline_grant_activation_preparations"."expires_at") and "offline_grant_activation_preparations"."expires_at" = "offline_grant_activation_preparations"."prepared_at" + interval '30 minutes' and ("offline_grant_activation_preparations"."confirmed_at" is null or (isfinite("offline_grant_activation_preparations"."confirmed_at") and "offline_grant_activation_preparations"."confirmed_at" >= "offline_grant_activation_preparations"."prepared_at" and "offline_grant_activation_preparations"."confirmed_at" < "offline_grant_activation_preparations"."expires_at")) and ("offline_grant_activation_preparations"."cancelled_at" is null or (isfinite("offline_grant_activation_preparations"."cancelled_at") and "offline_grant_activation_preparations"."cancelled_at" >= "offline_grant_activation_preparations"."prepared_at"))),
	CONSTRAINT "offline_grant_activation_confirm_actor_check" CHECK ("offline_grant_activation_preparations"."confirmed_by_platform_user_id" is null or "offline_grant_activation_preparations"."confirmed_by_platform_user_id" <> "offline_grant_activation_preparations"."prepared_by_platform_user_id"),
	CONSTRAINT "offline_grant_activation_payload_check" CHECK ("offline_grant_activation_preparations"."preview_digest" ~ '^[0-9a-f]{64}$' and "offline_grant_activation_preparations"."preparation_digest" ~ '^[0-9a-f]{64}$' and "offline_grant_activation_preparations"."prepare_request_hash" ~ '^[0-9a-f]{64}$' and ("offline_grant_activation_preparations"."confirm_request_hash" is null or "offline_grant_activation_preparations"."confirm_request_hash" ~ '^[0-9a-f]{64}$') and ("offline_grant_activation_preparations"."cancel_request_hash" is null or "offline_grant_activation_preparations"."cancel_request_hash" ~ '^[0-9a-f]{64}$') and jsonb_typeof("offline_grant_activation_preparations"."prepare_response") = 'object' and jsonb_typeof("offline_grant_activation_preparations"."snapshot") = 'object' and octet_length("offline_grant_activation_preparations"."prepare_response"::text) <= 262144 and octet_length("offline_grant_activation_preparations"."snapshot"::text) <= 262144 and ("offline_grant_activation_preparations"."confirm_response" is null or (jsonb_typeof("offline_grant_activation_preparations"."confirm_response") = 'object' and octet_length("offline_grant_activation_preparations"."confirm_response"::text) <= 262144)) and ("offline_grant_activation_preparations"."cancel_response" is null or (jsonb_typeof("offline_grant_activation_preparations"."cancel_response") = 'object' and octet_length("offline_grant_activation_preparations"."cancel_response"::text) <= 262144)) and length(btrim("offline_grant_activation_preparations"."decision_reference")) between 1 and 1000 and ("offline_grant_activation_preparations"."cancellation_reason" is null or length(btrim("offline_grant_activation_preparations"."cancellation_reason")) between 1 and 1000))
);
--> statement-breakpoint
CREATE TABLE "offline_grant_device_activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preparation_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"subscription_id" uuid NOT NULL,
	"owner_kind" text NOT NULL,
	"station_device_id" uuid,
	"kiosk_id" uuid,
	"credential_epoch" integer NOT NULL,
	"base_policy_id" uuid NOT NULL,
	"rollout_policy_id" uuid NOT NULL,
	"activated_by_platform_user_id" text NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "offline_grant_device_activations_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "offline_grant_device_activations_owner_check" CHECK (("offline_grant_device_activations"."owner_kind" in ('station','handheld') and "offline_grant_device_activations"."station_device_id" is not null and "offline_grant_device_activations"."kiosk_id" is null) or ("offline_grant_device_activations"."owner_kind" = 'kiosk' and "offline_grant_device_activations"."kiosk_id" is not null and "offline_grant_device_activations"."station_device_id" is null)),
	CONSTRAINT "offline_grant_device_activations_state_check" CHECK ("offline_grant_device_activations"."credential_epoch" > 0 and "offline_grant_device_activations"."rollout_policy_id" <> "offline_grant_device_activations"."base_policy_id" and isfinite("offline_grant_device_activations"."activated_at") and ("offline_grant_device_activations"."revoked_at" is null or (isfinite("offline_grant_device_activations"."revoked_at") and "offline_grant_device_activations"."revoked_at" >= "offline_grant_device_activations"."activated_at")))
);
--> statement-breakpoint
ALTER TABLE "device_grant_configurations" ADD COLUMN "activation_id" uuid;--> statement-breakpoint
ALTER TABLE "offline_grant_activation_members" ADD CONSTRAINT "offline_grant_activation_members_preparation_fk" FOREIGN KEY ("preparation_id") REFERENCES "public"."offline_grant_activation_preparations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_activation_members" ADD CONSTRAINT "offline_grant_activation_members_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_activation_members" ADD CONSTRAINT "offline_grant_activation_members_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."tenant_subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_activation_members" ADD CONSTRAINT "offline_grant_activation_members_station_fk" FOREIGN KEY ("tenant_id","station_device_id","owner_kind") REFERENCES "public"."station_devices"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_activation_members" ADD CONSTRAINT "offline_grant_activation_members_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_activation_members" ADD CONSTRAINT "offline_grant_activation_members_assignment_fk" FOREIGN KEY ("tenant_id","assignment_id") REFERENCES "public"."working_device_assignments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_activation_preparations" ADD CONSTRAINT "offline_grant_activation_base_policy_fk" FOREIGN KEY ("base_policy_id") REFERENCES "public"."entitlement_lifecycle_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_activation_preparations" ADD CONSTRAINT "offline_grant_activation_rollout_policy_fk" FOREIGN KEY ("rollout_policy_id") REFERENCES "public"."entitlement_lifecycle_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_activation_preparations" ADD CONSTRAINT "offline_grant_activation_prepared_by_fk" FOREIGN KEY ("prepared_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_activation_preparations" ADD CONSTRAINT "offline_grant_activation_confirmed_by_fk" FOREIGN KEY ("confirmed_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_activation_preparations" ADD CONSTRAINT "offline_grant_activation_cancelled_by_fk" FOREIGN KEY ("cancelled_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD CONSTRAINT "offline_grant_device_activations_preparation_fk" FOREIGN KEY ("preparation_id") REFERENCES "public"."offline_grant_activation_preparations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD CONSTRAINT "offline_grant_device_activations_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD CONSTRAINT "offline_grant_device_activations_base_policy_fk" FOREIGN KEY ("base_policy_id") REFERENCES "public"."entitlement_lifecycle_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD CONSTRAINT "offline_grant_device_activations_rollout_policy_fk" FOREIGN KEY ("rollout_policy_id") REFERENCES "public"."entitlement_lifecycle_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD CONSTRAINT "offline_grant_device_activations_activated_by_fk" FOREIGN KEY ("activated_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD CONSTRAINT "offline_grant_device_activations_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."tenant_subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD CONSTRAINT "offline_grant_device_activations_station_fk" FOREIGN KEY ("tenant_id","station_device_id","owner_kind") REFERENCES "public"."station_devices"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD CONSTRAINT "offline_grant_device_activations_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offline_grant_activation_members_station_prepared_uq" ON "offline_grant_activation_members" USING btree ("tenant_id","owner_kind","station_device_id") WHERE "offline_grant_activation_members"."station_device_id" is not null and "offline_grant_activation_members"."reservation_state" = 'prepared';--> statement-breakpoint
CREATE UNIQUE INDEX "offline_grant_activation_members_kiosk_prepared_uq" ON "offline_grant_activation_members" USING btree ("tenant_id","kiosk_id") WHERE "offline_grant_activation_members"."kiosk_id" is not null and "offline_grant_activation_members"."reservation_state" = 'prepared';--> statement-breakpoint
CREATE INDEX "offline_grant_device_activations_preparation_idx" ON "offline_grant_device_activations" USING btree ("preparation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offline_grant_device_activations_station_active_uq" ON "offline_grant_device_activations" USING btree ("tenant_id","owner_kind","station_device_id") WHERE "offline_grant_device_activations"."station_device_id" is not null and "offline_grant_device_activations"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "offline_grant_device_activations_kiosk_active_uq" ON "offline_grant_device_activations" USING btree ("tenant_id","kiosk_id") WHERE "offline_grant_device_activations"."kiosk_id" is not null and "offline_grant_device_activations"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "device_grant_configurations" ADD CONSTRAINT "device_grant_configurations_activation_fk" FOREIGN KEY ("tenant_id","activation_id") REFERENCES "public"."offline_grant_device_activations"("tenant_id","id") ON DELETE no action ON UPDATE no action;