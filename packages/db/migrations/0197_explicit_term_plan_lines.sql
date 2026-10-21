ALTER TABLE "commercial_offer_lines" DROP CONSTRAINT "commercial_offer_lines_commercial_terms_check";--> statement-breakpoint
ALTER TABLE "subscription_addons" DROP CONSTRAINT "subscription_addons_commercial_period_check";--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" DROP CONSTRAINT "tenant_subscriptions_commercial_period_check";--> statement-breakpoint
ALTER TABLE "invoice_lines" DROP CONSTRAINT "invoice_lines_commercial_terms_check";--> statement-breakpoint
ALTER TABLE "commercial_offer_lines" ADD CONSTRAINT "commercial_offer_lines_commercial_terms_check" CHECK ("commercial_offer_lines"."commercial_terms" is null or coalesce((
    jsonb_typeof("commercial_offer_lines"."commercial_terms") = 'object'
    and "commercial_offer_lines"."commercial_terms" ?& array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule']
    and jsonb_typeof("commercial_offer_lines"."commercial_terms"->'documentNameRu') = 'string'
    and length(btrim("commercial_offer_lines"."commercial_terms"->>'documentNameRu')) between 1 and 300
    and ("commercial_offer_lines"."commercial_terms"->'documentNameEn' = 'null'::jsonb or (jsonb_typeof("commercial_offer_lines"."commercial_terms"->'documentNameEn') = 'string' and length(btrim("commercial_offer_lines"."commercial_terms"->>'documentNameEn')) between 1 and 300))
    and case when jsonb_typeof("commercial_offer_lines"."commercial_terms"->'sellerPolicyRevision') = 'number' and ("commercial_offer_lines"."commercial_terms"->>'sellerPolicyRevision') ~ '^[1-9][0-9]{0,9}$' then ("commercial_offer_lines"."commercial_terms"->>'sellerPolicyRevision')::numeric <= 2147483647 else false end
    and (
      ("commercial_offer_lines"."commercial_terms"->'version' = '1'::jsonb
        and "commercial_offer_lines"."commercial_terms" - array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule'] = '{}'::jsonb
        and (("commercial_offer_lines"."kind"::text in ('plan','addon') and "commercial_offer_lines"."commercial_terms"->>'subject' = 'software_license'
          and "commercial_offer_lines"."commercial_terms"->>'billingPeriod' in ('month','year') and "commercial_offer_lines"."commercial_terms"->>'billingTimezone' = 'Europe/Moscow'
          and "commercial_offer_lines"."commercial_terms"->>'activationRule' in ('on_application','after_current') and ("commercial_offer_lines"."kind" <> 'plan' or "commercial_offer_lines"."quantity" = 1))
          or ("commercial_offer_lines"."kind"::text in ('service','custom') and "commercial_offer_lines"."commercial_terms"->>'subject' in ('service','development_work')
          and "commercial_offer_lines"."commercial_terms"->'billingPeriod' = 'null'::jsonb and "commercial_offer_lines"."commercial_terms"->'billingTimezone' = 'null'::jsonb and "commercial_offer_lines"."commercial_terms"->'activationRule' = 'null'::jsonb)))
      or ("commercial_offer_lines"."commercial_terms"->'version' = '2'::jsonb
        and "commercial_offer_lines"."kind"::text = 'service' and "commercial_offer_lines"."quantity" = 1
        and "commercial_offer_lines"."commercial_terms"->>'subject' in ('service','development_work')
        and "commercial_offer_lines"."commercial_terms"->>'billingPeriod' = 'month'
        and "commercial_offer_lines"."commercial_terms"->>'billingTimezone' = 'Europe/Moscow'
        and "commercial_offer_lines"."commercial_terms"->>'activationRule' = 'after_current'
        and "commercial_offer_lines"."commercial_terms" ? 'serviceTerms'
        and "commercial_offer_lines"."commercial_terms" - array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule','serviceTerms'] = '{}'::jsonb
        and jsonb_typeof(("commercial_offer_lines"."commercial_terms"->'serviceTerms')) = 'object'
    and ("commercial_offer_lines"."commercial_terms"->'serviceTerms') ?& array['cadence','includedMinutes','carryover','excessPolicy','scopeRu','scopeEn','operatingHoursRu','operatingHoursEn','schedulingTermsRu','schedulingTermsEn']
    and ("commercial_offer_lines"."commercial_terms"->'serviceTerms') - array['cadence','includedMinutes','carryover','excessPolicy','scopeRu','scopeEn','operatingHoursRu','operatingHoursEn','schedulingTermsRu','schedulingTermsEn'] = '{}'::jsonb
    and ("commercial_offer_lines"."commercial_terms"->'serviceTerms')->>'cadence' = 'month'
    and case when jsonb_typeof(("commercial_offer_lines"."commercial_terms"->'serviceTerms')->'includedMinutes') = 'number' and (("commercial_offer_lines"."commercial_terms"->'serviceTerms')->>'includedMinutes') ~ '^[1-9][0-9]{0,9}$' then (("commercial_offer_lines"."commercial_terms"->'serviceTerms')->>'includedMinutes')::numeric <= 2147483647 else false end
    and (("commercial_offer_lines"."commercial_terms"->'serviceTerms')->>'includedMinutes')::numeric <= 100000
    and ("commercial_offer_lines"."commercial_terms"->'serviceTerms')->>'carryover' = 'none'
    and ("commercial_offer_lines"."commercial_terms"->'serviceTerms')->>'excessPolicy' = 'external_approval'
    and jsonb_typeof(("commercial_offer_lines"."commercial_terms"->'serviceTerms')->'scopeRu') = 'string' and length(btrim(("commercial_offer_lines"."commercial_terms"->'serviceTerms')->>'scopeRu')) between 1 and 4000
    and (("commercial_offer_lines"."commercial_terms"->'serviceTerms')->'scopeEn' = 'null'::jsonb or (jsonb_typeof(("commercial_offer_lines"."commercial_terms"->'serviceTerms')->'scopeEn') = 'string' and length(btrim(("commercial_offer_lines"."commercial_terms"->'serviceTerms')->>'scopeEn')) between 1 and 4000))
    and (("commercial_offer_lines"."commercial_terms"->'serviceTerms')->'operatingHoursRu' = 'null'::jsonb or (jsonb_typeof(("commercial_offer_lines"."commercial_terms"->'serviceTerms')->'operatingHoursRu') = 'string' and length(btrim(("commercial_offer_lines"."commercial_terms"->'serviceTerms')->>'operatingHoursRu')) between 1 and 1000))
    and (("commercial_offer_lines"."commercial_terms"->'serviceTerms')->'operatingHoursEn' = 'null'::jsonb or (jsonb_typeof(("commercial_offer_lines"."commercial_terms"->'serviceTerms')->'operatingHoursEn') = 'string' and length(btrim(("commercial_offer_lines"."commercial_terms"->'serviceTerms')->>'operatingHoursEn')) between 1 and 1000))
    and (("commercial_offer_lines"."commercial_terms"->'serviceTerms')->'schedulingTermsRu' = 'null'::jsonb or (jsonb_typeof(("commercial_offer_lines"."commercial_terms"->'serviceTerms')->'schedulingTermsRu') = 'string' and length(btrim(("commercial_offer_lines"."commercial_terms"->'serviceTerms')->>'schedulingTermsRu')) between 1 and 1000))
    and (("commercial_offer_lines"."commercial_terms"->'serviceTerms')->'schedulingTermsEn' = 'null'::jsonb or (jsonb_typeof(("commercial_offer_lines"."commercial_terms"->'serviceTerms')->'schedulingTermsEn') = 'string' and length(btrim(("commercial_offer_lines"."commercial_terms"->'serviceTerms')->>'schedulingTermsEn')) between 1 and 1000)))
      or ("commercial_offer_lines"."commercial_terms"->'version' = '3'::jsonb
        and "commercial_offer_lines"."kind"::text = 'plan' and "commercial_offer_lines"."quantity" = 1
        and "commercial_offer_lines"."commercial_terms"->>'subject' = 'software_license'
        and "commercial_offer_lines"."commercial_terms"->>'billingPeriod' = 'custom'
        and "commercial_offer_lines"."commercial_terms"->>'billingTimezone' = 'Europe/Moscow'
        and "commercial_offer_lines"."commercial_terms"->>'activationRule' in ('on_application','after_current')
        and "commercial_offer_lines"."commercial_terms" ?& array['termStart','termEnd']
        and "commercial_offer_lines"."commercial_terms" - array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule','termStart','termEnd'] = '{}'::jsonb
        and (jsonb_typeof("commercial_offer_lines"."commercial_terms"->'termStart') = 'string'
    and "commercial_offer_lines"."commercial_terms"->>'termStart' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')
        and (jsonb_typeof("commercial_offer_lines"."commercial_terms"->'termEnd') = 'string'
    and "commercial_offer_lines"."commercial_terms"->>'termEnd' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')
        and "commercial_offer_lines"."commercial_terms"->>'termStart' <= "commercial_offer_lines"."commercial_terms"->>'termEnd')
    )
  ), false));--> statement-breakpoint
ALTER TABLE "subscription_addons" ADD CONSTRAINT "subscription_addons_commercial_period_check" CHECK ("subscription_addons"."commercial_period" is null or coalesce((
    jsonb_typeof("subscription_addons"."commercial_period") = 'object'
    and "subscription_addons"."commercial_period" ?& array['billingPeriod','billingTimezone','calendarPolicyVersion','anchorAt','cycle','startsAt','endsAt']
    and "subscription_addons"."commercial_period" - array['billingPeriod','billingTimezone','calendarPolicyVersion','anchorAt','cycle','startsAt','endsAt'] = '{}'::jsonb
    and "subscription_addons"."commercial_period"->>'billingPeriod' in ('month','year','custom') and "subscription_addons"."commercial_period"->>'billingTimezone' = 'Europe/Moscow'
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
    and "tenant_subscriptions"."commercial_period"->>'billingPeriod' in ('month','year','custom') and "tenant_subscriptions"."commercial_period"->>'billingTimezone' = 'Europe/Moscow'
    and "tenant_subscriptions"."commercial_period"->'calendarPolicyVersion' = '1'::jsonb
    and jsonb_typeof("tenant_subscriptions"."commercial_period"->'cycle') = 'number' and ("tenant_subscriptions"."commercial_period"->>'cycle') ~ '^(0|[1-9][0-9]{0,15})$'
    and jsonb_typeof("tenant_subscriptions"."commercial_period"->'anchorAt') = 'string' and ("tenant_subscriptions"."commercial_period"->>'anchorAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    and jsonb_typeof("tenant_subscriptions"."commercial_period"->'startsAt') = 'string' and ("tenant_subscriptions"."commercial_period"->>'startsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    and jsonb_typeof("tenant_subscriptions"."commercial_period"->'endsAt') = 'string' and ("tenant_subscriptions"."commercial_period"->>'endsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  ), false));--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_commercial_terms_check" CHECK ("invoice_lines"."commercial_terms" is null or coalesce((
    jsonb_typeof("invoice_lines"."commercial_terms") = 'object'
    and "invoice_lines"."commercial_terms" ?& array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule']
    and jsonb_typeof("invoice_lines"."commercial_terms"->'documentNameRu') = 'string'
    and length(btrim("invoice_lines"."commercial_terms"->>'documentNameRu')) between 1 and 300
    and ("invoice_lines"."commercial_terms"->'documentNameEn' = 'null'::jsonb or (jsonb_typeof("invoice_lines"."commercial_terms"->'documentNameEn') = 'string' and length(btrim("invoice_lines"."commercial_terms"->>'documentNameEn')) between 1 and 300))
    and case when jsonb_typeof("invoice_lines"."commercial_terms"->'sellerPolicyRevision') = 'number' and ("invoice_lines"."commercial_terms"->>'sellerPolicyRevision') ~ '^[1-9][0-9]{0,9}$' then ("invoice_lines"."commercial_terms"->>'sellerPolicyRevision')::numeric <= 2147483647 else false end
    and (
      ("invoice_lines"."commercial_terms"->'version' = '1'::jsonb
        and "invoice_lines"."commercial_terms" - array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule'] = '{}'::jsonb
        and (("invoice_lines"."kind"::text in ('plan','addon') and "invoice_lines"."commercial_terms"->>'subject' = 'software_license'
          and "invoice_lines"."commercial_terms"->>'billingPeriod' in ('month','year') and "invoice_lines"."commercial_terms"->>'billingTimezone' = 'Europe/Moscow'
          and "invoice_lines"."commercial_terms"->>'activationRule' in ('on_application','after_current') and ("invoice_lines"."kind" <> 'plan' or "invoice_lines"."quantity" = 1))
          or ("invoice_lines"."kind"::text in ('service','custom') and "invoice_lines"."commercial_terms"->>'subject' in ('service','development_work')
          and "invoice_lines"."commercial_terms"->'billingPeriod' = 'null'::jsonb and "invoice_lines"."commercial_terms"->'billingTimezone' = 'null'::jsonb and "invoice_lines"."commercial_terms"->'activationRule' = 'null'::jsonb)))
      or ("invoice_lines"."commercial_terms"->'version' = '2'::jsonb
        and "invoice_lines"."kind"::text = 'service' and "invoice_lines"."quantity" = 1
        and "invoice_lines"."commercial_terms"->>'subject' in ('service','development_work')
        and "invoice_lines"."commercial_terms"->>'billingPeriod' = 'month'
        and "invoice_lines"."commercial_terms"->>'billingTimezone' = 'Europe/Moscow'
        and "invoice_lines"."commercial_terms"->>'activationRule' = 'after_current'
        and "invoice_lines"."commercial_terms" ? 'serviceTerms'
        and "invoice_lines"."commercial_terms" - array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule','serviceTerms'] = '{}'::jsonb
        and jsonb_typeof(("invoice_lines"."commercial_terms"->'serviceTerms')) = 'object'
    and ("invoice_lines"."commercial_terms"->'serviceTerms') ?& array['cadence','includedMinutes','carryover','excessPolicy','scopeRu','scopeEn','operatingHoursRu','operatingHoursEn','schedulingTermsRu','schedulingTermsEn']
    and ("invoice_lines"."commercial_terms"->'serviceTerms') - array['cadence','includedMinutes','carryover','excessPolicy','scopeRu','scopeEn','operatingHoursRu','operatingHoursEn','schedulingTermsRu','schedulingTermsEn'] = '{}'::jsonb
    and ("invoice_lines"."commercial_terms"->'serviceTerms')->>'cadence' = 'month'
    and case when jsonb_typeof(("invoice_lines"."commercial_terms"->'serviceTerms')->'includedMinutes') = 'number' and (("invoice_lines"."commercial_terms"->'serviceTerms')->>'includedMinutes') ~ '^[1-9][0-9]{0,9}$' then (("invoice_lines"."commercial_terms"->'serviceTerms')->>'includedMinutes')::numeric <= 2147483647 else false end
    and (("invoice_lines"."commercial_terms"->'serviceTerms')->>'includedMinutes')::numeric <= 100000
    and ("invoice_lines"."commercial_terms"->'serviceTerms')->>'carryover' = 'none'
    and ("invoice_lines"."commercial_terms"->'serviceTerms')->>'excessPolicy' = 'external_approval'
    and jsonb_typeof(("invoice_lines"."commercial_terms"->'serviceTerms')->'scopeRu') = 'string' and length(btrim(("invoice_lines"."commercial_terms"->'serviceTerms')->>'scopeRu')) between 1 and 4000
    and (("invoice_lines"."commercial_terms"->'serviceTerms')->'scopeEn' = 'null'::jsonb or (jsonb_typeof(("invoice_lines"."commercial_terms"->'serviceTerms')->'scopeEn') = 'string' and length(btrim(("invoice_lines"."commercial_terms"->'serviceTerms')->>'scopeEn')) between 1 and 4000))
    and (("invoice_lines"."commercial_terms"->'serviceTerms')->'operatingHoursRu' = 'null'::jsonb or (jsonb_typeof(("invoice_lines"."commercial_terms"->'serviceTerms')->'operatingHoursRu') = 'string' and length(btrim(("invoice_lines"."commercial_terms"->'serviceTerms')->>'operatingHoursRu')) between 1 and 1000))
    and (("invoice_lines"."commercial_terms"->'serviceTerms')->'operatingHoursEn' = 'null'::jsonb or (jsonb_typeof(("invoice_lines"."commercial_terms"->'serviceTerms')->'operatingHoursEn') = 'string' and length(btrim(("invoice_lines"."commercial_terms"->'serviceTerms')->>'operatingHoursEn')) between 1 and 1000))
    and (("invoice_lines"."commercial_terms"->'serviceTerms')->'schedulingTermsRu' = 'null'::jsonb or (jsonb_typeof(("invoice_lines"."commercial_terms"->'serviceTerms')->'schedulingTermsRu') = 'string' and length(btrim(("invoice_lines"."commercial_terms"->'serviceTerms')->>'schedulingTermsRu')) between 1 and 1000))
    and (("invoice_lines"."commercial_terms"->'serviceTerms')->'schedulingTermsEn' = 'null'::jsonb or (jsonb_typeof(("invoice_lines"."commercial_terms"->'serviceTerms')->'schedulingTermsEn') = 'string' and length(btrim(("invoice_lines"."commercial_terms"->'serviceTerms')->>'schedulingTermsEn')) between 1 and 1000)))
      or ("invoice_lines"."commercial_terms"->'version' = '3'::jsonb
        and "invoice_lines"."kind"::text = 'plan' and "invoice_lines"."quantity" = 1
        and "invoice_lines"."commercial_terms"->>'subject' = 'software_license'
        and "invoice_lines"."commercial_terms"->>'billingPeriod' = 'custom'
        and "invoice_lines"."commercial_terms"->>'billingTimezone' = 'Europe/Moscow'
        and "invoice_lines"."commercial_terms"->>'activationRule' in ('on_application','after_current')
        and "invoice_lines"."commercial_terms" ?& array['termStart','termEnd']
        and "invoice_lines"."commercial_terms" - array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule','termStart','termEnd'] = '{}'::jsonb
        and (jsonb_typeof("invoice_lines"."commercial_terms"->'termStart') = 'string'
    and "invoice_lines"."commercial_terms"->>'termStart' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')
        and (jsonb_typeof("invoice_lines"."commercial_terms"->'termEnd') = 'string'
    and "invoice_lines"."commercial_terms"->>'termEnd' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')
        and "invoice_lines"."commercial_terms"->>'termStart' <= "invoice_lines"."commercial_terms"->>'termEnd')
    )
  ), false));