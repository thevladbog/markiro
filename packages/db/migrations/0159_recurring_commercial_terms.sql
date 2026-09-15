ALTER TABLE "commercial_offer_lines" DROP CONSTRAINT "commercial_offer_lines_commercial_terms_check";--> statement-breakpoint
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
    )
  ), false)) NOT VALID;--> statement-breakpoint
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
    )
  ), false)) NOT VALID;