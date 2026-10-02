import {
  usLotCardEvidenceCursorSchema,
  usLotCardEvidenceQuerySchema,
  usTraceSearchCursorSchema,
  usTraceSearchQuerySchema,
  type UsLotCardEvidenceQuery,
  type UsTraceSearchQuery,
} from "@markiro/platform-contracts";
import { BadRequestException } from "@nestjs/common";
import type { z } from "zod";

const invalidQuery = () => new BadRequestException({ code: "us_invalid_query" });

function parseQuery<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalidQuery();
  return parsed.data;
}

function decodeCursor<T>(raw: string | undefined, schema: z.ZodType<T>): T | null {
  if (raw === undefined) return null;
  try {
    const decoded = Buffer.from(raw, "base64url");
    if (decoded.length > 384 || decoded.toString("base64url") !== raw) throw invalidQuery();
    return parseQuery(schema, JSON.parse(decoded.toString("utf8")));
  } catch {
    throw invalidQuery();
  }
}

/** Controller rejects duplicate URL keys before passing the raw query object. */
export function parseUsTraceSearchQuery(raw: unknown): UsTraceSearchQuery {
  const { cursor, ...filters } = parseQuery(usTraceSearchQuerySchema, raw);
  return { ...filters, cursor: decodeCursor(cursor, usTraceSearchCursorSchema) };
}

export function parseUsLotCardEvidenceQuery(raw: unknown): UsLotCardEvidenceQuery {
  const { cursor, ...filters } = parseQuery(usLotCardEvidenceQuerySchema, raw);
  return { ...filters, cursor: decodeCursor(cursor, usLotCardEvidenceCursorSchema) };
}
