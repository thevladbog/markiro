import { and, asc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

const OPERATOR_ACCESS_ACTIONS = [
  "platform.team.role_changed",
  "platform.team.suspended",
  "platform.team.two_factor_recovered",
  "platform.team.activation_renewed",
  "platform.activation.completed",
] as const;

/** Call after locking the platform user row so a team mutation cannot race the snapshot. */
export async function supportOperatorAccessAuditIds(
  executor: Pick<Db, "select">,
  operatorId: string,
): Promise<string[]> {
  const facts = await executor
    .select({ id: schema.platformAuditEvents.id })
    .from(schema.platformAuditEvents)
    .where(
      and(
        eq(schema.platformAuditEvents.targetType, "platform_user"),
        eq(schema.platformAuditEvents.targetId, operatorId),
        eq(schema.platformAuditEvents.outcome, "success"),
        inArray(schema.platformAuditEvents.action, OPERATOR_ACCESS_ACTIONS),
      ),
    )
    .orderBy(asc(schema.platformAuditEvents.id));
  return facts.map((fact) => fact.id);
}

export function sameSupportOperatorAccessSnapshot(
  stored: string[] | null,
  current: string[],
): boolean {
  return (
    stored !== null &&
    stored.length === current.length &&
    stored.every((id, index) => id === current[index])
  );
}
