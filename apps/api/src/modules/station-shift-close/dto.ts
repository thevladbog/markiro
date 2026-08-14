import { z } from "zod";
import { isShiftCloseReasonCode, type ShiftCloseReasonCode } from "@markiro/domain";

const uuid = z.string().uuid();

export const stationShiftCloseSchema = z
  .object({
    eventId: uuid,
    shiftId: uuid,
    operatorId: uuid.nullable().optional(),
    plannedQtySnapshot: z.number().int().min(0).nullable(),
    actualQty: z.number().int().min(0),
    closedBoxCount: z.number().int().min(0),
    reasonCode: z.string().nullable().optional(),
    closedAt: z.coerce.date(),
  })
  .superRefine((value, ctx) => {
    const required = value.plannedQtySnapshot !== null && value.plannedQtySnapshot !== value.actualQty;
    if (required && (!value.reasonCode || !isShiftCloseReasonCode(value.reasonCode))) {
      ctx.addIssue({ code: "custom", path: ["reasonCode"], message: "A valid close reason is required" });
    }
    if (!required && value.reasonCode !== undefined && value.reasonCode !== null && !isShiftCloseReasonCode(value.reasonCode)) {
      ctx.addIssue({ code: "custom", path: ["reasonCode"], message: "Unknown close reason" });
    }
  });
export type StationShiftCloseDto = z.infer<typeof stationShiftCloseSchema> & {
  reasonCode?: ShiftCloseReasonCode | null;
};

export interface StationShiftCloseResponseDto {
  outcome: "accepted" | "already_resolved" | "conflict";
  conflictCode?: "multiple_devices";
}

export interface ShiftCloseConflictDto {
  eventId: string;
  shiftId: string;
  productName: string | null;
  deviceId: string;
  operatorId: string | null;
  plannedQtySnapshot: number | null;
  actualQty: number;
  closedBoxCount: number;
  reasonCode: string | null;
  closedAt: Date;
  recordedAt: Date;
  conflictCode: string | null;
}

export interface ShiftCloseConflictListDto {
  items: ShiftCloseConflictDto[];
}
