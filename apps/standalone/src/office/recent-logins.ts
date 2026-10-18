/**
 * The office users who signed in on THIS PC before (beta 3.2): a short list of
 * login names kept in the webview's own storage, so the sign-in can offer them.
 * Names only: no password, no role, no id. The host never lists its users to
 * an unauthenticated peer on the network, so this list lives here and nowhere else.
 */

const KEY = "markiro.office.recentLogins";
/** The most names kept; the oldest goes first. */
export const MAX_RECENT_LOGINS = 6;
/** The longest login the host accepts (3–64 characters). */
const MAX_LOGIN_LENGTH = 64;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A webview with storage turned off: the list is simply empty.
    return null;
  }
}

/** The names, the most recent first. A damaged value reads as an empty list. */
export function readRecentLogins(): string[] {
  const store = storage();
  if (store === null) return [];
  try {
    const parsed: unknown = JSON.parse(store.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const names: string[] = [];
    for (const entry of parsed) {
      if (
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= MAX_LOGIN_LENGTH &&
        !names.includes(entry)
      ) {
        names.push(entry);
      }
    }
    return names.slice(0, MAX_RECENT_LOGINS);
  } catch {
    return [];
  }
}

function write(names: readonly string[]): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(names));
  } catch {
    // Storage full or refused: the sign-in works without the list.
  }
}

/** Puts `login` first, once; returns the new list. */
export function rememberLogin(login: string): string[] {
  const name = login.trim();
  if (name.length === 0 || name.length > MAX_LOGIN_LENGTH) return readRecentLogins();
  const names = [name, ...readRecentLogins().filter((each) => each !== name)].slice(
    0,
    MAX_RECENT_LOGINS,
  );
  write(names);
  return names;
}

/** Empties the list («Очистить список»). */
export function clearLogins(): void {
  write([]);
}

/** Takes `login` off the list; returns the new list. */
export function forgetLogin(login: string): string[] {
  const names = readRecentLogins().filter((each) => each !== login);
  write(names);
  return names;
}
