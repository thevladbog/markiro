-- Validate existing rows after releasing ADD CONSTRAINT locks from 0162.
ALTER TABLE "station_pairing_codes" VALIDATE CONSTRAINT "station_pairing_codes_purpose_check";
--> statement-breakpoint
ALTER TABLE "working_device_assignments" VALIDATE CONSTRAINT "working_device_assignments_release_check";
--> statement-breakpoint
ALTER TABLE "working_device_events" VALIDATE CONSTRAINT "working_device_events_execution_check";
--> statement-breakpoint
ALTER TABLE "working_device_events" VALIDATE CONSTRAINT "working_device_events_action_check";
--> statement-breakpoint
ALTER TABLE "working_device_events" VALIDATE CONSTRAINT "working_device_events_replacement_check";
--> statement-breakpoint
ALTER TABLE "working_device_replacement_preparations" VALIDATE CONSTRAINT "working_device_replacement_preparations_identity_check";
--> statement-breakpoint
ALTER TABLE "working_device_replacement_preparations" VALIDATE CONSTRAINT "working_device_replacement_preparations_cancellation_check";
