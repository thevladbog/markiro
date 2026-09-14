CREATE TABLE "offline_grant_rollback_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preparation_id" uuid NOT NULL,
	"activation_id" uuid NOT NULL,
	"activation_preparation_id" uuid NOT NULL,
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
	"base_policy_id" uuid NOT NULL,
	"strict_policy_id" uuid NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"reservation_state" text DEFAULT 'prepared' NOT NULL,
	CONSTRAINT "offline_grant_rollback_members_preparation_activation_uq" UNIQUE("preparation_id","activation_id"),
	CONSTRAINT "offline_grant_rollback_members_owner_check" CHECK (("offline_grant_rollback_members"."owner_kind" in ('station','handheld') and "offline_grant_rollback_members"."station_device_id" is not null and "offline_grant_rollback_members"."kiosk_id" is null and "offline_grant_rollback_members"."assignment_id" is not null) or ("offline_grant_rollback_members"."owner_kind" = 'kiosk' and "offline_grant_rollback_members"."kiosk_id" is not null and "offline_grant_rollback_members"."station_device_id" is null and "offline_grant_rollback_members"."assignment_id" is null)),
	CONSTRAINT "offline_grant_rollback_members_snapshot_check" CHECK ("offline_grant_rollback_members"."credential_epoch" > 0 and "offline_grant_rollback_members"."base_policy_id" <> "offline_grant_rollback_members"."strict_policy_id" and isfinite("offline_grant_rollback_members"."activated_at") and length(btrim("offline_grant_rollback_members"."tenant_name")) between 1 and 300 and length(btrim("offline_grant_rollback_members"."device_name")) between 1 and 300 and "offline_grant_rollback_members"."reservation_state" in ('prepared','released'))
);
--> statement-breakpoint
CREATE TABLE "offline_grant_rollback_preparations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"base_policy_id" uuid NOT NULL,
	"observe_policy_id" uuid,
	"rollback_digest" text NOT NULL,
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
	CONSTRAINT "offline_grant_rollback_prepare_request_uq" UNIQUE("prepare_request_id"),
	CONSTRAINT "offline_grant_rollback_confirm_request_uq" UNIQUE("confirm_request_id"),
	CONSTRAINT "offline_grant_rollback_cancel_request_uq" UNIQUE("cancel_request_id"),
	CONSTRAINT "offline_grant_rollback_digest_uq" UNIQUE("rollback_digest"),
	CONSTRAINT "offline_grant_rollback_state_check" CHECK ("offline_grant_rollback_preparations"."state" in ('prepared','confirmed','cancelled','needs_review') and
        (("offline_grant_rollback_preparations"."state" = 'prepared' and "offline_grant_rollback_preparations"."observe_policy_id" is null and "offline_grant_rollback_preparations"."confirm_request_id" is null and "offline_grant_rollback_preparations"."confirm_request_hash" is null and "offline_grant_rollback_preparations"."confirm_response" is null and "offline_grant_rollback_preparations"."confirmed_by_platform_user_id" is null and "offline_grant_rollback_preparations"."confirmed_at" is null and "offline_grant_rollback_preparations"."cancel_request_id" is null and "offline_grant_rollback_preparations"."cancel_request_hash" is null and "offline_grant_rollback_preparations"."cancel_response" is null and "offline_grant_rollback_preparations"."cancelled_by_platform_user_id" is null and "offline_grant_rollback_preparations"."cancelled_at" is null and "offline_grant_rollback_preparations"."cancellation_reason" is null)
        or ("offline_grant_rollback_preparations"."state" = 'confirmed' and "offline_grant_rollback_preparations"."observe_policy_id" is not null and "offline_grant_rollback_preparations"."confirm_request_id" is not null and "offline_grant_rollback_preparations"."confirm_request_hash" is not null and "offline_grant_rollback_preparations"."confirm_response" is not null and "offline_grant_rollback_preparations"."confirmed_by_platform_user_id" is not null and "offline_grant_rollback_preparations"."confirmed_at" is not null and "offline_grant_rollback_preparations"."cancel_request_id" is null and "offline_grant_rollback_preparations"."cancel_request_hash" is null and "offline_grant_rollback_preparations"."cancel_response" is null and "offline_grant_rollback_preparations"."cancelled_by_platform_user_id" is null and "offline_grant_rollback_preparations"."cancelled_at" is null and "offline_grant_rollback_preparations"."cancellation_reason" is null)
        or ("offline_grant_rollback_preparations"."state" = 'needs_review' and "offline_grant_rollback_preparations"."observe_policy_id" is null and "offline_grant_rollback_preparations"."confirm_request_id" is not null and "offline_grant_rollback_preparations"."confirm_request_hash" is not null and "offline_grant_rollback_preparations"."confirm_response" is not null and "offline_grant_rollback_preparations"."confirmed_by_platform_user_id" is not null and "offline_grant_rollback_preparations"."confirmed_at" is not null and "offline_grant_rollback_preparations"."cancel_request_id" is null and "offline_grant_rollback_preparations"."cancel_request_hash" is null and "offline_grant_rollback_preparations"."cancel_response" is null and "offline_grant_rollback_preparations"."cancelled_by_platform_user_id" is null and "offline_grant_rollback_preparations"."cancelled_at" is null and "offline_grant_rollback_preparations"."cancellation_reason" is null)
        or ("offline_grant_rollback_preparations"."state" = 'cancelled' and "offline_grant_rollback_preparations"."observe_policy_id" is null and (("offline_grant_rollback_preparations"."confirm_request_id" is null and "offline_grant_rollback_preparations"."confirm_request_hash" is null and "offline_grant_rollback_preparations"."confirm_response" is null and "offline_grant_rollback_preparations"."confirmed_by_platform_user_id" is null and "offline_grant_rollback_preparations"."confirmed_at" is null) or ("offline_grant_rollback_preparations"."confirm_request_id" is not null and "offline_grant_rollback_preparations"."confirm_request_hash" is not null and "offline_grant_rollback_preparations"."confirm_response" is not null and "offline_grant_rollback_preparations"."confirmed_by_platform_user_id" is not null and "offline_grant_rollback_preparations"."confirmed_at" is not null)) and "offline_grant_rollback_preparations"."cancel_request_id" is not null and "offline_grant_rollback_preparations"."cancel_request_hash" is not null and "offline_grant_rollback_preparations"."cancel_response" is not null and "offline_grant_rollback_preparations"."cancelled_by_platform_user_id" is not null and "offline_grant_rollback_preparations"."cancelled_at" is not null and "offline_grant_rollback_preparations"."cancellation_reason" is not null))),
	CONSTRAINT "offline_grant_rollback_interval_check" CHECK (isfinite("offline_grant_rollback_preparations"."prepared_at") and isfinite("offline_grant_rollback_preparations"."expires_at") and "offline_grant_rollback_preparations"."expires_at" = "offline_grant_rollback_preparations"."prepared_at" + interval '30 minutes' and ("offline_grant_rollback_preparations"."confirmed_at" is null or (isfinite("offline_grant_rollback_preparations"."confirmed_at") and "offline_grant_rollback_preparations"."confirmed_at" >= "offline_grant_rollback_preparations"."prepared_at" and "offline_grant_rollback_preparations"."confirmed_at" < "offline_grant_rollback_preparations"."expires_at")) and ("offline_grant_rollback_preparations"."cancelled_at" is null or (isfinite("offline_grant_rollback_preparations"."cancelled_at") and "offline_grant_rollback_preparations"."cancelled_at" >= "offline_grant_rollback_preparations"."prepared_at"))),
	CONSTRAINT "offline_grant_rollback_confirm_actor_check" CHECK ("offline_grant_rollback_preparations"."confirmed_by_platform_user_id" is null or "offline_grant_rollback_preparations"."confirmed_by_platform_user_id" <> "offline_grant_rollback_preparations"."prepared_by_platform_user_id"),
	CONSTRAINT "offline_grant_rollback_payload_check" CHECK ("offline_grant_rollback_preparations"."rollback_digest" ~ '^[0-9a-f]{64}$' and "offline_grant_rollback_preparations"."prepare_request_hash" ~ '^[0-9a-f]{64}$' and ("offline_grant_rollback_preparations"."confirm_request_hash" is null or "offline_grant_rollback_preparations"."confirm_request_hash" ~ '^[0-9a-f]{64}$') and ("offline_grant_rollback_preparations"."cancel_request_hash" is null or "offline_grant_rollback_preparations"."cancel_request_hash" ~ '^[0-9a-f]{64}$') and jsonb_typeof("offline_grant_rollback_preparations"."prepare_response") = 'object' and jsonb_typeof("offline_grant_rollback_preparations"."snapshot") = 'object' and octet_length("offline_grant_rollback_preparations"."prepare_response"::text) <= 262144 and octet_length("offline_grant_rollback_preparations"."snapshot"::text) <= 262144 and ("offline_grant_rollback_preparations"."confirm_response" is null or (jsonb_typeof("offline_grant_rollback_preparations"."confirm_response") = 'object' and octet_length("offline_grant_rollback_preparations"."confirm_response"::text) <= 262144)) and ("offline_grant_rollback_preparations"."cancel_response" is null or (jsonb_typeof("offline_grant_rollback_preparations"."cancel_response") = 'object' and octet_length("offline_grant_rollback_preparations"."cancel_response"::text) <= 262144)) and length(btrim("offline_grant_rollback_preparations"."decision_reference")) between 1 and 1000 and ("offline_grant_rollback_preparations"."cancellation_reason" is null or length(btrim("offline_grant_rollback_preparations"."cancellation_reason")) between 1 and 1000))
);
--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD COLUMN "rollback_preparation_id" uuid;--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD COLUMN "observe_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD COLUMN "rolled_back_by_platform_user_id" text;--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD COLUMN "rolled_back_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offline_grant_rollback_members" ADD CONSTRAINT "offline_grant_rollback_members_preparation_fk" FOREIGN KEY ("preparation_id") REFERENCES "public"."offline_grant_rollback_preparations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_rollback_members" ADD CONSTRAINT "offline_grant_rollback_members_activation_fk" FOREIGN KEY ("tenant_id","activation_id") REFERENCES "public"."offline_grant_device_activations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_rollback_members" ADD CONSTRAINT "offline_grant_rollback_members_activation_preparation_fk" FOREIGN KEY ("activation_preparation_id") REFERENCES "public"."offline_grant_activation_preparations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_rollback_members" ADD CONSTRAINT "offline_grant_rollback_members_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."tenant_subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_rollback_members" ADD CONSTRAINT "offline_grant_rollback_members_station_fk" FOREIGN KEY ("tenant_id","station_device_id","owner_kind") REFERENCES "public"."station_devices"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_rollback_members" ADD CONSTRAINT "offline_grant_rollback_members_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_rollback_members" ADD CONSTRAINT "offline_grant_rollback_members_assignment_fk" FOREIGN KEY ("tenant_id","assignment_id") REFERENCES "public"."working_device_assignments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_rollback_members" ADD CONSTRAINT "offline_grant_rollback_members_base_policy_fk" FOREIGN KEY ("base_policy_id") REFERENCES "public"."entitlement_lifecycle_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_rollback_members" ADD CONSTRAINT "offline_grant_rollback_members_strict_policy_fk" FOREIGN KEY ("strict_policy_id") REFERENCES "public"."entitlement_lifecycle_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_rollback_preparations" ADD CONSTRAINT "offline_grant_rollback_base_policy_fk" FOREIGN KEY ("base_policy_id") REFERENCES "public"."entitlement_lifecycle_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_rollback_preparations" ADD CONSTRAINT "offline_grant_rollback_observe_policy_fk" FOREIGN KEY ("observe_policy_id") REFERENCES "public"."entitlement_lifecycle_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_rollback_preparations" ADD CONSTRAINT "offline_grant_rollback_prepared_by_fk" FOREIGN KEY ("prepared_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_rollback_preparations" ADD CONSTRAINT "offline_grant_rollback_confirmed_by_fk" FOREIGN KEY ("confirmed_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grant_rollback_preparations" ADD CONSTRAINT "offline_grant_rollback_cancelled_by_fk" FOREIGN KEY ("cancelled_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offline_grant_rollback_members_active_reservation_uq" ON "offline_grant_rollback_members" USING btree ("activation_id") WHERE "offline_grant_rollback_members"."reservation_state" = 'prepared';--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD CONSTRAINT "offline_grant_device_activations_rollback_preparation_fk" FOREIGN KEY ("rollback_preparation_id") REFERENCES "public"."offline_grant_rollback_preparations"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD CONSTRAINT "offline_grant_device_activations_observe_policy_fk" FOREIGN KEY ("observe_policy_id") REFERENCES "public"."entitlement_lifecycle_policies"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD CONSTRAINT "offline_grant_device_activations_rolled_back_by_fk" FOREIGN KEY ("rolled_back_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" ADD CONSTRAINT "offline_grant_device_activations_rollback_check" CHECK ((("offline_grant_device_activations"."rollback_preparation_id" is null and "offline_grant_device_activations"."observe_policy_id" is null and "offline_grant_device_activations"."rolled_back_by_platform_user_id" is null and "offline_grant_device_activations"."rolled_back_at" is null) or ("offline_grant_device_activations"."rollback_preparation_id" is not null and "offline_grant_device_activations"."observe_policy_id" is not null and "offline_grant_device_activations"."rolled_back_by_platform_user_id" is not null and "offline_grant_device_activations"."rolled_back_at" is not null and "offline_grant_device_activations"."revoked_at" = "offline_grant_device_activations"."rolled_back_at" and "offline_grant_device_activations"."rolled_back_at" >= "offline_grant_device_activations"."activated_at" and "offline_grant_device_activations"."observe_policy_id" <> "offline_grant_device_activations"."rollout_policy_id" and "offline_grant_device_activations"."observe_policy_id" <> "offline_grant_device_activations"."base_policy_id")));
