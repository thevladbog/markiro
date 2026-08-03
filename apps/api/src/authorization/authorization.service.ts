import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { resolveCabinetAccess, type ResolvedCabinetAccess } from "@markiro/domain";
import { DB } from "../auth/auth.module";

export interface CabinetPrincipal extends ResolvedCabinetAccess {
  userId: string;
  tenantId: string;
}

@Injectable()
export class AuthorizationService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async resolvePrincipal(userId: string, tenantId: string): Promise<CabinetPrincipal | null> {
    const memberships = await this.db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, tenantId)))
      .limit(2);
    if (memberships.length !== 1) return null;
    const membership = memberships[0]!;
    return { userId, tenantId, ...resolveCabinetAccess(membership.role) };
  }
}
