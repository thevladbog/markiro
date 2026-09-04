-- A rejected cises/info batch was backed off for thirty days while Markiro
-- still sent the scanner's crypto tail. The request now uses the tail-less
-- CIS identity, so make every beer row eligible for one fresh pass instead
-- of leaving the already-affected rows stale until October.
UPDATE "chz_code_statuses"
SET "next_refresh_at" = now()
WHERE "chz_product_group_code" = 15
	AND "next_refresh_at" > now();
