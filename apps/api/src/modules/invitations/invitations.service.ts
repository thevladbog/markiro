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
import { AUTH, DB } from "../../auth/auth.module";
import { MailJobsService } from "../mail/mail-jobs.service";
import type { PublicInvitationDto, RegisterInvitationDto } from "./dto";

@Injectable()
export class InvitationsService {
  readonly #logger = new Logger(InvitationsService.name);
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
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
    const userEmail = typeof session.user.email === "string" ? session.user.email : "";
    if (userEmail.toLocaleLowerCase("en-US") !== invitation.email) {
      throw new ForbiddenException("Signed-in account is not the invitation recipient");
    }
    return this.withInvitationDeliveryLock(invitationId, invitation.organizationId, async () => {
      const response = await this.auth.api.rejectInvitation({
        body: { invitationId },
        headers,
        asResponse: true,
      });
      if (response.ok) {
        await this.cleanupRejected(invitationId, invitation.organizationId, session.user.id);
      }
      return response;
    });
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

  private async cleanupRejected(invitationId: string, organizationId: string, userId: string) {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.cabinetEmployeeLinks)
        .where(eq(schema.cabinetEmployeeLinks.invitationId, invitationId));
      await tx
        .delete(schema.tenantInvitationProfiles)
        .where(eq(schema.tenantInvitationProfiles.invitationId, invitationId));
      await tx
        .update(schema.emailDeliveries)
        .set({
          status: "canceled",
          encryptedPayload: null,
          payloadNonce: null,
          payloadTag: null,
          terminalAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.emailDeliveries.tenantId, organizationId),
            eq(schema.emailDeliveries.sourceId, invitationId),
            inArray(schema.emailDeliveries.status, ["queued", "retrying"]),
          ),
        );
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId,
        actorUserId: userId,
        action: "team.invitation.rejected",
        outcome: "success",
        targetType: "invitation",
        targetId: invitationId,
      });
    });
  }

  private async withInvitationDeliveryLock<T>(
    invitationId: string,
    organizationId: string,
    action: () => Promise<T>,
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
    if (!delivery) return action();
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
