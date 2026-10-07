/**
 * The name search on the sign-in screen (plan 1f2), ported from the cloud
 * station's `searchOperatorsByName` (`apps/station/src/lib/operator-search.ts`):
 * at least two letters, at most five names, identity only. Choosing a name
 * only fills in the personnel number; the PIN is still checked by
 * `signInWithPin`.
 */

/** An operator the search may offer: never a hash. */
export interface RosterEntry {
  id: string;
  /** The personnel number, leading zeros included. */
  login: string;
  name: string;
}

/** The most names the search shows at once. */
export const NAME_SEARCH_LIMIT = 5;

/** Letters (not digits or spaces) the search waits for before it offers names. */
export const NAME_SEARCH_MIN_LETTERS = 2;

/** The longest query: a person's name is at most 100 characters (`personNameRule`). */
export const NAME_QUERY_MAX_LENGTH = 100;

/** A personnel number the keypad could have typed (`operatorLoginRule`). */
const LOGIN = /^[0-9]{3,12}$/;

/** Trims, folds runs of spaces into one and lower-cases; names only, never a number. */
export function normalizeOperatorName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** How many letters a query holds, in any alphabet. */
export function nameQueryLetters(query: string): number {
  return Array.from(normalizeOperatorName(query)).filter((character) => /\p{L}/u.test(character))
    .length;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The operators whose name holds every word of the query, in order (each
 * word may be the start or the middle of a word of the name), sorted by
 * name and then id, at most `NAME_SEARCH_LIMIT`; nothing until the query
 * has `NAME_SEARCH_MIN_LETTERS` letters. An operator whose personnel number
 * the keypad could not type is never offered.
 */
export function searchOperatorsByName(
  roster: readonly RosterEntry[],
  query: string,
): RosterEntry[] {
  if (nameQueryLetters(query) < NAME_SEARCH_MIN_LETTERS) return [];
  const words = normalizeOperatorName(query).split(" ");
  return roster
    .filter((entry) => {
      if (!LOGIN.test(entry.login)) return false;
      const name = normalizeOperatorName(entry.name);
      let from = 0;
      return words.every((word) => {
        const at = name.indexOf(word, from);
        if (at < 0) return false;
        from = at + word.length;
        return true;
      });
    })
    .sort(
      (left, right) =>
        compareText(normalizeOperatorName(left.name), normalizeOperatorName(right.name)) ||
        compareText(left.id, right.id),
    )
    .slice(0, NAME_SEARCH_LIMIT)
    .map(({ id, login, name }) => ({ id, login, name }));
}
