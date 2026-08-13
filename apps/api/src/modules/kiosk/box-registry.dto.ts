import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURSOR_MAX_LENGTH = 1024;

const isoInstantSchema = z
  .string()
  .regex(ISO_INSTANT)
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  }, "must be a canonical UTC ISO instant");

export const boxRegistryQuerySchema = z
  .object({
    since: isoInstantSchema.optional(),
    until: isoInstantSchema.optional(),
    cursor: z.string().min(1).max(CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(250),
  })
  .strict();

export type BoxRegistryQueryDto = z.infer<typeof boxRegistryQuerySchema>;

const cursorSchema = z
  .object({
    v: z.literal(1),
    since: isoInstantSchema.nullable(),
    until: isoInstantSchema,
    updatedAt: isoInstantSchema,
    id: z.string().uuid(),
  })
  .strict();

export type BoxRegistryCursor = z.infer<typeof cursorSchema>;

export interface ResolvedBoxRegistryWindow {
  since: string | null;
  until: string;
  afterUpdatedAt: string | null;
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
  serverNow: string,
): ResolvedBoxRegistryWindow {
  const now = isoInstantSchema.parse(serverNow);
  if (!query.cursor) {
    if (query.until !== undefined) {
      throw new BadRequestException("Box registry until is server-assigned on the first page");
    }
    const until = now;
    if (query.since && Date.parse(query.since) > Date.parse(until)) {
      throw new BadRequestException("Box registry since must not exceed until");
    }
    return {
      since: query.since ?? null,
      until,
      afterUpdatedAt: null,
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
    Date.parse(cursor.until) > Date.parse(now) ||
    Date.parse(cursor.updatedAt) > Date.parse(cursor.until) ||
    (cursor.since !== null && Date.parse(cursor.since) > Date.parse(cursor.updatedAt))
  ) {
    throw badCursor();
  }
  return {
    since: cursor.since,
    until: cursor.until,
    afterUpdatedAt: cursor.updatedAt,
    afterId: cursor.id,
    limit: query.limit,
  };
}

export type KioskBoxRegistryChange =
  | {
      kind: "upsert";
      boxId: string;
      sscc: string;
      productId: string;
      bottleCount: number;
      contentKeys: string[];
      updatedAt: string;
    }
  | { kind: "remove"; sscc: string; updatedAt: string };

export interface KioskBoxRegistryPage {
  until: string;
  items: KioskBoxRegistryChange[];
  nextCursor?: string;
}
