/**
 * Drizzle embeds the full SQL statement and its bound parameters in a query
 * error's `message`/`stack` (params follow the query on later lines), so
 * neither is logged raw — that would leak row data, and for some tables a
 * bearer token or other secret. Bound to the message's first line, capped,
 * plus a few real stack frames (the stack repeats the message before the
 * first "at ...").
 *
 * Shared by every runner that logs an unexpected error from a Drizzle call:
 * keep it here rather than duplicating it per module, since a fix to the
 * sanitisation (e.g. a new place a secret can leak through) must land once.
 */
export function describeErrorForLog(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const firstLine = error.message.split("\n", 1)[0]!.slice(0, 300);
  const frames = (error.stack ?? "")
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .slice(0, 5);
  return [firstLine, ...frames].join("\n");
}
