import { ForbiddenException } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import {
  platformCapabilitiesForRole,
  type PlatformCapability,
} from "../platform-auth/platform-access-policy";

export async function requireReportCreator(
  db: Pick<Db, "select">,
  userId: string,
  capability: PlatformCapability,
  identified: boolean,
) {
  const [user] = await db
    .select({
      id: schema.platformUsers.id,
      role: schema.platformUsers.role,
      status: schema.platformUsers.status,
      twoFactorEnabled: schema.platformUsers.twoFactorEnabled,
    })
    .from(schema.platformUsers)
    .where(eq(schema.platformUsers.id, userId));
  if (!user || user.status !== "active" || !user.twoFactorEnabled) throw new ForbiddenException();
  const [factor] = await db
    .select({ id: schema.platformTwoFactors.id })
    .from(schema.platformTwoFactors)
    .where(
      and(
        eq(schema.platformTwoFactors.userId, userId),
        eq(schema.platformTwoFactors.verified, true),
      ),
    );
  const capabilities = platformCapabilitiesForRole(user.role);
  if (
    !factor ||
    !capabilities.includes(capability) ||
    (identified && !capabilities.includes("reports.identified"))
  )
    throw new ForbiddenException();
  return user;
}
