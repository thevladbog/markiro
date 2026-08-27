ALTER TABLE "inventory_late_events" ADD COLUMN "replay_authorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inventory_late_events" ADD COLUMN "replay_authorized_by_user_id" text;--> statement-breakpoint
ALTER TABLE "inventory_late_events" ADD COLUMN "replay_authorized_revision" integer;--> statement-breakpoint
ALTER TABLE "inventory_late_events" ADD CONSTRAINT "inventory_late_events_replay_authorized_by_user_fk" FOREIGN KEY ("replay_authorized_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_late_events" ADD CONSTRAINT "inventory_late_events_replay_authorization_check" CHECK (("inventory_late_events"."replay_authorized_at" is null
          and "inventory_late_events"."replay_authorized_by_user_id" is null
          and "inventory_late_events"."replay_authorized_revision" is null)
        or ("inventory_late_events"."replay_authorized_at" is not null
          and "inventory_late_events"."replay_authorized_by_user_id" is not null
          and "inventory_late_events"."replay_authorized_revision" > "inventory_late_events"."closed_revision"));