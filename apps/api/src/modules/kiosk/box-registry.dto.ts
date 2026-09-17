import type { SchemaObject } from "@nestjs/swagger";
import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const CURSOR_MAX_LENGTH = 1024;
const MAX_PG_BIGINT = 9_223_372_036_854_775_807n;
export const BOX_REGISTRY_REVISION_PATTERN = "^(0|[1-9][0-9]*)$";

function isCanonicalRevision(value: string): boolean {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) return false;
  try {
    return BigInt(value) <= MAX_PG_BIGINT;
  } catch {
    return false;
  }
}

export const boxRegistryRevisionSchema = z
  .string()
  .refine(isCanonicalRevision, "must be a canonical unsigned bigint revision");

export const boxRegistryQuerySchema = z
  .object({
    since: boxRegistryRevisionSchema.optional(),
    until: boxRegistryRevisionSchema.optional(),
    cursor: z.string().min(1).max(CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(250),
  })
  .strict();

export type BoxRegistryQueryDto = z.infer<typeof boxRegistryQuerySchema>;

const cursorSchema = z
  .object({
    v: z.literal(2),
    since: boxRegistryRevisionSchema.nullable(),
    until: boxRegistryRevisionSchema,
    registryVersion: boxRegistryRevisionSchema,
    id: z.string().uuid(),
  })
  .strict();

export type BoxRegistryCursor = z.infer<typeof cursorSchema>;

export interface ResolvedBoxRegistryWindow {
  since: string | null;
  until: string;
  afterRegistryVersion: string | null;
  afterId: string | null;
  limit: number;
}

function badCursor(): BadRequestException {
  return new BadRequestException("Invalid box registry cursor");
}

export function encodeBoxRegistryCursor(value: BoxRegistryCursor): string {
  const canonical = cursorSchema.parse(value);
  return Buffer.from(JSON.stringify(canonical), "utf8").toString("base64url");
}

export function decodeBoxRegistryCursor(raw: string): BoxRegistryCursor {
  if (raw.length === 0 || raw.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw badCursor();
  }
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw badCursor();
    const parsed = cursorSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
    if (encodeBoxRegistryCursor(parsed) !== raw) throw badCursor();
    return parsed;
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw badCursor();
  }
}

export function resolveBoxRegistryWindow(
  query: BoxRegistryQueryDto,
  committedVersion: string,
): ResolvedBoxRegistryWindow {
  query = boxRegistryQuerySchema.parse(query);
  const current = boxRegistryRevisionSchema.parse(committedVersion);
  if (!query.cursor) {
    if (query.until !== undefined) {
      throw new BadRequestException("Box registry until is server-assigned on the first page");
    }
    if (query.since && BigInt(query.since) > BigInt(current)) {
      throw new BadRequestException("Box registry since must not exceed until");
    }
    return {
      since: query.since ?? null,
      until: current,
      afterRegistryVersion: null,
      afterId: null,
      limit: query.limit,
    };
  }

  const cursor = decodeBoxRegistryCursor(query.cursor);
  const parameterSince = query.since ?? null;
  if (query.until !== cursor.until || parameterSince !== cursor.since) {
    throw new BadRequestException("Box registry cursor bounds do not match query parameters");
  }
  if (
    BigInt(cursor.until) > BigInt(current) ||
    BigInt(cursor.registryVersion) > BigInt(cursor.until) ||
    (cursor.since !== null && BigInt(cursor.since) > BigInt(cursor.registryVersion))
  ) {
    throw badCursor();
  }
  return {
    since: cursor.since,
    until: cursor.until,
    afterRegistryVersion: cursor.registryVersion,
    afterId: cursor.id,
    limit: query.limit,
  };
}

/**
 * The kiosk feed's upsert item. Deployed kiosk PWAs parse this with a strict
 * key allowlist (`apps/kiosk/src/store/box-registry.ts`) and throw on any
 * unknown key, so these seven fields are frozen: never widen this shape.
 */
export interface KioskBoxRegistryUpsert {
  kind: "upsert";
  boxId: string;
  sscc: string;
  productId: string;
  bottleCount: number;
  contentKeys: string[];
  updatedAt: string;
}

