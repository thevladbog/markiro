import { z } from "zod";

import { badgeCodeRule, badgeLabelRule } from "../../lib/rules.js";

/** A badge to add: the code a scanner typed, and an optional label. */
export const badgeFormSchema = z.object({ code: badgeCodeRule, label: badgeLabelRule });
export type BadgeFormValues = z.input<typeof badgeFormSchema>;
