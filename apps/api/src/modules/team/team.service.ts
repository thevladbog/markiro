import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { AuthSetup } from "../../auth/auth.setup";
import { DB, DB_POOL } from "../../auth/auth.module";
import { MailDeliveryService } from "../mail/mail-delivery.service";
import { MailJobsService, type MailPgClient } from "../mail/mail-jobs.service";
import type {
  CreateTeamInvitationDto,
  LinkTeamEmployeeDto,
  TeamInvitationDto,
  TeamMemberDto,
  TeamResponseDto,
  UpdateTeamMemberDto,
} from "./dto";
import { canMutateTeamTarget, type TeamActorRole } from "./team-policy";

export const TEAM_INVITATION_BASE_URL = "TEAM_INVITATION_BASE_URL";
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const ACTIVE_DELIVERY_STATUSES = ["queued", "sending", "retrying"] as const;

@Injectable()
export class TeamService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DB_POOL) private readonly pool: AuthSetup["pool"],
    private readonly mailDelivery: MailDeliveryService,
    private readonly mailJobs: MailJobsService,
    @Inject(TEAM_INVITATION_BASE_URL) private readonly invitationBaseUrl: string,
  ) {}

  async getTeam(organizationId: string): Promise<TeamResponseDto> {
    const memberRows = await this.db
      .select({
        id: schema.member.id,
        userId: schema.member.userId,
        email: schema.user.email,
        role: schema.member.role,
        createdAt: schema.member.createdAt,
        firstName: schema.userProfiles.firstName,
        lastName: schema.userProfiles.lastName,
        middleName: schema.userProfiles.middleName,
        avatarAssetId: schema.userProfiles.avatarAssetId,
        position: schema.tenantMemberProfiles.position,
        employeeId: schema.employees.id,
        employeeName: schema.employees.fullName,
        employeeStatus: schema.employees.status,
        operatorActive: schema.operatorCredentials.active,
      })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.member.userId))
      .leftJoin(
        schema.tenantMemberProfiles,
        and(
          eq(schema.tenantMemberProfiles.organizationId, organizationId),
          eq(schema.tenantMemberProfiles.memberId, schema.member.id),
        ),
      )
      .leftJoin(
        schema.cabinetEmployeeLinks,
        and(
          eq(schema.cabinetEmployeeLinks.organizationId, organizationId),
          eq(schema.cabinetEmployeeLinks.memberId, schema.member.id),
        ),
      )
      .leftJoin(
        schema.employees,
        and(
          eq(schema.employees.tenantId, organizationId),
          eq(schema.employees.id, schema.cabinetEmployeeLinks.employeeId),
        ),
      )
      .leftJoin(
        schema.operatorCredentials,
        and(
          eq(schema.operatorCredentials.tenantId, organizationId),
          eq(schema.operatorCredentials.employeeId, schema.employees.id),
        ),
      )
      .where(eq(schema.member.organizationId, organizationId))
      .orderBy(schema.user.email);

    const invitationRows = await this.db
      .select({
        id: schema.invitation.id,
        email: schema.invitation.email,
        role: schema.invitation.role,
        status: schema.invitation.status,
        expiresAt: schema.invitation.expiresAt,
        position: schema.tenantInvitationProfiles.position,
        employeeId: schema.employees.id,
        employeeName: schema.employees.fullName,
        employeeStatus: schema.employees.status,
        operatorActive: schema.operatorCredentials.active,
      })
      .from(schema.invitation)
      .leftJoin(
        schema.tenantInvitationProfiles,
        and(
          eq(schema.tenantInvitationProfiles.organizationId, organizationId),
          eq(schema.tenantInvitationProfiles.invitationId, schema.invitation.id),
        ),
      )
      .leftJoin(
        schema.cabinetEmployeeLinks,
        and(
          eq(schema.cabinetEmployeeLinks.organizationId, organizationId),
          eq(schema.cabinetEmployeeLinks.invitationId, schema.invitation.id),
        ),
      )
      .leftJoin(
        schema.employees,
        and(
          eq(schema.employees.tenantId, organizationId),
          eq(schema.employees.id, schema.cabinetEmployeeLinks.employeeId),
        ),
      )
      .leftJoin(
        schema.operatorCredentials,
        and(
          eq(schema.operatorCredentials.tenantId, organizationId),
          eq(schema.operatorCredentials.employeeId, schema.employees.id),
        ),
      )
      .where(
        and(
          eq(schema.invitation.organizationId, organizationId),
          eq(schema.invitation.status, "pending"),
        ),
      )
      .orderBy(desc(schema.invitation.createdAt));

    const invitationIds = invitationRows.map((row) => row.id);
    const deliveries = invitationIds.length
      ? await this.db
          .select({
            id: schema.emailDeliveries.id,
            sourceId: schema.emailDeliveries.sourceId,
            status: schema.emailDeliveries.status,
            errorCategory: schema.emailDeliveries.errorCategory,
          })
          .from(schema.emailDeliveries)
          .where(
            and(
              eq(schema.emailDeliveries.tenantId, organizationId),
              inArray(schema.emailDeliveries.sourceId, invitationIds),
            ),
          )
          .orderBy(desc(schema.emailDeliveries.createdAt))
      : [];
    const latestDelivery = new Map<
      string,
      { id: string; status: string; errorCategory: string | null }
    >();
    for (const delivery of deliveries) {
      if (delivery.sourceId && !latestDelivery.has(delivery.sourceId)) {
        latestDelivery.set(delivery.sourceId, {
          id: delivery.id,
          status: delivery.status,
          errorCategory: delivery.errorCategory,
        });
      }
    }

    return {
      members: memberRows.map((row): TeamMemberDto => ({
        id: row.id,
        userId: row.userId,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        middleName: row.middleName,
        avatarAssetId: row.avatarAssetId,
        role: row.role,
        position: row.position,
        employee: employeeDto(row),
        createdAt: row.createdAt,
      })),
      invitations: invitationRows.map((row): TeamInvitationDto => ({
        id: row.id,
        email: row.email,
        role: row.role,
        position: row.position,
        accessStatus: row.expiresAt <= new Date() ? "expired" : row.status,
        expiresAt: row.expiresAt,
        employee: employeeDto(row),
        delivery: latestDelivery.get(row.id) ?? null,
      })),
    };
  }

  async createInvitation(
    organizationId: string,
    actorUserId: string,
    input: CreateTeamInvitationDto,
  ): Promise<TeamInvitationDto> {
    await this.assertInvitationRateLimit(organizationId, actorUserId, input.email);
    const context = await this.invitationContext(organizationId, actorUserId);
    const existingMember = await this.db
      .select({ id: schema.member.id })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(
        and(
          eq(schema.member.organizationId, organizationId),
          sql`lower(${schema.user.email}) = ${input.email}`,
        ),
      )
      .limit(1);
    if (existingMember.length) throw new ConflictException("User is already a tenant member");

    const duplicate = await this.db
      .select({ id: schema.invitation.id })
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.organizationId, organizationId),
          sql`lower(${schema.invitation.email}) = ${input.email}`,
          eq(schema.invitation.status, "pending"),
          gt(schema.invitation.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (duplicate.length) throw new ConflictException("A pending invitation already exists");
    if (input.employeeId) await this.assertEmployeeAvailable(organizationId, input.employeeId);

    const id = randomUUID();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`team-invite:${organizationId}:${input.email}`}, 0))`,
        );
        const concurrentDuplicate = await tx
          .select({ id: schema.invitation.id })
          .from(schema.invitation)
          .where(
            and(
              eq(schema.invitation.organizationId, organizationId),
              sql`lower(${schema.invitation.email}) = ${input.email}`,
              eq(schema.invitation.status, "pending"),
              gt(schema.invitation.expiresAt, new Date()),
            ),
          )
          .limit(1);
        if (concurrentDuplicate.length) {
          throw new ConflictException("A pending invitation already exists");
        }
        await tx.insert(schema.invitation).values({
          id,
          organizationId,
          email: input.email,
          role: input.role,
          status: "pending",
          expiresAt,
          inviterId: actorUserId,
        });
        await tx.insert(schema.tenantInvitationProfiles).values({
          invitationId: id,
          organizationId,
          position: input.position ?? null,
        });
        if (input.employeeId) {
          await tx.insert(schema.cabinetEmployeeLinks).values({
            organizationId,
            employeeId: input.employeeId,
            invitationId: id,
          });
        }
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId,
          actorUserId,
          action: "team.invitation.created",
          outcome: "success",
          targetType: "invitation",
          targetId: id,
          after: { role: input.role, position: input.position ?? null },
        });
        await this.mailDelivery.enqueue(tx, {
          scope: { tenantId: organizationId },
          recipient: input.email,
          sourceId: id,
          template: {
            kind: "organization-invitation",
            recipientName: "Коллега",
            organizationName: context.organizationName,
            inviterName: context.inviterName,
            actionUrl: new URL(`/invitations/${id}`, this.invitationBaseUrl).toString(),
            expiresAt,
          },
        });
      });
    } catch (error) {
      this.rethrowConstraint(error);
    }
    return this.getInvitation(organizationId, id);
  }

  async updateMember(
    organizationId: string,
    actorUserId: string,
    memberId: string,
    input: UpdateTeamMemberDto,
  ): Promise<TeamMemberDto> {
    const { target } = await this.assertMutableTarget(
      organizationId,
      actorUserId,
      memberId,
    );
    await this.db.transaction(async (tx) => {
      if (input.role !== undefined) {
        await tx.update(schema.member).set({ role: input.role }).where(eq(schema.member.id, memberId));
      }
      if (input.position !== undefined) {
        await tx
          .insert(schema.tenantMemberProfiles)
          .values({ organizationId, memberId, position: input.position })
          .onConflictDoUpdate({
            target: schema.tenantMemberProfiles.memberId,
            set: { position: input.position, updatedAt: new Date() },
          });
      }
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId,
        actorUserId,
        action: "team.member.updated",
        outcome: "success",
        targetType: "member",
        targetId: memberId,
        before: { role: target.role },
        after: { role: input.role ?? target.role, position: input.position },
      });
    });
    return this.getMember(organizationId, memberId);
  }

  async linkEmployee(
    organizationId: string,
    actorUserId: string,
    memberId: string,
    input: LinkTeamEmployeeDto,
  ): Promise<TeamMemberDto> {
    await this.assertMutableTarget(organizationId, actorUserId, memberId);
    await this.assertEmployeeAvailable(organizationId, input.employeeId, memberId);
    try {
      await this.db.transaction(async (tx) => {
        await tx
          .delete(schema.cabinetEmployeeLinks)
          .where(
            and(
              eq(schema.cabinetEmployeeLinks.organizationId, organizationId),
              eq(schema.cabinetEmployeeLinks.memberId, memberId),
            ),
          );
        await tx.insert(schema.cabinetEmployeeLinks).values({
          organizationId,
          memberId,
          employeeId: input.employeeId,
        });
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId,
          actorUserId,
          action: "team.member.employee_linked",
          outcome: "success",
          targetType: "member",
          targetId: memberId,
          after: { employeeId: input.employeeId },
        });
      });
    } catch (error) {
      this.rethrowConstraint(error);
    }
    return this.getMember(organizationId, memberId);
  }

  async unlinkEmployee(
    organizationId: string,
    actorUserId: string,
    memberId: string,
  ): Promise<TeamMemberDto> {
    await this.assertMutableTarget(organizationId, actorUserId, memberId);
    await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.cabinetEmployeeLinks)
        .where(
          and(
            eq(schema.cabinetEmployeeLinks.organizationId, organizationId),
            eq(schema.cabinetEmployeeLinks.memberId, memberId),
          ),
        );
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId,
        actorUserId,
        action: "team.member.employee_unlinked",
        outcome: "success",
        targetType: "member",
        targetId: memberId,
      });
    });
    return this.getMember(organizationId, memberId);
  }

  async removeMember(
    organizationId: string,
    actorUserId: string,
    memberId: string,
  ): Promise<void> {
    const { target } = await this.assertMutableTarget(organizationId, actorUserId, memberId);
    await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.member)
        .where(
          and(eq(schema.member.organizationId, organizationId), eq(schema.member.id, memberId)),
        );
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId,
        actorUserId,
        action: "team.member.removed",
        outcome: "success",
        targetType: "member",
        targetId: memberId,
        before: { role: target.role },
      });
    });
  }

  async resendInvitation(
    organizationId: string,
    actorUserId: string,
    invitationId: string,
  ): Promise<TeamInvitationDto> {
    const invitation = await this.pendingInvitation(organizationId, invitationId);
    await this.assertInvitationRateLimit(organizationId, actorUserId, invitation.email);
    const context = await this.invitationContext(organizationId, actorUserId);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const performResend = async () => {
      await this.db.transaction(async (tx) => {
        // One active invitation email at a time. The advisory delivery lock
        // above prevents a worker from sending the previous payload while it
        // is being superseded.
        await tx
          .update(schema.emailDeliveries)
          .set({
            status: "canceled",
            encryptedPayload: null,
            payloadNonce: null,
            payloadTag: null,
            attemptId: null,
            attemptDeadline: null,
            terminalAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.emailDeliveries.tenantId, organizationId),
              eq(schema.emailDeliveries.sourceId, invitationId),
              inArray(schema.emailDeliveries.status, ACTIVE_DELIVERY_STATUSES),
            ),
          );
        const updated = await tx
          .update(schema.invitation)
          .set({ expiresAt })
          .where(
            and(
              eq(schema.invitation.organizationId, organizationId),
              eq(schema.invitation.id, invitationId),
              eq(schema.invitation.status, "pending"),
              gt(schema.invitation.expiresAt, new Date()),
            ),
          )
          .returning({ id: schema.invitation.id });
        if (updated.length !== 1) throw new NotFoundException("Pending invitation not found");
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId,
          actorUserId,
          action: "team.invitation.resent",
          outcome: "success",
          targetType: "invitation",
          targetId: invitationId,
        });
        await this.mailDelivery.enqueue(tx, {
          scope: { tenantId: organizationId },
          recipient: invitation.email,
          sourceId: invitationId,
          template: {
            kind: "organization-invitation",
            recipientName: "Коллега",
            organizationName: context.organizationName,
            inviterName: context.inviterName,
            actionUrl: new URL(`/invitations/${invitationId}`, this.invitationBaseUrl).toString(),
            expiresAt,
          },
        });
      });
    };
    const [active] = await this.db
      .select({ id: schema.emailDeliveries.id })
      .from(schema.emailDeliveries)
      .where(
        and(
          eq(schema.emailDeliveries.tenantId, organizationId),
          eq(schema.emailDeliveries.sourceId, invitationId),
          inArray(schema.emailDeliveries.status, ACTIVE_DELIVERY_STATUSES),
        ),
      )
      .orderBy(desc(schema.emailDeliveries.createdAt))
      .limit(1);
    if (active) {
      const result = await this.mailJobs.withDeliveryLock(active.id, performResend);
      if (!result.acquired) throw new ConflictException({ code: "delivery_in_flight" });
    } else {
      await performResend();
    }
    return this.getInvitation(organizationId, invitationId);
  }

  async cancelInvitation(
    organizationId: string,
    actorUserId: string,
    invitationId: string,
  ): Promise<void> {
    await this.pendingInvitation(organizationId, invitationId);
    const [active] = await this.db
      .select({ id: schema.emailDeliveries.id })
      .from(schema.emailDeliveries)
      .where(
        and(
          eq(schema.emailDeliveries.tenantId, organizationId),
          eq(schema.emailDeliveries.sourceId, invitationId),
          inArray(schema.emailDeliveries.status, ACTIVE_DELIVERY_STATUSES),
        ),
      )
      .orderBy(desc(schema.emailDeliveries.createdAt))
      .limit(1);
    const cancel = async (client: MailPgClient) => {
      try {
        await client.query("BEGIN");
        const result = await client.query(
          "UPDATE invitation SET status = 'canceled' WHERE id = $1 AND organization_id = $2 AND status = 'pending' AND expires_at > now()",
          [invitationId, organizationId],
        );
        if ((result.rowCount ?? 0) !== 1) throw new NotFoundException("Invitation not found");
        await client.query(
          "UPDATE email_deliveries SET status = 'canceled', encrypted_payload = null, payload_nonce = null, payload_tag = null, attempt_id = null, attempt_deadline = null, terminal_at = now(), updated_at = now() WHERE tenant_id = $1 AND source_id = $2 AND status IN ('queued','retrying','sending')",
          [organizationId, invitationId],
        );
        await client.query(
          "DELETE FROM cabinet_employee_links WHERE organization_id = $1 AND invitation_id = $2",
          [organizationId, invitationId],
        );
        await client.query(
          "DELETE FROM tenant_invitation_profiles WHERE organization_id = $1 AND invitation_id = $2",
          [organizationId, invitationId],
        );
        await client.query(
          "INSERT INTO tenant_audit_events (organization_id, actor_user_id, action, outcome, target_type, target_id) VALUES ($1,$2,'team.invitation.canceled','success','invitation',$3)",
          [organizationId, actorUserId, invitationId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    };
    if (active) {
      const result = await this.mailJobs.withDeliveryLock(active.id, cancel);
      if (!result.acquired) {
        throw new ConflictException({ code: "delivery_in_flight" });
      }
      return;
    }
    const client = await this.pool.connect();
    try {
      await cancel(client);
    } finally {
      client.release();
    }
  }

  private async invitationContext(organizationId: string, actorUserId: string) {
    const [row] = await this.db
      .select({ organizationName: schema.organization.name, inviterName: schema.user.name })
      .from(schema.organization)
      .innerJoin(schema.user, eq(schema.user.id, actorUserId))
      .innerJoin(
        schema.member,
        and(
          eq(schema.member.organizationId, organizationId),
          eq(schema.member.userId, actorUserId),
        ),
      )
      .where(eq(schema.organization.id, organizationId))
      .limit(1);
    if (!row) throw new ForbiddenException("Tenant membership not found");
    return row;
  }

  private async pendingInvitation(organizationId: string, invitationId: string) {
    const [row] = await this.db
      .select({ email: schema.invitation.email })
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.organizationId, organizationId),
          eq(schema.invitation.id, invitationId),
          eq(schema.invitation.status, "pending"),
          gt(schema.invitation.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Pending invitation not found");
    return row;
  }

  private async assertMutableTarget(
    organizationId: string,
    actorUserId: string,
    targetMemberId: string,
  ) {
    const [actor] = await this.db
      .select({ id: schema.member.id, role: schema.member.role })
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, organizationId),
          eq(schema.member.userId, actorUserId),
        ),
      )
      .limit(1);
    const [target] = await this.db
      .select({ id: schema.member.id, role: schema.member.role })
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, organizationId),
          eq(schema.member.id, targetMemberId),
        ),
      )
      .limit(1);
    if (!actor) throw new ForbiddenException("Tenant membership not found");
    if (!target) throw new NotFoundException("Team member not found");
    if (
      !canMutateTeamTarget({
        actorId: actor.id,
        actorRole: normalizeRole(actor.role),
        targetId: target.id,
        targetRole: normalizeRole(target.role),
      })
    ) {
      throw new ForbiddenException("Protected team member");
    }
    return { actor, target };
  }

  private async assertEmployeeAvailable(
    organizationId: string,
    employeeId: string,
    currentMemberId?: string,
  ): Promise<void> {
    const [employee] = await this.db
      .select({ id: schema.employees.id })
      .from(schema.employees)
      .where(
        and(
          eq(schema.employees.tenantId, organizationId),
          eq(schema.employees.id, employeeId),
          eq(schema.employees.status, "active"),
        ),
      )
      .limit(1);
    if (!employee) throw new NotFoundException("Active employee not found");
    const [claim] = await this.db
      .select({ memberId: schema.cabinetEmployeeLinks.memberId })
      .from(schema.cabinetEmployeeLinks)
      .where(
        and(
          eq(schema.cabinetEmployeeLinks.organizationId, organizationId),
          eq(schema.cabinetEmployeeLinks.employeeId, employeeId),
        ),
      )
      .limit(1);
    if (claim && claim.memberId !== currentMemberId) {
      throw new ConflictException("Employee is already linked");
    }
  }

  private async assertInvitationRateLimit(
    organizationId: string,
    actorUserId: string,
    email: string,
  ): Promise<void> {
    const result = await this.pool.query<{ actor_count: string; tenant_count: string; email_count: string }>(
      [
        "SELECT",
        "  count(*) FILTER (WHERE actor_user_id = $2 AND created_at > now() - interval '1 hour')::text AS actor_count,",
        "  count(*) FILTER (WHERE created_at > now() - interval '1 hour')::text AS tenant_count,",
        "  (SELECT count(*)::text FROM invitation WHERE organization_id = $1 AND lower(email) = lower($3) AND created_at > now() - interval '15 minutes') AS email_count",
        "FROM tenant_audit_events",
        "WHERE organization_id = $1 AND action IN ('team.invitation.created','team.invitation.resent')",
      ].join("\n"),
      [organizationId, actorUserId, email],
    );
    const counts = result.rows[0];
    if (
      Number(counts?.actor_count ?? 0) >= 20 ||
      Number(counts?.tenant_count ?? 0) >= 100 ||
      Number(counts?.email_count ?? 0) >= 3
    ) {
      throw new HttpException("Invitation rate limit exceeded", HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async getMember(organizationId: string, memberId: string) {
    const team = await this.getTeam(organizationId);
    const member = team.members.find((value) => value.id === memberId);
    if (!member) throw new NotFoundException("Team member not found");
    return member;
  }

  private async getInvitation(organizationId: string, invitationId: string) {
    const team = await this.getTeam(organizationId);
    const invitation = team.invitations.find((value) => value.id === invitationId);
    if (!invitation) throw new NotFoundException("Invitation not found");
    return invitation;
  }

  private rethrowConstraint(error: unknown): never {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new ConflictException("Team resource is already claimed");
    }
    throw error;
  }
}

function normalizeRole(value: string): TeamActorRole {
  const roles = new Set(value.split(",").map((role) => role.trim()));
  if (roles.has("owner")) return "owner";
  if (roles.has("admin")) return "admin";
  if (roles.has("manager")) return "manager";
  return "member";
}

function employeeDto(row: {
  employeeId: string | null;
  employeeName: string | null;
  employeeStatus: "active" | "archived" | null;
  operatorActive: boolean | null;
}) {
  if (!row.employeeId || !row.employeeName || !row.employeeStatus) return null;
  return {
    id: row.employeeId,
    fullName: row.employeeName,
    status: row.employeeStatus,
    operatorAccess: row.operatorActive === true,
  };
}
