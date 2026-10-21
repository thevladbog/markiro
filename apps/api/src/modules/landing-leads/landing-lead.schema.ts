import { landingLeadRequestSchema } from "@markiro/platform-contracts";
import { z } from "zod";
import { normalizePhone } from "../demo-requests/demo-request.schema";

/**
 * The public body of `POST /api/landing-leads`: the shared `.strict()` contract plus the
 * demo form's phone rules and a referrer cut down to origin and path, so a query string
 * (which may carry an e-mail or a token) is never stored.
 */
export const landingLeadBodySchema = landingLeadRequestSchema.transform((input, context) => {
  const phone = normalizePhone(input.phone, input.locale);
  if (phone === null) {
    context.addIssue({ code: "custom", path: ["phone"], message: "Invalid phone" });
    return z.NEVER;
  }
  const referrer = safeReferrer(input.referrer);
  const utm = input.utm === undefined ? undefined : definedEntries(input.utm);
  return {
    requestId: input.requestId.toLowerCase(),
    locale: input.locale,
    sourcePath: input.sourcePath,
    intent: input.intent,
    email: input.email,
    company: input.company,
    consentVersion: input.consentVersion,
    website: input.website,
    captchaToken: input.captchaToken,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(input.productGroup !== undefined ? { productGroup: input.productGroup } : {}),
    ...(input.linesBucket !== undefined ? { linesBucket: input.linesBucket } : {}),
    ...(input.inn !== undefined ? { inn: input.inn } : {}),
    ...(input.tariffCode !== undefined ? { tariffCode: input.tariffCode } : {}),
    ...(utm !== undefined && Object.keys(utm).length > 0 ? { utm } : {}),
    ...(referrer !== undefined ? { referrer } : {}),
  };
});

export type LandingLeadDto = z.output<typeof landingLeadBodySchema>;

function definedEntries(value: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) result[key] = entry;
  return result;
}

export function safeReferrer(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return undefined;
  }
}
