export function splitCatalogInterval(
  from: number,
  to: number,
): [[number, number], [number, number]] | null {
  const midpoint = Math.floor((from + to) / 2000) * 1000;
  return midpoint <= from || midpoint >= to
    ? null
    : [
        [from, midpoint],
        [midpoint, to],
      ];
}

/** Provider currently accepts second-precision UTC wall-clock values. Live gate must
 * confirm its interpretation before enabling own-list import in production. */
export function formatCatalogDate(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

import { createHash, randomUUID } from "node:crypto";
import { isValidGtin, normalizeToGtin14 } from "@markiro/domain";
import { z } from "zod";
import type { ChzStatusKey } from "@markiro/platform-contracts";
import type { ImportCheckpoint, ImportItemWrite } from "./national-catalog-import.types";
import type { NationalCatalogListRow, NationalCatalogProduct } from "./national-catalog.types";
const workSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("list"),
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      hashes: z.array(z.string()),
    })
    .strict(),
  z.object({ kind: z.literal("gtins"), gtins: z.array(z.string()).min(1).max(25) }).strict(),
]);
const checkpointSchema = z
  .object({
    version: z.literal(1),
    stepId: z.uuid(),
    runId: z.uuid().nullable(),
    phase: z.enum(["primary", "catch_up", "done"]),
    work: z.array(workSchema),
    failures: z.array(
      z.object({ work: workSchema, reason: z.string(), retryable: z.boolean() }).strict(),
    ),
    attempts: z.number().int().min(0).max(4),
    state: z.enum(["pending", "started", "deferred", "blocked", "failed", "done"]),
    nextRetryAt: z.iso.datetime().nullable(),
    enqueuePending: z.boolean(),
  })
  .strict();
export function parseCheckpoint(value: unknown): ImportCheckpoint {
  return checkpointSchema.parse(value);
}
export function newStep(checkpoint: ImportCheckpoint): ImportCheckpoint {
  return {
    ...checkpoint,
    stepId: randomUUID(),
    runId: null,
    attempts: 0,
    state: "pending",
    nextRetryAt: null,
    enqueuePending: true,
  };
}
export function pageHash(rows: NationalCatalogListRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
export function statuses(status: string | null, details: string[]): ChzStatusKey[] {
  const allowed = new Set<ChzStatusKey>([
    "draft",
    "moderation",
    "errors",
    "unsigned",
    "published",
    "archived",
  ]);
  const result = new Set<ChzStatusKey>();
  for (const raw of [status, ...details]) {
    const mapped = raw === "notsigned" ? "unsigned" : raw;
    if (mapped && allowed.has(mapped as ChzStatusKey)) result.add(mapped as ChzStatusKey);
  }
  return result.size ? [...result] : ["unknown"];
}
export function invalidItem(input: string, cardId: string | null = null): ImportItemWrite {
  return {
    input,
    cardId,
    gtin14: null,
    match: "invalid",
    selectable: false,
    reason: "invalid_gtin",
    statusKeys: ["unknown"],
  };
}
export function listItems(rows: NationalCatalogListRow[]): ImportItemWrite[] {
  return rows.flatMap((row) =>
    (row.gtins.length ? row.gtins : [""]).map((input) => {
      if (!isValidGtin(input))
        return { ...invalidItem(input, row.cardId), name: row.name, brand: row.brand };
      const statusKeys = statuses(row.status, row.detailedStatuses);
      return {
        input: null,
        cardId: row.cardId,
        gtin14: normalizeToGtin14(input),
        name: row.name,
        brand: row.brand,
        statusKeys,
        rawStatus: row.status,
        rawDetailedStatuses: row.detailedStatuses,
        match: "new" as const,
        selectable: !statusKeys.includes("archived"),
        reason: statusKeys.includes("archived") ? "archived_card" : null,
        access: "own" as const,
        source: row.raw,
        sourceHash: pageHash([row]),
      };
    }),
  );
}
export function feedItems(
  products: NationalCatalogProduct[],
  requested: string[],
): ImportItemWrite[] {
  const rows: ImportItemWrite[] = products.flatMap((product) => {
    // Preserve malformed business identifiers. Sound packaging identifiers retain
    // their own card+GTIN identity even when another level was the requested GTIN.
    const listRow: NationalCatalogListRow = {
      cardId: String(product.id),
      gtins: product.identifiers.map((i) => i.value),
      name: product.name,
      brand: null,
      status: product.status,
      detailedStatuses: product.detailedStatuses,
      raw: product.raw,
    };
    return listItems([listRow]).map((row) => ({ ...row, access: null }));
  });
  for (const gtin of requested)
    if (!rows.some((row) => row.gtin14 === gtin)) rows.push(missingItem(gtin, "empty_result"));
  return rows;
}
export function missingItem(gtin: string, reason: string): ImportItemWrite {
  return {
    gtin14: gtin,
    cardId: null,
    input: null,
    match: reason === "not_found" || reason === "empty_result" ? "not_found" : "inaccessible",
    selectable: false,
    reason,
    statusKeys: ["unknown"],
  };
}
