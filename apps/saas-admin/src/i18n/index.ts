import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./en.json";
import ru from "./ru.json";

export const SUPPORTED_LANGUAGES = ["ru", "en"] as const;

function syncDocumentLanguage(language: string) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = language.startsWith("en") ? "en" : "ru";
  }
}

i18n.on("languageChanged", syncDocumentLanguage);

void i18n.use(initReactI18next).init({
  resources: { ru: { translation: ru }, en: { translation: en } },
  lng: "ru",
  fallbackLng: "ru",
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

export default i18n;
