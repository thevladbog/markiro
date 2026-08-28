import type { SchemaObject } from "@nestjs/swagger";
import { z } from "zod";

export const createKioskSchema = z.object({
  name: z.string().trim().min(1).max(200),
  location: z.string().trim().min(1).max(200).nullable().optional(),
  dayLimitPerEmployee: z.number().int().min(1).default(5),
  showPrices: z.boolean().default(true),
  printEmployeeQrOnSlip: z.boolean().default(false),
});
export type CreateKioskDto = z.infer<typeof createKioskSchema>;

export const updateKioskSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  location: z.string().trim().min(1).max(200).nullable().optional(),
  dayLimitPerEmployee: z.number().int().min(1).optional(),
  showPrices: z.boolean().optional(),
  printEmployeeQrOnSlip: z.boolean().optional(),
  status: z.enum(["active", "archived"]).optional(),
});
export type UpdateKioskDto = z.infer<typeof updateKioskSchema>;

/** `POST /kiosks/:id/unbind` has no request body and responds with 204. */
export type UnbindKioskResponseDto = void;

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
  printEmployeeQrOnSlip: boolean;
  status: "active" | "archived";
  lastSeenAt: Date | null;
  enrolled: boolean;
  productIds: string[];
  createdAt: Date;
}
export interface ListKiosksResponseDto {
  items: KioskDto[];
}
export interface EnrollKioskResponseDto {
  token: string;
}

// Re-exported so the controller can import every route DTO from this one
// module; `PairingService` (../kiosk/pairing.service.ts) stays the single
// source of truth for the shape.
export type { IssuePairingCodeResultDto } from "../kiosk/pairing.service";

// --- OpenAPI response schemas (hand-written: the response DTOs above are ---
// --- interfaces, not zod schemas; see inventories/dto.ts for the pattern) ---

export const kioskOpenApiSchema: SchemaObject = {
  type: "object",
  required: [
    "id",
    "name",
    "location",
    "dayLimitPerEmployee",
    "showPrices",
    "printEmployeeQrOnSlip",
    "status",
    "lastSeenAt",
    "enrolled",
    "productIds",
    "createdAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    location: { type: "string", nullable: true },
    dayLimitPerEmployee: { type: "integer", minimum: 1 },
    showPrices: { type: "boolean" },
    printEmployeeQrOnSlip: { type: "boolean" },
    status: { type: "string", enum: ["active", "archived"] },
    lastSeenAt: { type: "string", format: "date-time", nullable: true },
    enrolled: { type: "boolean", description: "True while a device credential is active." },
    productIds: { type: "array", items: { type: "string", format: "uuid" } },
    createdAt: { type: "string", format: "date-time" },
  },
};

export const listKiosksOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["items"],
  properties: { items: { type: "array", items: kioskOpenApiSchema } },
};