/** The station/handheld feed adds pallet placement; its JSON ignores unknown keys. */
export interface StationBoxRegistryUpsert extends KioskBoxRegistryUpsert {
  /** The pallet this box stands on, or last stood on. */
  palletId: string | null;
  /** Raw 18 digits, not AI-00 formatted: this feed is device-facing. */
  palletSscc: string | null;
  /** False once that pallet is disassembled, so the box is free again. */
  palletActive: boolean;
  closedAt: string;
  /** `YYYY-MM-DD` civil day, null when the shift declares neither. */
  productionDate: string | null;
}

export interface BoxRegistryRemoval {
  kind: "remove";
  sscc: string;
  updatedAt: string;
}

export type KioskBoxRegistryChange = KioskBoxRegistryUpsert | BoxRegistryRemoval;
export type StationBoxRegistryChange = StationBoxRegistryUpsert | BoxRegistryRemoval;

export interface KioskBoxRegistryPage {
  until: string;
  items: KioskBoxRegistryChange[];
  nextCursor?: string;
}

export interface StationBoxRegistryPage {
  until: string;
  items: StationBoxRegistryChange[];
  nextCursor?: string;
}

/** Narrows a station change to the frozen kiosk shape, dropping pallet fields. */
export function toKioskChange(change: StationBoxRegistryChange): KioskBoxRegistryChange {
  if (change.kind === "remove") return change;
  return {
    kind: "upsert",
    boxId: change.boxId,
    sscc: change.sscc,
    productId: change.productId,
    bottleCount: change.bottleCount,
    contentKeys: change.contentKeys,
    updatedAt: change.updatedAt,
  };
}

export function toKioskPage(page: StationBoxRegistryPage): KioskBoxRegistryPage {
  return {
    until: page.until,
    items: page.items.map(toKioskChange),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

export type BoxRegistryView = "kiosk" | "station";

/**
 * The 200 body of a box-registry page. Both routes share this builder so the
 * kiosk and station documents cannot drift in everything but the pallet block;
 * `view` decides whether that block is documented at all.
 */
function boxRegistryPageOpenApiSchemaFor(view: BoxRegistryView): SchemaObject {
  const palletRequired =
    view === "station"
      ? ["palletId", "palletSscc", "palletActive", "closedAt", "productionDate"]
      : [];
  const palletProperties: Record<string, SchemaObject> =
    view === "station"
      ? {
          palletId: { type: "string", format: "uuid", nullable: true },
          palletSscc: { type: "string", pattern: "^[0-9]{18}$", nullable: true },
          palletActive: { type: "boolean" },
          closedAt: { type: "string", format: "date-time" },
          productionDate: { type: "string", format: "date", nullable: true },
        }
      : {};
  return {
    type: "object",
    required: ["until", "items"],
    properties: {
      until: { type: "string", pattern: BOX_REGISTRY_REVISION_PATTERN },
      nextCursor: { type: "string" },
      items: {
        type: "array",
        items: {
          oneOf: [
            {
              type: "object",
              required: [
                "kind",
                "boxId",
                "sscc",
                "productId",
                "bottleCount",
                "contentKeys",
                "updatedAt",
                ...palletRequired,
              ],
              properties: {
                kind: { type: "string", enum: ["upsert"] },
                boxId: { type: "string", format: "uuid" },
                sscc: { type: "string", pattern: "^[0-9]{18}$" },
                productId: { type: "string", format: "uuid" },
                bottleCount: { type: "integer", minimum: 1, maximum: 500 },
                contentKeys: {
                  type: "array",
                  maxItems: 500,
                  items: { type: "string" },
                },
                updatedAt: { type: "string", format: "date-time" },
                ...palletProperties,
              },
            },
            {
              type: "object",
              required: ["kind", "sscc", "updatedAt"],
              properties: {
                kind: { type: "string", enum: ["remove"] },
                sscc: { type: "string", pattern: "^[0-9]{18}$" },
                updatedAt: { type: "string", format: "date-time" },
              },
            },
          ],
        },
      },
    },
  };
}

export const kioskBoxRegistryPageOpenApiSchema: SchemaObject =
  boxRegistryPageOpenApiSchemaFor("kiosk");

export const stationBoxRegistryPageOpenApiSchema: SchemaObject =
  boxRegistryPageOpenApiSchemaFor("station");
