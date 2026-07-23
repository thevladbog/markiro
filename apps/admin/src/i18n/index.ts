import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./en.json";
import ru from "./ru.json";

export const SUPPORTED_LANGUAGES = ["ru", "en"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const isTestEnv = import.meta.env.MODE === "test";

// A missing dictionary key should fail tests loudly instead of silently
// rendering the raw key -- see the task brief's "missing-key = test
// failure" requirement. Built as a conditionally-spread options object
// (rather than passing `missingKeyHandler: isTestEnv ? fn : undefined`)
// because i18next's `missingKeyHandler` option type doesn't include
// `undefined`, and this project's `exactOptionalPropertyTypes` (see
// ../../tsconfig.base.json) rejects explicitly assigning `undefined` to it.
const missingKeyOptions = isTestEnv
  ? {
      saveMissing: true,
      missingKeyHandler: (languages: readonly string[], namespace: string, key: string) => {
        throw new Error(`Missing i18n key: ${namespace}:${key} (${languages.join(", ")})`);
      },
    }
  : {};

void i18n.use(initReactI18next).init({
  resources: { ru: { translation: ru }, en: { translation: en } },
  lng: "ru",
  fallbackLng: "ru",
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  ...missingKeyOptions,
});

export default i18n;
