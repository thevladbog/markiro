import { landingLeadRequestSchema } from "@markiro/platform-contracts";
import { z } from "zod";
import { normalizePhone } from "../demo-requests/demo-request.schema";

/** Legacy attribution fields remain accepted on the wire, but request consent does not
 * authorize storing or forwarding them. Drop them before the persistence boundary. */
export const landingLeadBodySchema = landingLeadRequestSchema.transform((input, context) => {
  const phone = normalizePhone(input.phone, input.locale);
  if (phone === null) {
    context.addIssue({ code: "custom", path: ["phone"], message: "Invalid phone" });
    return z.NEVER;
  }
  return {
    requestId: input.requestId.toLowerCase(),
    locale: input.locale,
    sourcePath: input.sourcePath,
    intent: input.intent,
    email: input.email,
    ...(input.company !== undefined ? { company: input.company } : {}),
    consentVersion: input.consentVersion,
    website: input.website,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(input.productGroup !== undefined ? { productGroup: input.productGroup } : {}),
    ...(input.linesBucket !== undefined ? { linesBucket: input.linesBucket } : {}),
    ...(input.inn !== undefined ? { inn: input.inn } : {}),
    ...(input.tariffCode !== undefined ? { tariffCode: input.tariffCode } : {}),
  };
});

export type LandingLeadDto = z.output<typeof landingLeadBodySchema>;
