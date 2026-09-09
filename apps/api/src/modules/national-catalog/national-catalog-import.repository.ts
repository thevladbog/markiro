import { schema, type Db } from "@markiro/db";
import { and, arrayOverlaps, asc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { ImportItemsQuery } from "@markiro/platform-contracts";
import type {
  DbTx,
  ImportItemRow,
  ImportItemWrite,
  ImportSessionRow,
} from "./national-catalog-import.types";

const sessions = schema.nationalCatalogImportSessions;
const items = schema.nationalCatalogImportItems;
const scope = (tenantId: string, sessionId: string) =>
  and(eq(items.tenantId, tenantId), eq(items.sessionId, sessionId));
export class NationalCatalogImportRepository {
  constructor(private readonly db: Db) {}
  transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }
  async lock(tx: DbTx, tenantId: string, sessionId: string): Promise<ImportSessionRow> {
    const [row] = await tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId)))
      .for("update");
    if (!row) throw new NotFoundException("import_session_not_found");
    return row;
  }
  async create(tx: DbTx, values: typeof sessions.$inferInsert): Promise<ImportSessionRow> {
    const [row] = await tx.insert(sessions).values(values).returning();
    if (!row) throw new Error("Session insert returned no row");
    return row;
  }
  async save(
    tx: DbTx,
    row: ImportSessionRow,
    values: Partial<typeof sessions.$inferInsert>,
  ): Promise<ImportSessionRow> {
    const [saved] = await tx
      .update(sessions)
      .set({ ...values, revision: sql`${sessions.revision} + 1`, updatedAt: sql`now()` })
      .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
      .returning();
    if (!saved) throw new NotFoundException("import_session_not_found");
    return saved;
  }
  async list(
    tx: DbTx,
    tenantId: string,
    sessionId: string,
    query: ImportItemsQuery,
  ): Promise<ImportItemRow[]> {
    let cursor: { createdAt: string; id: string } | null = null;
    if (query.cursor) {
      try {
        const value: unknown = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
        if (
          !value ||
          typeof value !== "object" ||
          !("createdAt" in value) ||
          !("id" in value) ||
          typeof value.createdAt !== "string" ||
          typeof value.id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id) ||
          !Number.isFinite(Date.parse(value.createdAt))
        )
          throw new Error();
        cursor = { createdAt: value.createdAt, id: value.id };
      } catch {
        throw new UnprocessableEntityException("invalid_cursor");
      }
    }
    if (cursor) {
      const [anchor] = await tx
        .select({ createdAt: items.createdAt })
        .from(items)
        .where(and(scope(tenantId, sessionId), eq(items.id, cursor.id)));
      if (!anchor || anchor.createdAt.toISOString() !== cursor.createdAt)
        throw new UnprocessableEntityException("invalid_cursor");
    }
    return tx
      .select()
      .from(items)
      .where(
        and(
          scope(tenantId, sessionId),
          cursor
            ? sql`(${items.createdAt}, ${items.id}) > (select anchor.created_at, anchor.id from national_catalog_import_items as anchor where anchor.tenant_id=${tenantId} and anchor.session_id=${sessionId} and anchor.id=${cursor.id})`
            : undefined,
          query.includeArchived ? undefined : sql`not ('archived' = any(${items.statusKeys}))`,
          query.statuses.length ? arrayOverlaps(items.statusKeys, query.statuses) : undefined,
          query.search
            ? or(
                ilike(items.name, `%${query.search.replace(/[\\%_]/g, "\\$&")}%`),
                ilike(items.gtin14, `%${query.search.replace(/[\\%_]/g, "\\$&")}%`),
              )
            : undefined,
        ),
      )
      .orderBy(asc(items.createdAt), asc(items.id))
      .limit(query.limit + 1);
  }
  async selectedIds(tx: DbTx, tenantId: string, sessionId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: items.id })
      .from(items)
      .where(and(scope(tenantId, sessionId), eq(items.selected, true)))
      .orderBy(asc(items.createdAt), asc(items.id))
      .limit(100);
    return rows.map((row) => row.id);
  }
  async choose(tx: DbTx, session: ImportSessionRow, itemIds: string[]): Promise<void> {
    const chosen = itemIds.length
      ? await tx
          .select()
          .from(items)
          .where(and(scope(session.tenantId, session.id), inArray(items.id, itemIds)))
      : [];
    if (chosen.length !== itemIds.length || chosen.some((row) => !row.selectable))
      throw new UnprocessableEntityException("invalid_selection");
    const gtins = new Map<string, string>();
    for (const row of chosen) {
      if (row.gtin14 && row.cardId) {
        const previous = gtins.get(row.gtin14);
        if (previous && previous !== row.cardId)
          throw new UnprocessableEntityException("ambiguous_card_selection");
        gtins.set(row.gtin14, row.cardId);
      }
    }
    await tx
      .update(items)
      .set({ selected: false })
      .where(and(scope(session.tenantId, session.id), eq(items.selected, true)));
    if (itemIds.length)
      await tx
        .update(items)
        .set({ selected: true })
        .where(and(scope(session.tenantId, session.id), inArray(items.id, itemIds)));
  }
  /** Caller holds the session lock. Product/link matching is batched and tenant scoped. */
  async upsert(
    tx: DbTx,
    session: ImportSessionRow,
    incoming: ImportItemWrite[],
  ): Promise<{ loaded: number; selected: number }> {
    if (!incoming.length) return { loaded: session.loaded, selected: session.selected };
    const gtins = [...new Set(incoming.flatMap((row) => (row.gtin14 ? [row.gtin14] : [])))];
    const inputs = [...new Set(incoming.flatMap((row) => (row.input ? [row.input] : [])))];
    const existing = session.loaded
      ? await tx
          .select()
          .from(items)
          .where(
            and(
              scope(session.tenantId, session.id),
              or(
                gtins.length ? inArray(items.gtin14, gtins) : undefined,
                inputs.length ? inArray(items.input, inputs) : undefined,
              ),
            ),
          )
      : [];
    const products = gtins.length
      ? await tx
          .select()
          .from(schema.products)
          .where(
            and(
              eq(schema.products.tenantId, session.tenantId),
              inArray(schema.products.gtin14, gtins),
            ),
          )
      : [];
    const links = products.length
      ? await tx
          .select()
          .from(schema.nationalCatalogProductLinks)
          .where(
            and(
              eq(schema.nationalCatalogProductLinks.tenantId, session.tenantId),
              isNull(schema.nationalCatalogProductLinks.closedAt),
              inArray(
                schema.nationalCatalogProductLinks.productId,
                products.map((p) => p.id),
              ),
            ),
          )
      : [];
    const key = (row: Pick<ImportItemWrite, "cardId" | "gtin14" | "input">) =>
      JSON.stringify([row.cardId ?? null, row.gtin14 ?? null, row.input ?? null]);
    const known = new Map(existing.map((row) => [key(row), row]));
    const unique = new Map(incoming.map((row) => [key(row), row]));
    const resolvedGtins = new Set(
      incoming.flatMap((row) => (row.cardId && row.gtin14 ? [row.gtin14] : [])),
    );
    const replaced = existing.filter(
      (row) => row.cardId === null && row.gtin14 && resolvedGtins.has(row.gtin14),
    );
    const additions = [...unique.keys()].filter((k) => !known.has(k)).length;
    if (session.loaded - replaced.length + additions > 100_000)
      throw new UnprocessableEntityException("session_row_limit");
    // Reuse an unselectable lookup placeholder for the first recovered card.
    // The row's stable UUID/created_at keep previously issued UI cursors valid.
    const placeholders = new Map(replaced.map((row) => [row.gtin14, row]));
    const inserts: Array<typeof items.$inferInsert> = [];
    for (const [identity, source] of unique) {
      const row = { ...source };
      if (row.gtin14 && row.cardId && row.match !== "invalid") {
        const matching = products.filter((p) => p.gtin14 === row.gtin14);
        const local = matching.find((p) => !p.archived) ?? matching[0];
        const link = local ? links.find((l) => l.productId === local.id) : undefined;
        row.productId = local?.id ?? null;
        row.match = local?.archived
          ? "archived_local"
          : link
            ? link.cardId === row.cardId &&
              link.environment === session.environment &&
              link.boundGtin14 === row.gtin14
              ? "linked"
              : "other_link"
            : local
              ? "existing"
              : "new";
        // Selecting an accessible candidate permits a replacement preview only;
        // the existing link still requires explicit confirmation in apply.
        row.selectable = !local?.archived && !row.statusKeys?.includes("archived");
        row.reason = local?.archived
          ? "archived_local"
          : row.statusKeys?.includes("archived")
            ? "archived_card"
            : row.match === "other_link"
              ? "other_link"
              : null;
      }
      const previous =
        known.get(identity) ??
        (row.cardId && row.gtin14 ? placeholders.get(row.gtin14) : undefined);
      if (previous && row.gtin14) placeholders.delete(row.gtin14);
      if (previous)
        await tx
          .update(items)
          .set({ ...row, selected: previous.selected && (row.selectable ?? false) })
          .where(and(scope(session.tenantId, session.id), eq(items.id, previous.id)));
      else inserts.push({ ...row, tenantId: session.tenantId, sessionId: session.id });
    }
    for (let offset = 0; offset < inserts.length; offset += 1000)
      await tx.insert(items).values(inserts.slice(offset, offset + 1000));
    // Ambiguity is informational until an explicit one-card selection resolves it.
    if (gtins.length)
      await tx.execute(
        sql`update ${items} as candidate set match = 'ambiguous' where candidate.tenant_id=${session.tenantId} and candidate.session_id=${session.id} and candidate.selectable=true and candidate.gtin14 in (${sql.join(
          gtins.map((g) => sql`${g}`),
          sql`,`,
        )}) and exists (select 1 from ${items} as other where other.tenant_id=candidate.tenant_id and other.session_id=candidate.session_id and other.gtin14=candidate.gtin14 and other.card_id<>candidate.card_id and other.selectable=true)`,
      );
    const [counts] = await tx
      .select({
        loaded: sql<number>`count(*)::int`,
        selected: sql<number>`count(*) filter (where ${items.selected})::int`,
      })
      .from(items)
      .where(scope(session.tenantId, session.id));
    return { loaded: counts?.loaded ?? 0, selected: counts?.selected ?? 0 };
  }
}
