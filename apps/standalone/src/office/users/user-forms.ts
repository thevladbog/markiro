import { z } from "zod";

import { officeRoleSchema } from "../../host/protocol.js";
import { loginRule, passwordRule, personNameRule } from "../../lib/rules.js";

const repeated = { message: "rules.passwordConfirm", path: ["confirm"] };

/** A new office user; `confirm` repeats the password. */
export const newUserSchema = z
  .object({
    login: loginRule,
    name: personNameRule,
    role: officeRoleSchema,
    password: passwordRule,
    confirm: z.string(),
  })
  .refine((values) => values.password === values.confirm, repeated);
export type NewUserValues = z.input<typeof newUserSchema>;

/** Name, role and access of an existing office user. */
export const userEditSchema = z.object({
  name: personNameRule,
  role: officeRoleSchema,
  active: z.boolean(),
});
export type UserEditValues = z.input<typeof userEditSchema>;

/** A password an administrator sets for someone else. */
export const passwordSetFormSchema = z
  .object({ password: passwordRule, confirm: z.string() })
  .refine((values) => values.password === values.confirm, repeated);
export type PasswordSetValues = z.input<typeof passwordSetFormSchema>;
