ALTER TABLE "user_profiles" DROP CONSTRAINT "user_profiles_avatar_asset_id_media_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "avatar_asset_owner_user_id" text;--> statement-breakpoint
UPDATE "user_profiles" AS "profile"
SET "avatar_asset_owner_user_id" = "asset"."owner_user_id"
FROM "media_assets" AS "asset"
WHERE "asset"."id" = "profile"."avatar_asset_id";--> statement-breakpoint
UPDATE "user_profiles"
SET "avatar_asset_id" = NULL,
    "avatar_asset_owner_user_id" = NULL
WHERE "avatar_asset_id" IS NOT NULL
  AND "avatar_asset_owner_user_id" IS DISTINCT FROM "user_id";--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_uq" UNIQUE("owner_user_id","id");--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_avatar_owner_fk" FOREIGN KEY ("avatar_asset_owner_user_id","avatar_asset_id") REFERENCES "public"."media_assets"("owner_user_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_avatar_owner_matches_user" CHECK (("user_profiles"."avatar_asset_id" is null and "user_profiles"."avatar_asset_owner_user_id" is null) or ("user_profiles"."avatar_asset_id" is not null and "user_profiles"."avatar_asset_owner_user_id" = "user_profiles"."user_id"));
