import { z } from "zod";

export const createKioskSchema = z.object({
  name: z.string().trim().min(1).max(200),
  location: z.string().trim().min(1).max(200).nullable().optional(),
  dayLimitPerEmployee: z.number().int().min(1).default(5),
  showPrices: z.boolean().default(true),
});
export type CreateKioskDto = z.infer<typeof createKioskSchema>;

export const updateKioskSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  location: z.string().trim().min(1).max(200).nullable().optional(),
  dayLimitPerEmployee: z.number().int().min(1).optional(),
  showPrices: z.boolean().optional(),
  status: z.enum(["active", "archived"]).optional(),
});
export type UpdateKioskDto = z.infer<typeof updateKioskSchema>;

export const setKioskProductsSchema = z.object({
  productIds: z.array(z.string().uuid()),
});
export type SetKioskProductsDto = z.infer<typeof setKioskProductsSchema>;

export interface KioskDto {
  id: string;
  name: string;
  location: string | null;
  dayLimitPerEmployee: number;
  showPrices: boolean;
  status: "active" | "archived";
  lastSeenAt: Date | null;
  enrolled: boolean;
  productIds: string[];
  createdAt: Date;
}
export interface ListKiosksResponseDto { items: KioskDto[]; }
export interface EnrollKioskResponseDto { token: string; }
