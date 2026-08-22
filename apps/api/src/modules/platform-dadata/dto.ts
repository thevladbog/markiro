export {
  dadataAddressResultSchema,
  dadataBankResultSchema,
  dadataOrganizationResultSchema,
  dadataStatusResponseSchema,
  dadataSuggestionQuerySchema,
} from "@markiro/platform-contracts";

import type { dadataSuggestionQuerySchema } from "@markiro/platform-contracts";
import type { z } from "zod";

export type DadataSuggestionQuery = z.output<typeof dadataSuggestionQuerySchema>;
