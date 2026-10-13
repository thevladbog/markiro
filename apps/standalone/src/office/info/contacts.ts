/**
 * The public contacts the office's «Информация» shows. One place to change
 * them: nothing else in the app spells an address out.
 *
 * Every value is copied from what the repository already publishes:
 * `apps/landing/src/content/contacts.ts` (`SITE_CONTACTS.email`, the
 * operator's requisites) and `apps/landing/astro.config.mjs` (`site`). The
 * landing's phone comes from its deployment environment (`PUBLIC_PHONE`), not
 * from a file, and no working hours are published anywhere, so neither is
 * shown here.
 */
export interface SupportContacts {
  /** The vendor, as the landing's footer names it. */
  readonly companyName: string;
  /** The vendor's public requisites, as the landing's footer prints them. */
  readonly requisites: string;
  /** Where support is written to. */
  readonly email: string;
  /** The product's site: the only site the shell opens. */
  readonly site: { readonly url: string; readonly label: string };
}

export const SUPPORT_CONTACTS: SupportContacts = {
  companyName: "ИП Богатырев Владислав Сергеевич",
  requisites: "ИНН 234106228141 · ОГРНИП 326237500395950",
  email: "hello@markiro.app",
  site: { url: "https://markiro.app", label: "markiro.app" },
};

/** The link «Написать в поддержку» opens: a letter with no subject and no body. */
export function supportMailLink(contacts: SupportContacts = SUPPORT_CONTACTS): string {
  return `mailto:${contacts.email}`;
}
