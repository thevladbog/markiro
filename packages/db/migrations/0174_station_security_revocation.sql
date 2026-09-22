ALTER TABLE "station_devices" ADD COLUMN "security_revocation_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "station_devices" ADD CONSTRAINT "station_devices_security_revocation_check" CHECK ("station_devices"."security_revocation_revision" >= 0);--> statement-breakpoint
-- A security action may retire recovery codes after replacement already set revoked_at.
-- Keep the historical timestamp; only this monotone input advances the server-owned epoch.
CREATE OR REPLACE FUNCTION station_credential_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credential_epoch IS DISTINCT FROM OLD.credential_epoch THEN
    RAISE EXCEPTION 'Credential epoch is server managed' USING ERRCODE = '23514';
  END IF;
  IF NEW.security_revocation_revision IS DISTINCT FROM OLD.security_revocation_revision AND
     (NEW.security_revocation_revision::bigint <> OLD.security_revocation_revision::bigint + 1 OR
      NEW.revoked_at IS NULL OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) OR NEW.api_key_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid security revocation revision' USING ERRCODE = '23514';
  END IF;
  IF NEW.api_key_id IS DISTINCT FROM OLD.api_key_id OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR
     NEW.security_revocation_revision IS DISTINCT FROM OLD.security_revocation_revision THEN
    IF OLD.credential_epoch = 2147483647 THEN
      RAISE EXCEPTION 'Credential epoch exhausted' USING ERRCODE = '23514';
    END IF;
    NEW.credential_epoch := OLD.credential_epoch + 1;
  END IF;
  RETURN NEW;
END;
$$;
