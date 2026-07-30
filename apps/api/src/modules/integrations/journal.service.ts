import { Inject, Injectable } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import type { IntegrationChannelType } from "./channel-registry";

/** Сводка по сеансу переживает спор с бухгалтерией. */
export const SESSION_RETENTION_DAYS = 90;
/** Построчный разбор растёт кратно быстрее и живёт меньше (спека §7). */
export const ITEM_GRAIN_RETENTION_DAYS = 14;

export interface AppendEventInput {
  tenantId: string;
  channelType: IntegrationChannelType;
  sessionId: string | null;
  direction: "in" | "out" | "local";
  outcome: "ok" | "warn" | "error";
  grain: "session" | "item";
  message: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class JournalService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async openSession(
    tenantId: string,
    channelType: IntegrationChannelType,
    opts: { cookieHash: string; expiresAt: Date },
  ): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(schema.integrationSessions)
      .values({ tenantId, channelType, cookieHash: opts.cookieHash, expiresAt: opts.expiresAt })
      .returning({ id: schema.integrationSessions.id });
    return row!;
  }

  /**
   * Записывает событие и ДВИГАЕТ состояние канала тем же вызовом.
   *
   * Одним вызовом намеренно: карточка канала показывает «последнее событие N
   * назад», и если состояние обновлять отдельно, найдётся ветка, которая
   * событие запишет, а состояние забудет — карточка соврёт ровно тогда, когда
   * на неё смотрят из-за поломки. Обе записи идут в одной транзакции: одного
   * вызова недостаточно, если процесс падает МЕЖДУ вставкой и обновлением —
   * именно этот сбой и обязан не допустить сам комментарий выше.
   *
   * Fix 2 (final review): двигать состояние UPDATE'ом, а не upsert'ом, было
   * ошибкой — `UPDATE ... WHERE tenant_id = ? AND type = ?` это no-op против
   * НУЛЯ строк, если у канала ещё никогда не было строки в
   * `integration_channels`. Такую строку сегодня создают только
   * `updateChannel` (непустой патч настроек) и `issueCredentials` — а канал
   * вроде `public_api` не проходит ни тем, ни другим путём (пустая схема
   * настроек делает патч всегда «пустым», а выпуск учётных данных 1С этому
   * каналу запрещён, Task 15), при этом реальные события (выпуск ключа) он
   * пишет. Строка сеанса в журнале уже есть, а `GET /integrations` всё ещё
   * отвечает `not_configured`/`lastEventAt: null` — ровно то враньё, против
   * которого предостерегает комментарий выше. `append` обязан создать строку
   * сам, если её нет, а не полагаться на то, что кто-то другой её уже создал.
   */
  async append(input: AppendEventInput): Promise<void> {
    const at = new Date();
    await this.db.transaction(async (tx) => {
      await tx.insert(schema.integrationEvents).values({ ...input, at });
      await tx
        .insert(schema.integrationChannels)
        .values({
          tenantId: input.tenantId,
          type: input.channelType,
          lastEventAt: at,
          lastOutcome: input.outcome,
        })
        .onConflictDoUpdate({
          target: [schema.integrationChannels.tenantId, schema.integrationChannels.type],
          set: { lastEventAt: at, lastOutcome: input.outcome },
        });
    });
  }

  async finishSession(
    tenantId: string,
    sessionId: string,
    outcome: "ok" | "error",
    summary: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .update(schema.integrationSessions)
      .set({ finishedAt: new Date(), outcome, summary })
      .where(
        and(
          eq(schema.integrationSessions.tenantId, tenantId),
          eq(schema.integrationSessions.id, sessionId),
        ),
      );
  }

  /** Ретенция по зерну. Вызывается плановой джобой (Task 16). */
  async prune(now: Date): Promise<void> {
    const itemsBefore = new Date(now.getTime() - ITEM_GRAIN_RETENTION_DAYS * 24 * 3_600_000);
    const sessionsBefore = new Date(now.getTime() - SESSION_RETENTION_DAYS * 24 * 3_600_000);

    await this.db
      .delete(schema.integrationEvents)
      .where(
        and(
          eq(schema.integrationEvents.grain, "item"),
          lt(schema.integrationEvents.at, itemsBefore),
        ),
      );
    await this.db
      .delete(schema.integrationEvents)
      .where(lt(schema.integrationEvents.at, sessionsBefore));
    // `integrationEvents.sessionId` ссылается на `integrationSessions.id` без
    // FK (см. packages/db/src/schema/integrations.ts) -- ссылочная
    // целостность на уровне БД её не защитит. Поэтому события чистятся
    // ПЕРВЫМИ: если бы сеанс удалялся раньше своего события, событие осталось
    // бы указывать в никуда. Раньше это обоснование опиралось на то, что
    // строка сеанса и её событие стареют вместе, но это верно только для
    // коротких сеансов, где `startedAt` события совпадает по возрасту со
    // `startedAt` строки. Сеанс, закрытый спустя долгое время после начала,
    // ломает это допущение: его сводное событие свежее, чем `startedAt`
    // сеанса, — событие переживает обе чистки выше, а строка удалялась бы по
    // давнему `startedAt` и превращала это самое событие в сироту навсегда,
    // а не на мгновение. Поэтому строка сеанса теперь прунится по моменту,
    // который и определяет актуальность сводки: `finishedAt`, если сеанс
    // закрыт (а сводное событие пишется в `finishSession`/`append` примерно
    // тогда же), и откат на `startedAt` для тех, что так и не закрылись, —
    // иного ориентира для брошенных сеансов просто нет.
    await this.db
      .delete(schema.integrationSessions)
      .where(
        sql`coalesce(${schema.integrationSessions.finishedAt}, ${schema.integrationSessions.startedAt}) < ${sessionsBefore}`,
      );
  }
}
