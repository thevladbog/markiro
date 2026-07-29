import { randomBytes, randomUUID } from "node:crypto";
import { deriveDigestB64, formatPhc, PHC_ITERATIONS, verifyPhc } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { UnauthorizedException } from "@nestjs/common";

/** Тот же бюджет и то же окно, что у привязки киоска: одна и та же угроза. */
export const CHECKAUTH_BUDGET = 10;
export const CHECKAUTH_WINDOW_MS = 15 * 60_000;

/**
 * Floors `now` to the start of its fixed window -- the unit
 * `assertUnderCheckauthLimit`/`refundCheckauthAttempt` count in. Identical
 * shape to `pairAttemptWindowStart` in `pairing.service.ts` (same
 * `Math.floor(ms / windowMs) * windowMs` flooring), which Task 5 left open as
 * "what rounds the window" for whoever wires this counter into `checkauth`.
 * Colocated with `CHECKAUTH_WINDOW_MS` rather than living in the controller,
 * so the constant and the arithmetic that depends on it can't drift apart.
 */
export function checkauthWindowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / CHECKAUTH_WINDOW_MS) * CHECKAUTH_WINDOW_MS);
}

export interface ExchangeCredentials {
  login: string;
  /** Показывается один раз при выпуске; в базе только хэш. */
  secret: string;
}

export function generateExchangeCredentials(): ExchangeCredentials {
  return {
    login: `mk-1c-${randomUUID().slice(0, 8)}`,
    secret: randomBytes(24).toString("base64url"),
  };
}

export async function hashExchangeSecret(secret: string): Promise<string> {
  const salt = randomBytes(16).toString("base64");
  return formatPhc(PHC_ITERATIONS, salt, await deriveDigestB64(secret, salt, PHC_ITERATIONS));
}

/**
 * Delegates to `@markiro/domain`'s `verifyPhc` rather than re-deriving and
 * comparing digests here: that helper already does the comparison in
 * constant time (`constantTimeEqual`) and already answers `false` for a
 * malformed/foreign verifier (`parsePhc` returns `null`). Re-implementing
 * either bit here would either duplicate it or, worse, regress to a plain
 * `===` and reopen the timing side-channel that helper exists to close.
 */
export async function verifyExchangeSecret(secret: string, phc: string): Promise<boolean> {
  return verifyPhc(secret, phc);
}

/**
 * Счётчик неудачных `checkauth`, атомарный апсерт — форма один в один с
 * `recordPairAttempt` в `pairing.service.ts` (record-then-check upsert с
 * `RETURNING`, закрывающий ту же гонку N конкурентных вызовов). Это НЕ форма
 * `assertUnderPairRateLimit` целиком: там два уровня — бюджет на источник ПЛЮС
 * глобальный backstop (`GLOBAL_PAIR_ATTEMPT_BUDGET`, ключ `"*"`), — и
 * read-only предварительная проверка (`currentPairAttempts`), которая не даёт
 * атакующему безнаказанно раздувать таблицу попыток, перебирая значения
 * `source`, когда глобальный бюджет уже исчерпан.
 *
 * Считаются ПОПЫТКИ, а не промахи по строке: неверный логин не совпадает ни с
 * одним каналом, поэтому счётчик, инкрементируемый только при найденной
 * строке, не сработал бы вообще — ровно эта ошибка уже была допущена в
 * привязке киоска и стоила трёх раундов правок.
 *
 * Task 6 resolved the open question above (no global backstop, no pre-check)
 * for THIS counter -- deliberately, not by omission. The kiosk-pairing global
 * backstop earns its keep because the guessable space is an 8-digit code
 * (10^8): distributing guesses across many sources multiplies a genuinely
 * feasible attack. The exchange secret (`generateExchangeCredentials`) is 24
 * random bytes -- 192 bits -- so even every one of `CHECKAUTH_BUDGET` (10)
 * attempts per window, multiplied across an unbounded number of sources, is
 * still astronomically far from a feasible brute force. The per-source budget
 * here is defense-in-depth (bounding log/DB noise and one misbehaving
 * integration hammering the endpoint), not the thing standing between the
 * secret and an attacker the way the kiosk limiter is -- so the extra
 * complexity of a second tier and its own pre-check isn't justified. An
 * unattributable caller (empty `source`) simply gets its own `""`-keyed
 * bucket here rather than a shared global one, same net effect as every
 * caller colliding onto one bucket when `TRUST_PROXY_HOPS=0` (see main.ts).
 */
export async function assertUnderCheckauthLimit(
  db: Db,
  source: string,
  windowStart: Date,
): Promise<void> {
  const [row] = await db
    .insert(schema.exchangeAttempts)
    .values({ source, windowStartedAt: windowStart, failures: 1 })
    .onConflictDoUpdate({
      target: [schema.exchangeAttempts.source, schema.exchangeAttempts.windowStartedAt],
      set: { failures: sql`${schema.exchangeAttempts.failures} + 1` },
    })
    .returning({ failures: schema.exchangeAttempts.failures });

  if ((row?.failures ?? 0) > CHECKAUTH_BUDGET) {
    throw new UnauthorizedException();
  }
}

/** Успешный вход возвращает потраченную попытку — иначе рабочий обмен сам себя запрёт. */
export async function refundCheckauthAttempt(
  db: Db,
  source: string,
  windowStart: Date,
): Promise<void> {
  await db
    .update(schema.exchangeAttempts)
    .set({ failures: sql`greatest(${schema.exchangeAttempts.failures} - 1, 0)` })
    .where(
      and(
        eq(schema.exchangeAttempts.source, source),
        eq(schema.exchangeAttempts.windowStartedAt, windowStart),
      ),
    );
}
