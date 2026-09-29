// Legal-form abbreviations carry no identity: "ООО РЭБЕЛ ЭППЛ" is "РЭ", not "ОР".
const LEGAL_FORMS = new Set([
  "ооо",
  "оао",
  "зао",
  "пао",
  "ао",
  "ип",
  "нко",
  "ано",
  "llc",
  "ltd",
  "inc",
  "corp",
  "gmbh",
]);

export function orgInitials(name: string): string {
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => Array.from(word));
  const meaningful = words.filter((word) => !LEGAL_FORMS.has(word.join("").toLowerCase()));
  const parts = meaningful.length > 0 ? meaningful : words;
  const [first, second] = parts;
  if (!first) return "?";
  const letters = second ? [first[0], second[0]] : first.slice(0, 2);
  return letters.join("").toLocaleUpperCase("ru");
}
