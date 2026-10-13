/**
 * The support addresses the office's «Информация» shows, in the order the
 * owner chose (decision of 2026-10-13): the first is where «Написать в
 * поддержку» writes, the second is shown beside it as an alternative. One
 * place to change them: nothing else in the app spells an address out. No
 * company name, requisites, phone, working hours or site are shown.
 */
export const SUPPORT_EMAILS = ["hello@v-b.tech", "vladislav.bogatyrev@gmail.com"] as const;

/** The address «Написать в поддержку» writes to. */
export const PRIMARY_SUPPORT_EMAIL: string = SUPPORT_EMAILS[0];

/** The address shown as the alternative. */
export const ALTERNATIVE_SUPPORT_EMAIL: string = SUPPORT_EMAILS[1];

/** The link «Написать в поддержку» opens: a letter with no subject and no body, no copy. */
export function supportMailLink(email: string = PRIMARY_SUPPORT_EMAIL): string {
  return `mailto:${email}`;
}
