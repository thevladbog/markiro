import { z } from "zod";

/** Personnel number typed on the station keypad — digits only. */
const loginSchema = z
  .string()
  .trim()
  .regex(/^\d{3,12}$/, "login must be 3-12 digits");
/** Floor PIN — digits only; the station's verifier requires at least 4. */
const pinSchema = z
  .string()
  .trim()
  .regex(/^\d{4,6}$/, "pin must be 4-6 digits");

export const grantStationAccessSchema = z.object({ login: loginSchema, pin: pinSchema });
export type GrantStationAccessDto = z.infer<typeof grantStationAccessSchema>;

export const updateStationAccessSchema = z
  .object({
    login: loginSchema.optional(),
    pin: pinSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });
export type UpdateStationAccessDto = z.infer<typeof updateStationAccessSchema>;

/** Station access as returned to the admin — never carries the PIN or its hash. */
export interface StationAccessDto {
  employeeId: string;
  login: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OperatorListItemDto {
  employeeId: string;
  fullName: string;
  role: string | null;
  login: string;
  active: boolean;
  hasBadge: boolean;
}

export interface ListOperatorsResponseDto {
  items: OperatorListItemDto[];
}
