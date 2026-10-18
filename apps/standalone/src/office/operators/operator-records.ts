import type { TFunction } from "i18next";
import { z } from "zod";

import { HostError } from "../../host/client.js";
import type { BadgeInfo, OfficeOperator } from "../../host/protocol.js";
import { withRecord } from "../records.js";

/**
 * Active operators before the ones turned off, each group by personnel
 * number as text, which is the host's order too: leading zeros are part of
 * the number, so «0042» comes before «042», and «100» before «99».
 */
export function activeFirstByLogin(operators: readonly OfficeOperator[]): OfficeOperator[] {
  return [...operators].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) || (a.login < b.login ? -1 : a.login > b.login ? 1 : 0),
  );
}

/** How the office names a badge: by its label, or «Без подписи» when it has none. */
export function badgeLabel(badge: BadgeInfo, t: TFunction): string {
  return badge.label ?? t("office.operators.badges.unnamed");
}

/**
 * `operators` with `badge` among the badges of `operatorId`: in place of the
 * one with its id, which keeps its position, or after the others when none
 * has that id (the host orders badges by `created_at, id`, so a new one goes
 * last). Applied twice it changes nothing more than once: a re-read that
 * raced the write may have brought the badge already.
 */
export function withBadge(
  operators: readonly OfficeOperator[],
  operatorId: string,
  badge: BadgeInfo,
): OfficeOperator[] {
  return operators.map((operator) =>
    operator.id === operatorId
      ? { ...operator, badges: withRecord(operator.badges, badge) }
      : operator,
  );
}

/**
 * `operators` with the badge `badgeId` of `operatorId` marked revoked at
 * `revokedAt`, until the list read again brings the host's own time.
 */
export function withBadgeRevoked(
  operators: readonly OfficeOperator[],
  operatorId: string,
  badgeId: string,
  revokedAt: string,
): OfficeOperator[] {
  return operators.map((operator) =>
    operator.id === operatorId
      ? {
          ...operator,
          badges: operator.badges.map((badge) =>
            badge.id === badgeId && badge.revokedAt === null ? { ...badge, revokedAt } : badge,
          ),
        }
      : operator,
  );
}

/**
 * The operator who already holds a badge, as a `badge` conflict names them in
 * `details.operatorId`: a UUID of an operator in `operators`. `null` for any
 * other failure and for an id that is missing, malformed or not in the list.
 */
export function badgeHolder(
  error: unknown,
  operators: readonly OfficeOperator[],
): OfficeOperator | null {
  if (!(error instanceof HostError) || error.code !== "conflict") return null;
  if (error.details.constraint !== "badge") return null;
  const id = z.uuid().safeParse(error.details.operatorId);
  if (!id.success) return null;
  return operators.find((operator) => operator.id === id.data) ?? null;
}
