ALTER TABLE "plan_entitlements" DROP CONSTRAINT "plan_entitlements_max_lines_positive";--> statement-breakpoint
ALTER TABLE "plan_entitlements" DROP CONSTRAINT "plan_entitlements_max_stations_positive";--> statement-breakpoint
ALTER TABLE "plan_entitlements" DROP CONSTRAINT "plan_entitlements_max_kiosks_positive";--> statement-breakpoint
ALTER TABLE "plan_entitlements" DROP CONSTRAINT "plan_entitlements_max_cabinet_users_positive";--> statement-breakpoint
ALTER TABLE "catalog_item_versions" ADD COLUMN "document_name_ru" text;--> statement-breakpoint
ALTER TABLE "catalog_item_versions" ADD COLUMN "document_name_en" text;--> statement-breakpoint
ALTER TABLE "catalog_item_versions" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "catalog_item_versions" ADD COLUMN "seller_policy_revision" integer;--> statement-breakpoint
ALTER TABLE "commercial_offer_lines" ADD COLUMN "commercial_terms" jsonb;--> statement-breakpoint
ALTER TABLE "subscription_addons" ADD COLUMN "commercial_period" jsonb;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN "commercial_period" jsonb;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "commercial_terms" jsonb;--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD COLUMN "tax_policy" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_item_versions" ADD CONSTRAINT "catalog_item_versions_commercial_metadata_check" CHECK (("catalog_item_versions"."document_name_ru" is null or length(btrim("catalog_item_versions"."document_name_ru")) between 1 and 300) and ("catalog_item_versions"."document_name_en" is null or length(btrim("catalog_item_versions"."document_name_en")) between 1 and 300) and ("catalog_item_versions"."seller_policy_revision" is null or "catalog_item_versions"."seller_policy_revision" > 0) and ("catalog_item_versions"."subject" is null or ("catalog_item_versions"."kind" in ('plan','addon') and "catalog_item_versions"."subject" = 'software_license') or ("catalog_item_versions"."kind" = 'service' and "catalog_item_versions"."subject" in ('service','development_work'))));--> statement-breakpoint
ALTER TABLE "commercial_offer_lines" ADD CONSTRAINT "commercial_offer_lines_commercial_terms_check" CHECK ("commercial_offer_lines"."commercial_terms" is null or coalesce((
    jsonb_typeof("commercial_offer_lines"."commercial_terms") = 'object'
    and "commercial_offer_lines"."commercial_terms" ?& array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule']
    and "commercial_offer_lines"."commercial_terms" - array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule'] = '{}'::jsonb
    and "commercial_offer_lines"."commercial_terms"->'version' = '1'::jsonb
    and jsonb_typeof("commercial_offer_lines"."commercial_terms"->'documentNameRu') = 'string'
    and length(btrim("commercial_offer_lines"."commercial_terms"->>'documentNameRu')) between 1 and 300
    and ("commercial_offer_lines"."commercial_terms"->'documentNameEn' = 'null'::jsonb or (jsonb_typeof("commercial_offer_lines"."commercial_terms"->'documentNameEn') = 'string' and length(btrim("commercial_offer_lines"."commercial_terms"->>'documentNameEn')) between 1 and 300))
    and case when jsonb_typeof("commercial_offer_lines"."commercial_terms"->'sellerPolicyRevision') = 'number' and ("commercial_offer_lines"."commercial_terms"->>'sellerPolicyRevision') ~ '^[1-9][0-9]{0,9}$' then ("commercial_offer_lines"."commercial_terms"->>'sellerPolicyRevision')::numeric <= 2147483647 else false end
    and (("commercial_offer_lines"."kind"::text in ('plan','addon') and "commercial_offer_lines"."commercial_terms"->>'subject' = 'software_license'
      and "commercial_offer_lines"."commercial_terms"->>'billingPeriod' in ('month','year') and "commercial_offer_lines"."commercial_terms"->>'billingTimezone' = 'Europe/Moscow'
      and "commercial_offer_lines"."commercial_terms"->>'activationRule' in ('on_application','after_current') and ("commercial_offer_lines"."kind" <> 'plan' or "commercial_offer_lines"."quantity" = 1))
      or ("commercial_offer_lines"."kind"::text in ('service','custom') and "commercial_offer_lines"."commercial_terms"->>'subject' in ('service','development_work')
      and "commercial_offer_lines"."commercial_terms"->'billingPeriod' = 'null'::jsonb and "commercial_offer_lines"."commercial_terms"->'billingTimezone' = 'null'::jsonb and "commercial_offer_lines"."commercial_terms"->'activationRule' = 'null'::jsonb))
  ), false));--> statement-breakpoint
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_max_lines_positive" CHECK ("plan_entitlements"."max_lines" is null or "plan_entitlements"."max_lines" >= 0);--> statement-breakpoint
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_max_stations_positive" CHECK ("plan_entitlements"."max_stations" is null or "plan_entitlements"."max_stations" >= 0);--> statement-breakpoint
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_max_kiosks_positive" CHECK ("plan_entitlements"."max_kiosks" is null or "plan_entitlements"."max_kiosks" >= 0);--> statement-breakpoint
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_max_cabinet_users_positive" CHECK ("plan_entitlements"."max_cabinet_users" is null or "plan_entitlements"."max_cabinet_users" >= 0);--> statement-breakpoint
ALTER TABLE "subscription_addons" ADD CONSTRAINT "subscription_addons_commercial_period_check" CHECK ("subscription_addons"."commercial_period" is null or coalesce((
    jsonb_typeof("subscription_addons"."commercial_period") = 'object'
    and "subscription_addons"."commercial_period" ?& array['billingPeriod','billingTimezone','calendarPolicyVersion','anchorAt','cycle','startsAt','endsAt']
    and "subscription_addons"."commercial_period" - array['billingPeriod','billingTimezone','calendarPolicyVersion','anchorAt','cycle','startsAt','endsAt'] = '{}'::jsonb
    and "subscription_addons"."commercial_period"->>'billingPeriod' in ('month','year') and "subscription_addons"."commercial_period"->>'billingTimezone' = 'Europe/Moscow'
    and "subscription_addons"."commercial_period"->'calendarPolicyVersion' = '1'::jsonb
    and jsonb_typeof("subscription_addons"."commercial_period"->'cycle') = 'number' and ("subscription_addons"."commercial_period"->>'cycle') ~ '^(0|[1-9][0-9]{0,15})$'
    and jsonb_typeof("subscription_addons"."commercial_period"->'anchorAt') = 'string' and ("subscription_addons"."commercial_period"->>'anchorAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    and jsonb_typeof("subscription_addons"."commercial_period"->'startsAt') = 'string' and ("subscription_addons"."commercial_period"->>'startsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    and jsonb_typeof("subscription_addons"."commercial_period"->'endsAt') = 'string' and ("subscription_addons"."commercial_period"->>'endsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  ), false));--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_commercial_period_check" CHECK ("tenant_subscriptions"."commercial_period" is null or coalesce((
    jsonb_typeof("tenant_subscriptions"."commercial_period") = 'object'
    and "tenant_subscriptions"."commercial_period" ?& array['billingPeriod','billingTimezone','calendarPolicyVersion','anchorAt','cycle','startsAt','endsAt']
    and "tenant_subscriptions"."commercial_period" - array['billingPeriod','billingTimezone','calendarPolicyVersion','anchorAt','cycle','startsAt','endsAt'] = '{}'::jsonb
    and "tenant_subscriptions"."commercial_period"->>'billingPeriod' in ('month','year') and "tenant_subscriptions"."commercial_period"->>'billingTimezone' = 'Europe/Moscow'
    and "tenant_subscriptions"."commercial_period"->'calendarPolicyVersion' = '1'::jsonb
    and jsonb_typeof("tenant_subscriptions"."commercial_period"->'cycle') = 'number' and ("tenant_subscriptions"."commercial_period"->>'cycle') ~ '^(0|[1-9][0-9]{0,15})$'
    and jsonb_typeof("tenant_subscriptions"."commercial_period"->'anchorAt') = 'string' and ("tenant_subscriptions"."commercial_period"->>'anchorAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    and jsonb_typeof("tenant_subscriptions"."commercial_period"->'startsAt') = 'string' and ("tenant_subscriptions"."commercial_period"->>'startsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    and jsonb_typeof("tenant_subscriptions"."commercial_period"->'endsAt') = 'string' and ("tenant_subscriptions"."commercial_period"->>'endsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  ), false));--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_commercial_terms_check" CHECK ("invoice_lines"."commercial_terms" is null or coalesce((
    jsonb_typeof("invoice_lines"."commercial_terms") = 'object'
    and "invoice_lines"."commercial_terms" ?& array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule']
    and "invoice_lines"."commercial_terms" - array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule'] = '{}'::jsonb
    and "invoice_lines"."commercial_terms"->'version' = '1'::jsonb
    and jsonb_typeof("invoice_lines"."commercial_terms"->'documentNameRu') = 'string'
    and length(btrim("invoice_lines"."commercial_terms"->>'documentNameRu')) between 1 and 300
    and ("invoice_lines"."commercial_terms"->'documentNameEn' = 'null'::jsonb or (jsonb_typeof("invoice_lines"."commercial_terms"->'documentNameEn') = 'string' and length(btrim("invoice_lines"."commercial_terms"->>'documentNameEn')) between 1 and 300))
    and case when jsonb_typeof("invoice_lines"."commercial_terms"->'sellerPolicyRevision') = 'number' and ("invoice_lines"."commercial_terms"->>'sellerPolicyRevision') ~ '^[1-9][0-9]{0,9}$' then ("invoice_lines"."commercial_terms"->>'sellerPolicyRevision')::numeric <= 2147483647 else false end
    and (("invoice_lines"."kind"::text in ('plan','addon') and "invoice_lines"."commercial_terms"->>'subject' = 'software_license'
      and "invoice_lines"."commercial_terms"->>'billingPeriod' in ('month','year') and "invoice_lines"."commercial_terms"->>'billingTimezone' = 'Europe/Moscow'
      and "invoice_lines"."commercial_terms"->>'activationRule' in ('on_application','after_current') and ("invoice_lines"."kind" <> 'plan' or "invoice_lines"."quantity" = 1))
      or ("invoice_lines"."kind"::text in ('service','custom') and "invoice_lines"."commercial_terms"->>'subject' in ('service','development_work')
      and "invoice_lines"."commercial_terms"->'billingPeriod' = 'null'::jsonb and "invoice_lines"."commercial_terms"->'billingTimezone' = 'null'::jsonb and "invoice_lines"."commercial_terms"->'activationRule' = 'null'::jsonb))
  ), false));--> statement-breakpoint
ALTER TABLE "operator_billing_profiles" ADD CONSTRAINT "operator_billing_profiles_tax_policy_check" CHECK ("operator_billing_profiles"."tax_policy" is null or coalesce((jsonb_typeof("operator_billing_profiles"."tax_policy") = 'object' and (
    ("operator_billing_profiles"."tax_policy"->>'kind' = 'without_vat' and "operator_billing_profiles"."tax_policy"->>'regime' in ('npd','other') and "operator_billing_profiles"."tax_policy" - array['kind','regime'] = '{}'::jsonb)
    or ("operator_billing_profiles"."tax_policy"->>'kind' = 'vat' and "operator_billing_profiles"."tax_policy"->>'regime' = 'other'
      and "operator_billing_profiles"."tax_policy" ?& array['allowedRatesBps','defaultRateBps','defaultIncluded']
      and "operator_billing_profiles"."tax_policy" - array['kind','regime','allowedRatesBps','defaultRateBps','defaultIncluded'] = '{}'::jsonb
      and jsonb_typeof("operator_billing_profiles"."tax_policy"->'defaultIncluded') = 'boolean'
      and jsonb_typeof("operator_billing_profiles"."tax_policy"->'defaultRateBps') = 'number'
      and jsonb_typeof("operator_billing_profiles"."tax_policy"->'allowedRatesBps') = 'array'
      and jsonb_path_exists("operator_billing_profiles"."tax_policy", '$.allowedRatesBps[*]')
      and not jsonb_path_exists("operator_billing_profiles"."tax_policy", '$.allowedRatesBps[*] ? (@.type() != "number" || @ < 0 || @ > 10000 || @ != @.floor())')
      and ("operator_billing_profiles"."tax_policy"->'allowedRatesBps') @> jsonb_build_array("operator_billing_profiles"."tax_policy"->'defaultRateBps')
    )
  )), false));