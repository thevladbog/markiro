import { z } from "zod";

import { operatorLoginRule, operatorRoleRule, personNameRule, pinRule } from "../../lib/rules.js";

const pinRepeated = { message: "rules.pinConfirm", path: ["pinConfirm"] };

/** A new operator; `pinConfirm` repeats the PIN. */
export const newOperatorSchema = z
  .object({
    login: operatorLoginRule,
    name: personNameRule,
    role: operatorRoleRule,
    pin: pinRule,
    pinConfirm: z.string().trim(),
  })
  .refine((values) => values.pin === values.pinConfirm, pinRepeated);
export type NewOperatorValues = z.input<typeof newOperatorSchema>;

/** An operator's name and role; the personnel number never changes. */
export const operatorEditSchema = z.object({ name: personNameRule, role: operatorRoleRule });
export type OperatorEditValues = z.input<typeof operatorEditSchema>;

/** A new PIN and its repeat. */
export const pinFormSchema = z
  .object({ pin: pinRule, pinConfirm: z.string().trim() })
  .refine((values) => values.pin === values.pinConfirm, pinRepeated);
export type PinFormValues = z.input<typeof pinFormSchema>;
