import type { UsPlanSections } from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";

const text = z.string().max(4096);
const texts = z.array(text).max(50);

export const usPlanSectionsSchema = z
  .object({
    recordMaintenance: z
      .object({
        systemOfRecord: text,
        formats: texts,
        recordLocations: texts,
        responsibleRoles: texts,
        backupAndRecovery: text,
        narrative: texts,
      })
      .strict(),
    ftlIdentification: z.object({ procedure: text, reviewCadence: text }).strict(),
    tlcAssignment: z.object({ procedure: text }).strict(),
    pointOfContact: z
      .object({ name: text, title: text, phone: text, email: text.nullable() })
      .strict(),
    farmActivity: z
      .object({ status: z.enum(["no", "yes", "unknown"]), explanation: text })
      .strict(),
    reviewAndUpdate: z.object({ procedure: text }).strict(),
  })
  .strict() satisfies z.ZodType<UsPlanSections>;

export const usPlanDraftSaveBodySchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    changeSummary: text,
    sections: usPlanSectionsSchema,
  })
  .strict();

export const usPlanApproveBodySchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    idempotencyKey: platformUuidSchema,
    confirmations: z
      .object({
        procedures: z.boolean(),
        backupAndRecovery: z.boolean(),
        contact: z.boolean(),
        nonFarmScope: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type UsPlanSectionsBody = z.infer<typeof usPlanSectionsSchema>;
export type UsPlanDraftSaveBody = z.infer<typeof usPlanDraftSaveBodySchema>;
export type UsPlanApproveBody = z.infer<typeof usPlanApproveBodySchema>;
