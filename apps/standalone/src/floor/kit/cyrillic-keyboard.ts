import { NAME_QUERY_MAX_LENGTH } from "../operator-search.js";

/**
 * The flat Cyrillic keyboard of the name search (design kit 2026-10): ЙЦУКЕН in three rows, with
 * «Стереть» and «Пробел» beside the last one, in place of Windows' own on-screen keyboard. Pure
 * text editing: the field itself stays a real input, so a hardware keyboard works as before.
 * `Ё` has a key as well, so a name spelled with it can be found as it is stored.
 */
export const CYRILLIC_ROWS: readonly (readonly string[])[] = [
  [..."ЙЦУКЕНГШЩЗХЪ"],
  [..."ФЫВАПРОЛДЖЭЁ"],
  [..."ЯЧСМИТЬБЮ"],
];

const LETTERS = new Set(CYRILLIC_ROWS.flat());

const length = (text: string) => Array.from(text).length;

/**
 * `query` with the letter of a key appended, spelled as a name: a capital at the start and after
 * a space, small between. Nothing for a character that is no key, or for a full field.
 */
export function typeLetter(query: string, letter: string): string {
  const upper = letter.toUpperCase();
  if (!LETTERS.has(upper) || length(query) >= NAME_QUERY_MAX_LENGTH) return query;
  const capital = query === "" || query.endsWith(" ");
  return query + (capital ? upper : upper.toLowerCase());
}

/** A space after a letter, once; nothing at the start, after a space or in a full field. */
export function typeSpace(query: string): string {
  if (query === "" || query.endsWith(" ") || length(query) >= NAME_QUERY_MAX_LENGTH) return query;
  return `${query} `;
}

/** `query` without its last character (a space included). */
export function eraseLetter(query: string): string {
  return Array.from(query).slice(0, -1).join("");
}
