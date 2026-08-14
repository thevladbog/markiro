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
