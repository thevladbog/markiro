import { US_CAPABILITY, type UsCapability } from "@markiro/domain";
import { z } from "zod";

const usCapabilitySchema = z.enum(US_CAPABILITY);

export const usTraceabilityAccessSchema = z
  .object({
    capabilities: z
      .array(usCapabilitySchema)
      .max(9)
      .refine((capabilities) => new Set(capabilities).size === capabilities.length),
  })
  .strict();

export type UsTraceabilityAccess = {
  capabilities: UsCapability[];
};
