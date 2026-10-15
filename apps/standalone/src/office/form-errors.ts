import { useTranslation } from "react-i18next";

import { HostError } from "../host/client.js";
import { errorMessageKey } from "../host/errors.js";

/** What a form shows for a failed write. Messages are i18n keys. */
export type WriteFailure<F extends string> =
  | { kind: "field"; field: F; message: string }
  | { kind: "stale" }
  | { kind: "alert"; message: string; values?: Readonly<Record<string, string | number>> };

/** A failed write shown above the form rather than under a field (`WriteFailureAlert`). */
export type AlertFailure = Exclude<WriteFailure<string>, { kind: "field" }>;

/** A form field and the i18n key of the text it shows. */
export interface FieldMessage<F extends string> {
  field: F;
  message: string;
}

/** `record[key]` when `record` has that key of its own; never an inherited `Object` member. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Sorts a failed office write: a `validation_failed` naming a known field
 * goes under that field, a `conflict` whose `details.constraint` the form
 * knows goes under that constraint's field with the form's own text, and
 * the rest is `alertFailure`. `fields` maps the host's field names to the
 * form's; a bare field name says `rules.rejected`, a `FieldMessage` its own
 * text. `conflicts` maps constraint names (`line_name`, `login`, `badge`)
 * the same way. `staleFields` names host fields whose `validation_failed`
 * means the form is out of date, so it reads as `stale_revision`: a product's
 * template preferences, which the host checks before the revision, so a form
 * opened before its template was deleted is refused on the preference.
 */
export function writeFailure<F extends string>(
  error: unknown,
  fields: Readonly<Record<string, F | FieldMessage<F>>>,
  conflicts: Readonly<Record<string, FieldMessage<F>>> = {},
  staleFields: readonly string[] = [],
): WriteFailure<F> {
  if (error instanceof HostError) {
    const constraint = error.details.constraint;
    if (error.code === "conflict" && typeof constraint === "string") {
      const target = own(conflicts, constraint);
      if (target !== undefined) {
        return { kind: "field", field: target.field, message: target.message };
      }
    }
    const path = error.field;
    if (path !== null && staleFields.includes(path)) return { kind: "stale" };
    const target = path === null ? undefined : own(fields, path);
    if (typeof target === "string") {
      return { kind: "field", field: target, message: "rules.rejected" };
    }
    if (target !== undefined) {
      return { kind: "field", field: target.field, message: target.message };
    }
  }
  return alertFailure(error);
}

/**
 * A failed write with no field to go under, as a confirmation without fields
 * has: `stale_revision` offers to reload, anything else is explained by its
 * code.
 */
export function alertFailure(error: unknown): AlertFailure {
  if (error instanceof HostError && error.code === "stale_revision") return { kind: "stale" };
  const license = licenseRefusal(error);
  if (license !== null) return { kind: "alert", ...license };
  return { kind: "alert", message: errorMessageKey(error) };
}

/** The features whose refusal the office says by name (license spec §4.7, ЛО23). */
const NAMED_FEATURES: ReadonlySet<string> = new Set(["labelEditor", "pallets", "handheld"]);

/**
 * A write the site's license refuses (plan ЛЦ-3): `conflict` on `seat_limit`
 * with its figures (a user or a line over the license) or on
 * `feature_disabled` (a template without `labelEditor`, a shift with pallets
 * without `pallets`). `null` for anything else, and for a seat refusal without
 * its figures, which the code then explains.
 */
function licenseRefusal(error: unknown): {
  message: string;
  values?: Record<string, number>;
} | null {
  if (!(error instanceof HostError) || error.code !== "conflict") return null;
  const { constraint, used, limit, feature } = error.details;
  if (constraint === "seat_limit" && typeof used === "number" && typeof limit === "number") {
    return { message: "office.about.license.refusals.seatLimit", values: { used, limit } };
  }
  if (constraint === "feature_disabled") {
    return {
      message:
        typeof feature === "string" && NAMED_FEATURES.has(feature)
          ? `office.about.license.refusals.feature.${feature}`
          : "office.about.license.refusals.featureDisabled",
    };
  }
  return null;
}

/** The values of an alert's text (the seats of a refusal over the license); none for the rest. */
export function failureValues(
  failure: AlertFailure,
): Readonly<Record<string, string | number>> | undefined {
  return failure.kind === "alert" ? failure.values : undefined;
}

/** The alert text for a failure that is not a field error; a stale write reads as `stale_revision`. */
export function failureMessage(failure: AlertFailure): string {
  return failure.kind === "alert" ? failure.message : "errors.api.stale_revision";
}

/**
 * The `error` prop of a form control for a message key, translated with
 * `values`; no key, no prop (`exactOptionalPropertyTypes` rejects an
 * explicit `undefined`, as `errorProp` explains).
 */
export function useFieldError(): (
  message: string | undefined,
  values?: Record<string, unknown>,
) => { error?: string } {
  const { t } = useTranslation();
  return (message, values) => {
    if (message === undefined) return {};
    return { error: values === undefined ? t(message) : t(message, values) };
  };
}
