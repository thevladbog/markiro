import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

/**
 * GET /pallets query schema. `shiftId` used to be REQUIRED, because every
 * pallet belonged to exactly one shift. A warehouse pallet belongs to none
 * (`pallets.shift_id IS NULL`, see its own schema comment), so it is
 * unreachable through any per-shift list at all: the list became org-wide
 * with `shiftId` as one filter among several. The 404 on an unknown shift is
 * kept for exactly the case that still has one -- see
 * `PalletsService.listPallets`.
 *
 * `limit` + `cursor` are a keyset page over the list's own
 * `closed_at DESC NULLS FIRST, id ASC` order: an org-wide list spans every
 * shift of a tenant's whole history, which OFFSET paging walks from the top
 * on every page.
 */
export const listPalletsQuerySchema = z
  .object({
    shiftId: z.string().uuid().optional(),
    kind: z.enum(["production", "warehouse"]).optional(),
    productId: z.string().uuid().optional(),
    deviceId: z.string().uuid().optional(),
    closedFrom: z.string().datetime().optional(),
    closedTo: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().min(1).max(256).optional(),
  })
  .strict();
export type ListPalletsQueryDto = z.infer<typeof listPalletsQuerySchema>;

/** The last row of the previous page, in the list's own sort order. */
export interface PalletListCursor {
  closedAt: string | null;
  id: string;
}

export function encodePalletListCursor(cursor: PalletListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * A cursor is server-issued, so anything that does not decode back to the
 * exact bytes this server would have produced is a client error rather than
 * something to interpret. The canonical re-encode check keeps a hand-edited
 * or padded value from silently paging from somewhere else.
 */
export function decodePalletListCursor(raw: string): PalletListCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const cursor = z
      .object({ closedAt: z.string().datetime().nullable(), id: z.string().uuid() })
      .strict()
      .parse(parsed);
    if (encodePalletListCursor(cursor) !== raw) throw new Error("non-canonical");
    return cursor;
  } catch {
    throw new BadRequestException({
      code: "invalid_cursor",
      message: "Invalid pallet list cursor",
    });
  }
}

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
  /** `warehouse` is built on a handheld from closed boxes of arbitrary shifts. */
  kind: "production" | "warehouse";
  /**
   * `coalesce(pallets.product_id, shifts.product_id)`: a warehouse pallet
   * carries its own product (its homogeneity rule), a production one reaches
   * it through its shift, exactly as a box does.
   */
  productId: string | null;
  productName: string | null;
  /** Name of the station/handheld that reported this pallet, when resolvable. */
  deviceName: string | null;
  /**
   * How many memberships the server refused for this pallet
   * (`pallet_membership_rejections`, spec §1.4). Always 0 for a production
   * pallet, whose boxes join it through their own closure.
   */
  rejectedMembershipCount: number;
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

/** GET /pallets response. `nextCursor` is absent on the last page. */
export interface ListPalletsResponseDto {
  items: PalletDto[];
  nextCursor?: string;
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
    "kind",
    "productId",
    "productName",
    "deviceName",
    "rejectedMembershipCount",
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
    kind: {
      type: "string",
      enum: ["production", "warehouse"],
      description: "A warehouse pallet belongs to no shift and carries its own product.",
    },
    productId: { ...uuidSchema, nullable: true },
    productName: { type: "string", nullable: true },
    deviceName: { type: "string", nullable: true },
    rejectedMembershipCount: {
      type: "integer",
      minimum: 0,
      description: "Memberships the server refused for this pallet (pallet_membership_rejections).",
    },
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
  properties: {
    items: { type: "array", items: palletOpenApiSchema },
    nextCursor: {
      type: "string",
      description: "Pass back as `cursor` for the next page; absent on the last one.",
    },
  },
};
