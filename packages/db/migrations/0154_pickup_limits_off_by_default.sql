-- The daily pickup allowance becomes opt-in. The cabinet switch
-- (`pickupLimitsEnabled` on the org profile) is unchanged, and NO limit
-- configuration is deleted: per-employee `limit_mode` and `day_limit` rows stay
-- exactly as they are, so a tenant that wants the allowance back only has to
-- flip the switch and gets its old behaviour intact.
ALTER TABLE "pickup_tenant_policies" ALTER COLUMN "limits_enabled" SET DEFAULT false;--> statement-breakpoint
UPDATE "pickup_tenant_policies" SET "limits_enabled" = false, "updated_at" = now() WHERE "limits_enabled" = true;
