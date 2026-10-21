import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

// Nullable additive metadata is intentionally absent on legacy records. COALESCE prevents
// SQL's unknown result from accepting incomplete JSON at the storage boundary.
export function commercialLineTermsCheck(
  value: AnyPgColumn,
  kind: AnyPgColumn,
  quantity: AnyPgColumn,
): SQL {
  return sql`${value} is null or coalesce((
    jsonb_typeof(${value}) = 'object'
    and ${value} ?& array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule']
    and jsonb_typeof(${value}->'documentNameRu') = 'string'
    and length(btrim(${value}->>'documentNameRu')) between 1 and 300
    and (${value}->'documentNameEn' = 'null'::jsonb or (jsonb_typeof(${value}->'documentNameEn') = 'string' and length(btrim(${value}->>'documentNameEn')) between 1 and 300))
    and ${positiveJsonInteger(value, "sellerPolicyRevision")}
    and (
      (${value}->'version' = '1'::jsonb
        and ${value} - array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule'] = '{}'::jsonb
        and ((${kind}::text in ('plan','addon') and ${value}->>'subject' = 'software_license'
          and ${value}->>'billingPeriod' in ('month','year') and ${value}->>'billingTimezone' = 'Europe/Moscow'
          and ${value}->>'activationRule' in ('on_application','after_current') and (${kind} <> 'plan' or ${quantity} = 1))
          or (${kind}::text in ('service','custom') and ${value}->>'subject' in ('service','development_work')
          and ${value}->'billingPeriod' = 'null'::jsonb and ${value}->'billingTimezone' = 'null'::jsonb and ${value}->'activationRule' = 'null'::jsonb)))
      or (${value}->'version' = '2'::jsonb
        and ${kind}::text = 'service' and ${quantity} = 1
        and ${value}->>'subject' in ('service','development_work')
        and ${value}->>'billingPeriod' = 'month'
        and ${value}->>'billingTimezone' = 'Europe/Moscow'
        and ${value}->>'activationRule' = 'after_current'
        and ${value} ? 'serviceTerms'
        and ${value} - array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule','serviceTerms'] = '{}'::jsonb
        and ${monthlyServiceTermsCheck(value)})
      or (${value}->'version' = '3'::jsonb
        and ${kind}::text = 'plan' and ${quantity} = 1
        and ${value}->>'subject' = 'software_license'
        and ${value}->>'billingPeriod' = 'custom'
        and ${value}->>'billingTimezone' = 'Europe/Moscow'
        and ${value}->>'activationRule' in ('on_application','after_current')
        and ${value} ?& array['termStart','termEnd']
        and ${value} - array['version','subject','documentNameRu','documentNameEn','sellerPolicyRevision','billingPeriod','billingTimezone','activationRule','termStart','termEnd'] = '{}'::jsonb
        and ${civilDateJsonCheck(value, "termStart")}
        and ${civilDateJsonCheck(value, "termEnd")}
        and ${value}->>'termStart' <= ${value}->>'termEnd')
    )
  ), false)`;
}

function civilDateJsonCheck(value: AnyPgColumn, key: string): SQL {
  const raw = sql`(${value}->>${sql.raw(`'${key}'`)})`;
  // The shape is checked first so no cast runs on malformed text; impossible calendar days and
  // year 0000 are rejected arithmetically because a ::date cast would raise instead of failing.
  return sql`case when jsonb_typeof(${value}->${sql.raw(`'${key}'`)}) = 'string'
    and ${raw} ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' and ${raw} !~ '^0000-'
    then (
      substr(${raw}, 6, 2) in ('01','03','05','07','08','10','12')
      or (substr(${raw}, 6, 2) in ('04','06','09','11') and substr(${raw}, 9, 2) <> '31')
      or (substr(${raw}, 6, 2) = '02' and (substr(${raw}, 9, 2) <= '28'
        or (substr(${raw}, 9, 2) = '29' and substr(${raw}, 1, 4)::int % 4 = 0
          and (substr(${raw}, 1, 4)::int % 100 <> 0 or substr(${raw}, 1, 4)::int % 400 = 0))))
    ) else false end`;
}

