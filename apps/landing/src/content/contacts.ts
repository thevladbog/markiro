import type { Locale } from "./pages";

/**
 * Sales contacts shown across the site. The published legal editions keep the
 * contacts of their operator profile (`@markiro/legal-documents`) until they
 * are reissued, so legal pages may still show the older address.
 */
export const SITE_CONTACTS = {
  email: "hello@markiro.app",
  telegram: { handle: "thevladbog", href: "https://t.me/thevladbog" },
} as const;

const OPERATOR_REQUISITES: Readonly<Record<Locale, string>> = {
  ru: "ИП Богатырев Владислав Сергеевич · ИНН 234106228141 · ОГРНИП 321237500100358",
  en: "Sole proprietor Vladislav Bogatyrev · INN 234106228141 · OGRNIP 321237500100358",
};

export function operatorRequisites(locale: Locale): string {
  return OPERATOR_REQUISITES[locale];
}
