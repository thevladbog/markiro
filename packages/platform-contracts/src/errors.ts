import { z } from "zod";

import { platformUuidSchema } from "./primitives.js";

export const platformErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(1_000),
    requestId: platformUuidSchema,
  })
  .strict();
export type PlatformError = z.infer<typeof platformErrorSchema>;