function monthlyServiceTermsCheck(value: AnyPgColumn): SQL {
  const terms = sql`(${value}->'serviceTerms')`;
  return sql`jsonb_typeof(${terms}) = 'object'
    and ${terms} ?& array['cadence','includedMinutes','carryover','excessPolicy','scopeRu','scopeEn','operatingHoursRu','operatingHoursEn','schedulingTermsRu','schedulingTermsEn']
    and ${terms} - array['cadence','includedMinutes','carryover','excessPolicy','scopeRu','scopeEn','operatingHoursRu','operatingHoursEn','schedulingTermsRu','schedulingTermsEn'] = '{}'::jsonb
    and ${terms}->>'cadence' = 'month'
    and ${positiveJsonInteger(terms, "includedMinutes")}
    and (${terms}->>'includedMinutes')::numeric <= 100000
    and ${terms}->>'carryover' = 'none'
    and ${terms}->>'excessPolicy' = 'external_approval'
    and jsonb_typeof(${terms}->'scopeRu') = 'string' and length(btrim(${terms}->>'scopeRu')) between 1 and 4000
    and (${terms}->'scopeEn' = 'null'::jsonb or (jsonb_typeof(${terms}->'scopeEn') = 'string' and length(btrim(${terms}->>'scopeEn')) between 1 and 4000))
    and ${nullableServiceTextCheck(terms, "operatingHoursRu")}
    and ${nullableServiceTextCheck(terms, "operatingHoursEn")}
    and ${nullableServiceTextCheck(terms, "schedulingTermsRu")}
    and ${nullableServiceTextCheck(terms, "schedulingTermsEn")}`;
}

function nullableServiceTextCheck(value: SQL, key: string): SQL {
  const field = sql`${value}->${sql.raw(`'${key}'`)}`;
  return sql`(${field} = 'null'::jsonb or (jsonb_typeof(${field}) = 'string' and length(btrim(${value}->>${sql.raw(`'${key}'`)})) between 1 and 1000))`;
}
function positiveJsonInteger(value: AnyPgColumn | SQL, key: string): SQL {
  return sql`case when jsonb_typeof(${value}->${sql.raw(`'${key}'`)}) = 'number' and (${value}->>${sql.raw(`'${key}'`)}) ~ '^[1-9][0-9]{0,9}$' then (${value}->>${sql.raw(`'${key}'`)})::numeric <= 2147483647 else false end`;
}

export function commercialPeriodCheck(value: AnyPgColumn): SQL {
  return sql`${value} is null or coalesce((
    jsonb_typeof(${value}) = 'object'
    and ${value} ?& array['billingPeriod','billingTimezone','calendarPolicyVersion','anchorAt','cycle','startsAt','endsAt']
    and ${value} - array['billingPeriod','billingTimezone','calendarPolicyVersion','anchorAt','cycle','startsAt','endsAt'] = '{}'::jsonb
    and ${value}->>'billingPeriod' in ('month','year','custom') and ${value}->>'billingTimezone' = 'Europe/Moscow'
    and ${value}->'calendarPolicyVersion' = '1'::jsonb
    and jsonb_typeof(${value}->'cycle') = 'number' and (${value}->>'cycle') ~ '^(0|[1-9][0-9]{0,15})$'
    and jsonb_typeof(${value}->'anchorAt') = 'string' and (${value}->>'anchorAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    and jsonb_typeof(${value}->'startsAt') = 'string' and (${value}->>'startsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    and jsonb_typeof(${value}->'endsAt') = 'string' and (${value}->>'endsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  ), false)`;
}
export function sellerTaxPolicyCheck(value: AnyPgColumn): SQL {
  return sql`${value} is null or coalesce((jsonb_typeof(${value}) = 'object' and (
    (${value}->>'kind' = 'without_vat' and ${value}->>'regime' in ('npd','other') and ${value} - array['kind','regime'] = '{}'::jsonb)
    or (${value}->>'kind' = 'vat' and ${value}->>'regime' = 'other'
      and ${value} ?& array['allowedRatesBps','defaultRateBps','defaultIncluded']
      and ${value} - array['kind','regime','allowedRatesBps','defaultRateBps','defaultIncluded'] = '{}'::jsonb
      and jsonb_typeof(${value}->'defaultIncluded') = 'boolean'
      and jsonb_typeof(${value}->'defaultRateBps') = 'number'
      and jsonb_typeof(${value}->'allowedRatesBps') = 'array'
      and jsonb_path_exists(${value}, '$.allowedRatesBps[*]')
      and not jsonb_path_exists(${value}, '$.allowedRatesBps[*] ? (@.type() != "number" || @ < 0 || @ > 10000 || @ != @.floor())')
      and (${value}->'allowedRatesBps') @> jsonb_build_array(${value}->'defaultRateBps')
    )
  )), false)`;
}
