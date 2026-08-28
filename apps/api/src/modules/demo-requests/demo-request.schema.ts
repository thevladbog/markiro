import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

import { DEMO_SOURCE_PATHS } from "./demo-request-routes";

const PHONE_INPUT_MAX_LENGTH = 30;
const PHONE_PUNCTUATION = /^\+?[\d\s().-]+$/;

const demoRequestInputSchema = z
  .object({
    requestId: z.uuid(),
    locale: z.enum(["ru", "en"]),
    sourcePath: z.enum(DEMO_SOURCE_PATHS),
    consentVersion: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(80),
    company: z.string().trim().min(1).max(120),
    email: z.string().trim().max(254).toLowerCase().pipe(z.email()),
    phone: z.string().trim().max(PHONE_INPUT_MAX_LENGTH).optional(),
    website: z.string().max(200),
    captchaToken: z.string().trim().min(1).max(4_096),
  })
  .strict();

export const demoRequestSchema = demoRequestInputSchema.transform((input, context) => {
  const phone = normalizePhone(input.phone, input.locale);
  if (phone === null) {
    context.addIssue({ code: "custom", path: ["phone"], message: "Invalid phone" });
    return z.NEVER;
  }

  const withoutPhone = { ...input };
  delete withoutPhone.phone;
  return {
    ...withoutPhone,
    ...(phone === undefined ? {} : { phone }),
  };
});

export type DemoRequestDto = z.infer<typeof demoRequestSchema>;

export const demoRequestAcceptedOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["accepted", "requestId"],
  properties: {
    accepted: { type: "boolean", enum: [true] },
    requestId: { type: "string", format: "uuid" },
  },
};

/** `DemoRequestPublicErrorFilter` reduces every error to this one-field body. */
export function demoRequestErrorOpenApiSchema(...codes: string[]): SchemaObject {
  return {
    type: "object",
    required: ["code"],
    properties: { code: { type: "string", enum: codes } },
  };
}

/** Normalizes only the two locale-specific public phone contracts. */
export function normalizePhone(
  value: string | undefined,
  locale: "ru" | "en",
): string | undefined | null {
  if (value === undefined || value.trim() === "") return undefined;

  const source = value.trim();
  if (!PHONE_PUNCTUATION.test(source)) return null;
  const digits = source.replace(/\D/g, "");

  if (locale === "ru") {
    if (digits.length !== 11) return null;
    if (source.startsWith("8") && digits.startsWith("8")) return `+7${digits.slice(1)}`;
    if (source.startsWith("+7") && digits.startsWith("7")) return `+${digits}`;
    return null;
  }

  if (!source.startsWith("+") || digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}
