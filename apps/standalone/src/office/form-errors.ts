import { HostError } from "../host/client.js";
import { errorMessageKey } from "../host/errors.js";

/** What a form shows for a failed write. Messages are i18n keys. */
export type WriteFailure<F extends string> =
  | { kind: "field"; field: F; message: string }
  | { kind: "stale" }
  | { kind: "alert"; message: string };

/**
 * Sorts a failed office write: a `validation_failed` naming a known field
 * goes under that field, `stale_revision` offers to reload, and anything
 * else is an alert explained by its code. `fields` maps the host's field
 * names to the form's.
 */
export function writeFailure<F extends string>(
  error: unknown,
  fields: Readonly<Record<string, F>>,
): WriteFailure<F> {
  if (error instanceof HostError) {
    if (error.code === "stale_revision") return { kind: "stale" };
    const path = error.field;
    const field = path === null ? undefined : fields[path];
    if (field !== undefined) return { kind: "field", field, message: "rules.rejected" };
  }
  return { kind: "alert", message: errorMessageKey(error) };
}

/** The alert text for a failure that is not a field error; a stale write reads as `stale_revision`. */
export function failureMessage(failure: Exclude<WriteFailure<string>, { kind: "field" }>): string {
  return failure.kind === "alert" ? failure.message : "errors.api.stale_revision";
}
