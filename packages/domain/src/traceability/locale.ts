import { parseDeploymentEdition, type DeploymentEdition } from "./deployment-edition.js";

export type InterfaceLocale = "ru-RU" | "en-US" | "es-US";

const EDITION_LOCALES: Readonly<Record<DeploymentEdition, readonly InterfaceLocale[]>> =
  Object.freeze({
    RU: Object.freeze(["ru-RU", "en-US"] as const),
    US: Object.freeze(["en-US", "es-US"] as const),
  });

export function allowedInterfaceLocales(edition: DeploymentEdition): readonly InterfaceLocale[] {
  return EDITION_LOCALES[parseDeploymentEdition(edition)];
}

/** Resolves UI language only; it does not format or mutate business records. */
export function resolveInterfaceLocale(
  edition: DeploymentEdition,
  preference: unknown,
): InterfaceLocale {
  const locales = allowedInterfaceLocales(edition);
  const fallback = edition === "US" ? "en-US" : "ru-RU";
  if (typeof preference !== "string" || preference.length === 0) return fallback;

  let language: string;
  try {
    language = new Intl.Locale(preference).language;
  } catch {
    return fallback;
  }
  return locales.find((locale) => locale.split("-")[0] === language) ?? fallback;
}
