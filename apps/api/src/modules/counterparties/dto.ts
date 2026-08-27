import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

import { hasValidCheckDigit } from "@markiro/domain";
import { ssccCounterSchema, type SsccCounterDto } from "../org-profile/dto";

export { ssccCounterSchema };
export type { SsccCounterDto };

/** GS1 GLN: exactly 13 digits with valid check digit. */
const glnSchema = z
  .string()
  .regex(/^\d{13}$/, "gln must be exactly 13 digits")
  .refine((v) => hasValidCheckDigit(v), { message: "GLN check digit is invalid" });

/** GS1 company prefix: 4-12 digits. */
const gs1PrefixSchema = z.string().regex(/^\d{4,12}$/, "gs1Prefixes entries must be 4-12 digits");

/** POST /counterparties schema. */
export const createCounterpartySchema = z.object({
  name: z.string().min(1).max(200),
  gln: glnSchema,
  inn: z.string().nullable().optional(),
  gs1Prefixes: z.array(gs1PrefixSchema).optional(),
  notes: z.string().nullable().optional(),
});
export type CreateCounterpartyDto = z.infer<typeof createCounterpartySchema>;

/** PATCH /counterparties/:id schema. */
export const updateCounterpartySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  gln: glnSchema.optional(),
  inn: z.string().nullable().optional(),
  gs1Prefixes: z.array(gs1PrefixSchema).optional(),
  notes: z.string().nullable().optional(),
});
export type UpdateCounterpartyDto = z.infer<typeof updateCounterpartySchema>;

/** Response DTO for a counterparty. */
export interface CounterpartyDto {
  id: string;
  name: string;
  gln: string;
  inn: string | null;
  gs1Prefixes: string[];
  notes: string | null;
  createdAt: Date;
}

/** GET /counterparties response. */
export interface ListCounterpartiesResponseDto {
  items: CounterpartyDto[];
}

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;

export const counterpartyOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["id", "name", "gln", "inn", "gs1Prefixes", "notes", "createdAt"],
  properties: {
    id: uuidSchema,
    name: { type: "string" },
    gln: { type: "string", pattern: "^\\d{13}$" },
    inn: { type: "string", nullable: true },
    gs1Prefixes: { type: "array", items: { type: "string", pattern: "^\\d{4,12}$" } },
    notes: { type: "string", nullable: true },
    createdAt: dateTimeSchema,
  },
};

export const listCounterpartiesOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["items"],
  properties: { items: { type: "array", items: counterpartyOpenApiSchema } },
};

/**
 * Hand-written mirror of `SsccCounterStateDto` (sscc/dto.ts), which is an
 * interface-only DTO. `blockedBy` is the `SsccSeedBlocker` union or null.
 */
export const ssccCounterStateOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["extensionDigit", "nextSerial", "minSerial", "blockedBy"],
  properties: {
    extensionDigit: { type: "integer", minimum: 0, maximum: 9 },
    nextSerial: {
      type: "integer",
      minimum: 0,
      description: "The value the next serial block will be cut from.",
    },
    minSerial: {
      type: "integer",
      minimum: 0,
      description: "The lowest value PUT will accept right now.",
    },
    blockedBy: {
      nullable: true,
      description: "Why an admin currently cannot reseed this counter; null when nothing blocks.",
      oneOf: [
        {
          type: "object",
          required: ["kind", "shiftId", "shiftNumber"],
          properties: {
            kind: { type: "string", enum: ["active_shift"] },
            shiftId: uuidSchema,
            shiftNumber: { type: "string" },
          },
        },
        {
          type: "object",
          required: ["kind", "deviceId", "deviceName"],
          properties: {
            kind: { type: "string", enum: ["device_out_of_sync"] },
            deviceId: uuidSchema,
            deviceName: { type: "string" },
          },
        },
      ],
    },
  },
};
