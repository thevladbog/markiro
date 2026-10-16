/** The category tones an initials avatar takes, in the kit's order. */
export const AVATAR_TONES = ["violet", "teal", "magenta", "steel"] as const;
export type AvatarTone = (typeof AVATAR_TONES)[number];

/**
 * The initials of a person's name: the first letters of the first two words (two letters); a
 * one-word name gives one letter; no name gives a dot. Upper case.
 */
export function userInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return "·";
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toLocaleUpperCase("ru-RU");
}

/**
 * The tone of an initials avatar, fixed by the name: the sum of the code points of its lower-case
 * characters, modulo 4 (violet, teal, magenta, steel). The same person has the same colour on
 * every PC and in every session; the colour is decoration, the letters carry the identity.
 */
export function avatarTone(name: string): AvatarTone {
  let sum = 0;
  for (const char of name.toLocaleLowerCase("ru-RU")) sum += char.codePointAt(0) ?? 0;
  return AVATAR_TONES[sum % AVATAR_TONES.length] ?? "steel";
}
