import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import ru from "./ru.json";

/** Russian only in the first version; every string still goes through i18n. */
export const SUPPORTED_LANGUAGES = ["ru"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const isTestEnv = import.meta.env.MODE === "test";

// A missing key must fail tests loudly rather than render the raw key.
// Spread conditionally: `exactOptionalPropertyTypes` rejects an explicit
// `undefined` for i18next's `missingKeyHandler`.
const missingKeyOptions = isTestEnv
  ? {
      saveMissing: true,
      missingKeyHandler: (languages: readonly string[], namespace: string, key: string) => {
        throw new Error(`Missing i18n key: ${namespace}:${key} (${languages.join(", ")})`);
      },
    }
  : {};

void i18n.use(initReactI18next).init({
  resources: { ru: { translation: ru } },
  lng: "ru",
  fallbackLng: "ru",
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  ...missingKeyOptions,
});

export default i18n;
