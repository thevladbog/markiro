/**
 * Converts a possibly-undefined error message into a prop bag for the
 * `error?: string` prop of @markiro/ui controls. `exactOptionalPropertyTypes`
 * rejects an explicit `undefined`, so the key must be absent instead.
 */
export function errorProp(message?: string): { error?: string } {
  return message === undefined ? {} : { error: message };
}
