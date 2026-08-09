import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { schema, type Auth, type Db } from "@markiro/db";
import type { AuthSetup } from "../../auth/auth.setup";
import { AUTH, DB, DB_POOL } from "../../auth/auth.module";
import { MailJobsService, type MailPgClient } from "../mail/mail-jobs.service";
import type { PublicInvitationDto, RegisterInvitationDto } from "./dto";

@Injectable()
export class InvitationsService {
  readonly #logger = new Logger(InvitationsService.name);
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
    @Inject(DB_POOL) private readonly pool: AuthSetup["pool"],
    private readonly mailJobs: MailJobsService,
  ) {}

  async getPublic(invitationId: string): Promise<PublicInvitationDto> {
    const invitation = await this.requirePending(invitationId);
    const [account] = await this.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, invitation.email))
      .limit(1);
    return {
      id: invitation.id,
      email: invitation.email,
      organizationName: maskOrganizationName(invitation.organizationName),
      role: invitation.role,
      state: "pending",
      expiresAt: invitation.expiresAt,
      hasAccount: Boolean(account),
    };
  }

  async register(
    invitationId: string,
    input: RegisterInvitationDto,
    headers: Headers,
  ): Promise<Response> {
    const invitation = await this.requirePending(invitationId);
    const [existing] = await this.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, invitation.email))
      .limit(1);
    if (existing) throw new ConflictException("Account already exists; sign in to accept");

    const name = [input.lastName, input.firstName, input.middleName].filter(Boolean).join(" ");
    const response = await this.auth.api.signUpEmail({
      body: { email: invitation.email, password: input.password, name },
      headers,
      asResponse: true,
    });
    if (!response.ok) return response;

    const [created] = await this.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, invitation.email))
      .limit(1);
    if (!created) throw new ConflictException("Account registration did not complete");
    await this.db
      .insert(schema.userProfiles)
      .values({
        userId: created.id,
        firstName: input.firstName,
        lastName: input.lastName,
        middleName: input.middleName ?? null,
      })
      .onConflictDoUpdate({
        target: schema.userProfiles.userId,
        set: {
          firstName: input.firstName,
          lastName: input.lastName,
          middleName: input.middleName ?? null,
          updatedAt: new Date(),
        },
      });
    return response;
  }

  async accept(invitationId: string, headers: Headers): Promise<Response> {
    const invitation = await this.requirePending(invitationId);
    const session = await this.auth.api.getSession({ headers });
    if (!session) throw new UnauthorizedException();
    const userEmail = typeof session.user.email === "string" ? session.user.email : "";
    if (userEmail.toLocaleLowerCase("en-US") !== invitation.email) {
      throw new ForbiddenException("Signed-in account is not the invitation recipient");
    }

    return this.withInvitationDeliveryLock(invitationId, invitation.organizationId, async () => {
      const response = await this.auth.api.acceptInvitation({
        body: { invitationId },
        headers,
        asResponse: true,
      });
      if (!response.ok) return response;
      await this.finalizeAccepted(invitationId, session.user.id, invitation.email);
      return response;
    });
  }

  async reject(invitationId: string, headers: Headers): Promise<Response> {
    const invitation = await this.requirePending(invitationId);
    const session = await this.auth.api.getSession({ headers });
    if (!session) throw new UnauthorizedException();
    const sessionId = typeof session.session.id === "string" ? session.session.id : "";
    if (!sessionId) throw new UnauthorizedException();
    const userEmail = typeof session.user.email === "string" ? session.user.email : "";
    if (userEmail.toLocaleLowerCase("en-US") !== invitation.email) {
      throw new ForbiddenException("Signed-in account is not the invitation recipient");
    }
    return this.withInvitationDeliveryLock(invitationId, invitation.organizationId, (client) =>
      this.rejectAtomically(
        client,
        invitationId,
        invitation.organizationId,
        session.user.id,
        userEmail,
        sessionId,
      ),
    );
  }

  async finalizeAccepted(invitationId: string, userId: string, email: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [invitation] = await tx
        .select({
          organizationId: schema.invitation.organizationId,
          status: schema.invitation.status,
          position: schema.tenantInvitationProfiles.position,
        })
        .from(schema.invitation)
        .leftJoin(
          schema.tenantInvitationProfiles,
          eq(schema.tenantInvitationProfiles.invitationId, schema.invitation.id),
        )
        .where(eq(schema.invitation.id, invitationId))
        .limit(1);
      if (!invitation || invitation.status !== "accepted") {
        throw new ConflictException("Invitation acceptance was not persisted");
      }
      const [member] = await tx
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, invitation.organizationId),
            eq(schema.member.userId, userId),
          ),
        )
        .limit(1);
      if (!member) throw new ConflictException("Accepted membership was not persisted");
      const [existingTenantProfile] = await tx
        .select({ position: schema.tenantMemberProfiles.position })
        .from(schema.tenantMemberProfiles)
        .where(eq(schema.tenantMemberProfiles.memberId, member.id))
        .limit(1);
      const position = invitation.position ?? existingTenantProfile?.position ?? null;
      const [user] = await tx
        .select({ name: schema.user.name })
        .from(schema.user)
        .where(and(eq(schema.user.id, userId), eq(schema.user.email, email)))
        .limit(1);
      if (!user) throw new ConflictException("Invitation account no longer matches");
      const fallback = splitLegacyName(user.name);
      await tx
        .insert(schema.userProfiles)
        .values({ userId, ...fallback })
        .onConflictDoNothing({ target: schema.userProfiles.userId });
      await tx
        .insert(schema.tenantMemberProfiles)
        .values({
          organizationId: invitation.organizationId,
          memberId: member.id,
          position,
        })
        .onConflictDoUpdate({
          target: schema.tenantMemberProfiles.memberId,
          set: { position, updatedAt: new Date() },
        });
      await tx
        .update(schema.cabinetEmployeeLinks)
        .set({ invitationId: null, memberId: member.id, updatedAt: new Date() })
        .where(
          and(
            eq(schema.cabinetEmployeeLinks.organizationId, invitation.organizationId),
            eq(schema.cabinetEmployeeLinks.invitationId, invitationId),
          ),
        );
      await tx
        .update(schema.user)
        .set({ emailVerified: true, updatedAt: new Date() })
        .where(and(eq(schema.user.id, userId), eq(schema.user.email, email)));
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
            eq(schema.emailDeliveries.tenantId, invitation.organizationId),
            eq(schema.emailDeliveries.sourceId, invitationId),
            inArray(schema.emailDeliveries.status, ["queued", "retrying"]),
          ),
        );
      await tx
        .delete(schema.tenantInvitationProfiles)
        .where(
          and(
            eq(schema.tenantInvitationProfiles.organizationId, invitation.organizationId),
            eq(schema.tenantInvitationProfiles.invitationId, invitationId),
          ),
        );
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: invitation.organizationId,
        actorUserId: userId,
        action: "team.invitation.accepted",
        outcome: "success",
        targetType: "invitation",
        targetId: invitationId,
      });
    });
  }

  async reconcileAccepted(limit = 50): Promise<number> {
    const rows = await this.db
      .select({
        invitationId: schema.invitation.id,
        userId: schema.member.userId,
        email: schema.user.email,
      })
      .from(schema.invitation)
      .innerJoin(schema.member, eq(schema.member.organizationId, schema.invitation.organizationId))
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .leftJoin(
        schema.tenantMemberProfiles,
        eq(schema.tenantMemberProfiles.memberId, schema.member.id),
      )
      .leftJoin(
        schema.cabinetEmployeeLinks,
        eq(schema.cabinetEmployeeLinks.invitationId, schema.invitation.id),
      )
      .where(
        and(
          eq(schema.invitation.status, "accepted"),
          eq(schema.invitation.email, schema.user.email),
          or(
            isNull(schema.tenantMemberProfiles.memberId),
            isNotNull(schema.cabinetEmployeeLinks.invitationId),
          ),
        ),
      )
      .orderBy(asc(schema.invitation.id))
      .limit(limit);
    let reconciled = 0;
    for (const row of rows) {
      try {
        await this.finalizeAccepted(row.invitationId, row.userId, row.email);
        reconciled += 1;
      } catch (error) {
        this.#logger.error(
          `Could not reconcile accepted invitation ${row.invitationId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return reconciled;
  }

  private async rejectAtomically(
    client: MailPgClient,
    invitationId: string,
    organizationId: string,
    userId: string,
    userEmail: string,
    sessionId: string,
  ): Promise<Response> {
    type InvitationRow = {
      id: string;
      organizationId: string;
      email: string;
      role: string | null;
      status: string;
      expiresAt: Date;
      createdAt: Date;
      inviterId: string;
    };
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), $2)", [
        `subscription-quota:${organizationId}`,
        4,
      ]);
      const authorized = await client.query<{ role: string | null }>(
        `SELECT invitation.role
         FROM invitation
         INNER JOIN organization ON organization.id = invitation.organization_id
         INNER JOIN "user" ON "user".id = $3
         INNER JOIN "session" ON "session".id = $5
           AND "session".user_id = "user".id
           AND "session".expires_at > now()
         WHERE invitation.id = $1
           AND invitation.organization_id = $2
           AND invitation.status = 'pending'
           AND invitation.expires_at > now()
           AND lower(invitation.email) = lower($4)
           AND lower("user".email) = lower(invitation.email)
         FOR UPDATE OF invitation`,
        [invitationId, organizationId, userId, userEmail, sessionId],
      );
      const role = authorized.rows[0]?.role;
      if (!role) throw new NotFoundException({ code: "invitation_unavailable" });

      await client.query(
        `SELECT id
         FROM email_deliveries
         WHERE tenant_id = $1 AND source_id = $2
         ORDER BY id
         FOR UPDATE`,
        [organizationId, invitationId],
      );
      const rejected = await client.query<InvitationRow>(
        `UPDATE invitation
         SET status = 'rejected'
         WHERE id = $1
           AND organization_id = $2
           AND status = 'pending'
           AND expires_at > now()
         RETURNING id,
                   organization_id AS "organizationId",
                   email,
                   role,
                   status,
                   expires_at AS "expiresAt",
                   created_at AS "createdAt",
                   inviter_id AS "inviterId"`,
        [invitationId, organizationId],
      );
      const row = rejected.rows[0];
      if (!row) throw new NotFoundException({ code: "invitation_unavailable" });
      await client.query(
        `DELETE FROM email_outbox
         WHERE delivery_id IN (
           SELECT id FROM email_deliveries WHERE tenant_id = $1 AND source_id = $2
         )`,
        [organizationId, invitationId],
      );
      await client.query(
        `UPDATE email_deliveries
         SET status = 'canceled',
             encrypted_payload = null,
             payload_nonce = null,
             payload_tag = null,
             attempt_id = null,
             attempt_deadline = null,
             terminal_at = now(),
             updated_at = now()
         WHERE tenant_id = $1
           AND source_id = $2
           AND status = ANY($3::email_delivery_status[])`,
        [organizationId, invitationId, ["queued", "sending", "retrying"]],
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
        `INSERT INTO tenant_audit_events
           (organization_id, actor_user_id, action, outcome, target_type, target_id, before, after)
         VALUES ($1, $2, 'team.invitation.rejected', 'success', 'invitation', $3, $4::jsonb, $5::jsonb)`,
        [
          organizationId,
          userId,
          invitationId,
          JSON.stringify({ status: "pending", role }),
          JSON.stringify({ status: "rejected", role }),
        ],
      );
      await client.query("COMMIT");
      return Response.json({ invitation: row, member: null });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  private async withInvitationDeliveryLock<T>(
    invitationId: string,
    organizationId: string,
    action: (client: MailPgClient) => Promise<T>,
  ): Promise<T> {
    const [delivery] = await this.db
      .select({ id: schema.emailDeliveries.id })
      .from(schema.emailDeliveries)
      .where(
        and(
          eq(schema.emailDeliveries.tenantId, organizationId),
          eq(schema.emailDeliveries.sourceId, invitationId),
          inArray(schema.emailDeliveries.status, ["queued", "sending", "retrying"]),
        ),
      )
      .orderBy(desc(schema.emailDeliveries.createdAt))
      .limit(1);
    if (!delivery) {
      const client = await this.pool.connect();
      try {
        return await action(client);
      } finally {
        client.release();
      }
    }
    const result = await this.mailJobs.withDeliveryLock(delivery.id, action);
    if (!result.acquired) throw new ConflictException({ code: "delivery_in_flight" });
    return result.value;
  }

  private async requirePending(invitationId: string) {
    const [row] = await this.db
      .select({
        id: schema.invitation.id,
        email: schema.invitation.email,
        role: schema.invitation.role,
        expiresAt: schema.invitation.expiresAt,
        organizationId: schema.invitation.organizationId,
        organizationName: schema.organization.name,
      })
      .from(schema.invitation)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.invitation.organizationId))
      .where(
        and(
          eq(schema.invitation.id, invitationId),
          eq(schema.invitation.status, "pending"),
          gt(schema.invitation.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!row || !row.role) {
      throw new NotFoundException({ code: "invitation_unavailable" });
    }
    return { ...row, email: row.email.toLocaleLowerCase("en-US"), role: row.role };
  }
}

function maskOrganizationName(value: string): string {
  const name = value.trim();
  return name.length <= 1 ? "•" : `${name[0]}${"•".repeat(Math.min(name.length - 1, 8))}`;
}

function splitLegacyName(name: string) {
  const [lastName = "", firstName = "", ...middle] = name.trim().split(/\s+/);
  return {
    firstName: firstName || lastName || "Пользователь",
    lastName: firstName ? lastName : "",
    middleName: middle.length ? middle.join(" ") : null,
  };
}
