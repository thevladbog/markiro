import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

import { parseScannedSscc } from "@markiro/domain";

/**
 * GET /boxes query schema. A box list only ever makes sense scoped to one
 * shift (there is no cross-shift "all my boxes" view), so `shiftId` is
 * required, unlike `/conflicts`'s optional filter.
 */
export const listBoxesQuerySchema = z.object({
  shiftId: z.string().uuid(),
});
export type ListBoxesQueryDto = z.infer<typeof listBoxesQuerySchema>;

/**
 * Mirrors one `boxes` row (Task 3, corrected in Task 10/13) plus a live
 * aggregate over its `box_items`:
 *
 * - `itemCount` counts only items this box's own scans still own AND that no
 *   operator exception has removed (`displaced_at IS NULL AND removed_at IS
 *   NULL`, Task 7) -- `box_items` rows are never deleted, so a naive
 *   `COUNT(*)` would include a code some other scan has since claimed
 *   (`displaced_at`) or one an "undo"/"clear"/"disassemble" exception has
 *   released (`removed_at`) (see BoxesService.listBoxes and boxItems' own
 *   schema comment).
 * - `contentsChangedAfterClose` is true when the box has an item whose
 *   `displaced_at` is later than its `closed_at`. A closed box is taped and
 *   labelled and cannot be corrected, so this is the only way a manager
 *   finds out it is one position short.
 * - `disassembledAt` (Task 7) mirrors the box's own retirement (see
 *   station-scans.service.ts's "disassemble" branch): non-null once an
 *   operator has retired an already-closed box, so a cabinet UI can exclude
 *   it from an "active boxes" view.
 */
export interface BoxDto {
  id: string;
  /** 20-значный код с GS1 AI "00" (требование Честного знака); в БД хранится голый 18-значный SSCC. */
  sscc: string | null;
  terminalId: string | null;
  /** Assigned production line of the station that reported this box. */
  lineName: string | null;
  operatorId: string | null;
  itemCount: number;
  closedAt: Date | null;
  contentsChangedAfterClose: boolean;
  disassembledAt: Date | null;
}

/** GET /boxes response. */
export interface ListBoxesResponseDto {
  items: BoxDto[];
}

/**
 * GET /boxes/sell-codes query. Accepts whatever the cashier's camera or
 * keyboard produced -- `parseScannedSscc` strips the `]C1` AIM prefix,
 * a printed `(00)` and the bare `00` AI, and validates the check digit --
 * so the stored bare-18-digit form is what reaches the service.
 */
export const sellCodesQuerySchema = z.object({
  sscc: z.string().transform((value, ctx) => {
    const parsed = parseScannedSscc(value.trim());
    if (parsed === null) {
      ctx.addIssue({ code: "custom", message: "invalid_sscc" });
      return z.NEVER;
    }
    return parsed;
  }),
});
export type SellCodesQueryDto = z.infer<typeof sellCodesQuerySchema>;

/** One live code of a sellable box; `rawKm` feeds `renderDataMatrixSvg` client-side. */
export interface BoxSellCodeItemDto {
  codeHash: string;
  rawKm: string;
  gtin14: string;
  serial: string;
}

/** GET /boxes/sell-codes response. `sscc` is AI-00-prefixed (20 digits), as everywhere cabinet-facing. */
export interface BoxSellCodesDto {
  boxId: string;
  sscc: string;
  productName: string;
  itemCount: number;
  items: BoxSellCodeItemDto[];
}

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;
const aiSsccSchema = {
  type: "string",
  pattern: "^00[0-9]{18}$",
  description: "AI-00-prefixed 20-digit SSCC, as everywhere cabinet-facing.",
} as const;

export const boxOpenApiSchema: SchemaObject = {
  type: "object",
  required: [
    "id",
    "sscc",
    "terminalId",
    "lineName",
    "operatorId",
    "itemCount",
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
      description: "Assigned production line of the station that reported this box.",
    },
    operatorId: { type: "string", nullable: true },
    itemCount: { type: "integer", minimum: 0 },
    closedAt: { ...dateTimeSchema, nullable: true },
    contentsChangedAfterClose: {
      type: "boolean",
      description:
        "True when an item was displaced after the box closed: the taped, labelled box is short a position it can no longer physically correct.",
    },
    disassembledAt: { ...dateTimeSchema, nullable: true },
  },
};

export const listBoxesOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["items"],
  properties: { items: { type: "array", items: boxOpenApiSchema } },
};

export const boxSellCodeItemOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["codeHash", "rawKm", "gtin14", "serial"],
  properties: {
    codeHash: { type: "string" },
    rawKm: {
      type: "string",
      description: "Raw KM payload; feeds DataMatrix rendering client-side.",
    },
    gtin14: { type: "string", pattern: "^[0-9]{14}$" },
    serial: { type: "string" },
  },
};

export const boxSellCodesOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["boxId", "sscc", "productName", "itemCount", "items"],
  properties: {
    boxId: uuidSchema,
    sscc: aiSsccSchema,
    productName: { type: "string" },
    itemCount: { type: "integer", minimum: 1 },
    items: { type: "array", items: boxSellCodeItemOpenApiSchema },
  },
};
