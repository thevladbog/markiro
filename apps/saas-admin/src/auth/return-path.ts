/** Accept only an internal destination carried through platform sign-in and 2FA. */
export function platformReturnPath(state: unknown): string {
  const requested =
    state !== null && typeof state === "object" && "from" in state ? state.from : undefined;
  if (
    typeof requested !== "string" ||
    !requested.startsWith("/") ||
    requested.startsWith("//") ||
    /[\\\s]/u.test(requested)
  ) {
    return "/";
  }
  return requested;
}
