import { z } from "zod";

import { HostError } from "../../host/client.js";
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

/**
 * The personnel number the host named as similar when it refused `login`
 * (`conflict` on `login` with `details.similarLogin`, plan 2a1): one that
 * differs from it only by leading zeros, which a keypad mixes up. `null` when
 * the refusal is something else, or names the same number, which is simply
 * taken.
 */
export function similarLogin(error: unknown, login: string): string | null {
  if (!(error instanceof HostError) || error.code !== "conflict") return null;
  if (error.details.constraint !== "login") return null;
  const similar = error.details.similarLogin;
  return typeof similar === "string" && similar !== login.trim() ? similar : null;
}
