-- Runtime migration commits 0135 before scanning existing journal rows.
ALTER TABLE "working_device_events" VALIDATE CONSTRAINT "working_device_events_replacement_check";
--> statement-breakpoint
ALTER TABLE "working_device_events" VALIDATE CONSTRAINT "working_device_events_action_check";
