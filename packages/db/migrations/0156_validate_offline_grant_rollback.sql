ALTER TABLE "offline_grant_device_activations" VALIDATE CONSTRAINT "offline_grant_device_activations_rollback_preparation_fk";--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" VALIDATE CONSTRAINT "offline_grant_device_activations_observe_policy_fk";--> statement-breakpoint
ALTER TABLE "offline_grant_device_activations" VALIDATE CONSTRAINT "offline_grant_device_activations_rolled_back_by_fk";
