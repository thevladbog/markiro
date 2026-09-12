import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

/**
 * GET /pallets query schema. Mirrors `listBoxesQuerySchema` (boxes/dto.ts): a
 * pallet list only ever makes sense scoped to one shift, so `shiftId` is
 * required.
 */
export const listPalletsQuerySchema = z.object({
  shiftId: z.string().uuid(),
});
export type ListPalletsQueryDto = z.infer<typeof listPalletsQuerySchema>;

/**
 * Mirrors one `pallets` row plus a live aggregate over its member `boxes`
 * (and, through them, `box_items`):
 *
 * - `boxCount` counts member boxes (`boxes.palletId = pallets.id`, Task 9)
 *   that are closed and not disassembled. A box's `palletId` is written in
 *   the SAME statement as its own closure (see boxes.palletId's own schema
 *   comment), so a member box is always closed already; the `closedAt`
 *   filter stays anyway to say "closed" rather than merely "not yet
 *   disassembled" -- see PalletsService.listPallets. A disassembled box is
 *   physically OFF the stack (taking a pallet apart takes boxes off it, it
 *   does not open them), so it is excluded here even though it keeps its
 *   `palletId`.
 * - `unitCount` sums the live items (`displaced_at IS NULL AND removed_at IS
 *   NULL`, exactly as BoxesService counts a box's own `itemCount`) of every
 *   box counted in `boxCount` -- a disassembled box's items are off the
 *   stack along with it, so they do not count towards the pallet either.
 * - `contentsChangedAfterClose` is true when a member box was disassembled
 *   AFTER this pallet's own `closureReceivedAt` (server-assigned, at the
 *   same statement as the pallet's `closedAt`/`sscc`) -- never the
 *   device-supplied `closedAt`, whose clock has no skew bound (see
 *   `pallets.closureReceivedAt`'s own schema comment, and BoxesService's
 *   identical reasoning for its own flag). A closed, labelled pallet cannot
 *   be corrected, so this is the only way a manager learns it left a box
 *   short. Unlike `boxCount`/`unitCount`, this looks at EVERY member box
 *   regardless of its own disassembled state -- it is the disassembly
 *   itself that must be detected.
 * - `disassembledAt` mirrors the pallet's own retirement
 *   (`applyPalletExceptions`'s "disassemble" branch): non-null once an
 *   operator has taken the closed pallet apart.
 */
export interface PalletDto {
  id: string;
  /** 20-значный код с GS1 AI "00"; в БД хранится голый 18-значный SSCC. */
  sscc: string | null;
  terminalId: string | null;
  /** Assigned production line of the station that reported this pallet. */
  lineName: string | null;
  operatorId: string | null;
  boxCount: number;
  unitCount: number;
  closedAt: Date | null;
  contentsChangedAfterClose: boolean;
  disassembledAt: Date | null;
}

/** GET /pallets response. */
export interface ListPalletsResponseDto {
  items: PalletDto[];
}

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;
const aiSsccSchema = {
  type: "string",
  pattern: "^00[0-9]{18}$",
  description: "AI-00-prefixed 20-digit SSCC, as everywhere cabinet-facing.",
} as const;

export const palletOpenApiSchema: SchemaObject = {
  type: "object",
  required: [
    "id",
    "sscc",
    "terminalId",
    "lineName",
    "operatorId",
    "boxCount",
    "unitCount",
    "closedAt",
    "contentsChangedAfterClose",
    "disassembledAt",
  ],
  properties: {
    id: uuidSchema,
    sscc: { ...aiSsccSchema, nullable: true },
    terminalId: { type: "string", nullable: true },
    lineName: {
      type: "string",
      nullable: true,
      description: "Assigned production line of the station that reported this pallet.",
    },
    operatorId: { type: "string", nullable: true },
    boxCount: { type: "integer", minimum: 0 },
    unitCount: { type: "integer", minimum: 0 },
    closedAt: { ...dateTimeSchema, nullable: true },
    contentsChangedAfterClose: {
      type: "boolean",
      description:
        "True when a member box was disassembled after the pallet closed: the closed, labelled pallet is short a box it can no longer physically correct.",
    },
    disassembledAt: { ...dateTimeSchema, nullable: true },
  },
};

export const listPalletsOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["items"],
  properties: { items: { type: "array", items: palletOpenApiSchema } },
};
