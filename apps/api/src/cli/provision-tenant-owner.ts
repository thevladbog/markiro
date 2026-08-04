import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@markiro/db";
import { z } from "zod";
import { loadEnv } from "../env";
import { MailCryptoService } from "../modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../modules/mail/mail-delivery.service";
import { activationIdentifier } from "../modules/tenant-owner-activation/token";

const provisionInputSchema = z.object({
  email: z
    .string()
    .transform((value) => value.trim().toLocaleLowerCase("en-US"))
    .pipe(z.email()),
  tenantName: z.string().trim().min(1),
  tenantSlug: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "tenant slug must use lowercase letters, digits, and hyphens",
    ),
});

export type ProvisionTenantOwnerInput = z.infer<typeof provisionInputSchema>;

export interface ProvisionTenantOwnerResult {
  tenantId: string;
  userId: string;
  memberId: string;
  deliveryId: string;
}

interface ProvisionTenantOwnerOptions {
  db: Db;
  mail: MailDeliveryService;
  adminOrigin: string;
  input: ProvisionTenantOwnerInput;
  now?: () => Date;
  createId?: () => string;
  createToken?: () => string;
  renewActivation?: boolean;
}

/**
 * Creates the first cabinet owner without ever handling a password. The owner
 * receives a one-time Better Auth reset token and chooses their password in
 * the cabinet. Re-running the command with the same tenant and email returns
 * the original identifiers and never queues a second activation email.
 */
export async function provisionTenantOwner(
  options: ProvisionTenantOwnerOptions,
): Promise<ProvisionTenantOwnerResult> {
  const input = provisionInputSchema.parse(options.input);
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const createToken = options.createToken ?? (() => randomBytes(24).toString("base64url"));
  const sourceIdPrefix = "tenant-owner:";

  return options.db.transaction(async (tx) => {
    // Fixed lock order prevents both duplicate command runs and a race where
    // the same new account is provisioned into two tenants concurrently.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-owner-email:${input.email}`}, 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-owner-slug:${input.tenantSlug}`}, 0))`,
    );

    let [tenant] = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.slug, input.tenantSlug))
      .limit(1);
    if (!tenant) {
      tenant = { id: createId() };
      await tx.insert(schema.organization).values({
        id: tenant.id,
        name: input.tenantName,
        slug: input.tenantSlug,
        createdAt: now(),
      });
    }

    let [user] = await tx
      .select({ id: schema.user.id, emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.email, input.email))
      .limit(1);
    if (!user) {
      user = { id: createId(), emailVerified: false };
      await tx.insert(schema.user).values({
        id: user.id,
        email: input.email,
        name: input.email,
        emailVerified: false,
      });
    }

    const tenantMembers = await tx
      .select({
        id: schema.member.id,
        userId: schema.member.userId,
        role: schema.member.role,
      })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenant.id));
    const existingMember = tenantMembers.find((member) => member.userId === user.id);
    if (tenantMembers.length > 0 && !existingMember) {
      throw new Error(`Tenant "${input.tenantSlug}" already has a different first member`);
    }
    if (existingMember && existingMember.role !== "owner") {
      throw new Error(`Existing first member of tenant "${input.tenantSlug}" is not an owner`);
    }

    await tx
      .insert(schema.userProfiles)
      .values({ userId: user.id, firstName: "", lastName: "" })
      .onConflictDoNothing({ target: schema.userProfiles.userId });

    const memberId = existingMember?.id ?? createId();
    if (!existingMember) {
      await tx.insert(schema.member).values({
        id: memberId,
        organizationId: tenant.id,
        userId: user.id,
        role: "owner",
        createdAt: now(),
      });
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenant.id,
        actorUserId: null,
        action: "tenant.owner.provisioned",
        outcome: "success",
        targetType: "member",
        targetId: memberId,
      });
    }

    const sourceId = `${sourceIdPrefix}${tenant.id}`;
    const subjectValue = JSON.stringify({ userId: user.id, tenantId: tenant.id });
    let [existingDelivery] = await tx
      .select({ id: schema.emailDeliveries.id, status: schema.emailDeliveries.status })
      .from(schema.emailDeliveries)
      .where(
        and(
          eq(schema.emailDeliveries.userId, user.id),
          eq(schema.emailDeliveries.kind, "tenant-owner-activation"),
          eq(schema.emailDeliveries.sourceId, sourceId),
        ),
      )
      .orderBy(desc(schema.emailDeliveries.createdAt), desc(schema.emailDeliveries.id))
      .limit(1);

    let deliveryId = existingDelivery?.id;
    if (options.renewActivation && existingDelivery) {
      if (user.emailVerified) {
        throw new Error("Owner email is already verified; use the password-recovery flow");
      }
      // The mail worker uses a session-level lock over this exact hash. Never
      // wait for it: the worker could successfully send while this command is
      // blocked, leaving the recipient with a link that renewal then revokes.
      const deliveryLock = await tx.execute(
        sql<{
          locked: boolean;
        }>`select pg_try_advisory_xact_lock(hashtextextended(${existingDelivery.id}, 0)) as locked`,
      );
      if (deliveryLock.rows[0]?.locked !== true) {
        throw new Error("Activation delivery is currently sending; retry after it settles");
      }
      const [lockedDelivery] = await tx
        .select({ id: schema.emailDeliveries.id, status: schema.emailDeliveries.status })
        .from(schema.emailDeliveries)
        .where(eq(schema.emailDeliveries.id, existingDelivery.id))
        .limit(1);
      if (!lockedDelivery) throw new Error("Activation delivery disappeared during renewal");
      existingDelivery = lockedDelivery;
      if (lockedDelivery.status === "sending") {
        throw new Error("Activation delivery is currently sending; retry after it settles");
      }
      if (lockedDelivery.status === "sent") {
        const scrubbed = await tx
          .update(schema.emailDeliveries)
          .set({
            encryptedPayload: null,
            payloadNonce: null,
            payloadTag: null,
            updatedAt: now(),
          })
          .where(
            and(
              eq(schema.emailDeliveries.id, lockedDelivery.id),
              eq(schema.emailDeliveries.status, "sent"),
            ),
          )
          .returning({ id: schema.emailDeliveries.id });
        if (scrubbed.length !== 1) throw new Error("Activation delivery changed during renewal");
      } else {
        const canceled = await tx
          .update(schema.emailDeliveries)
          .set({
            status: "canceled",
            encryptedPayload: null,
            payloadNonce: null,
            payloadTag: null,
            attemptId: null,
            attemptDeadline: null,
            terminalAt: now(),
            updatedAt: now(),
          })
          .where(
            and(
              eq(schema.emailDeliveries.id, lockedDelivery.id),
              inArray(schema.emailDeliveries.status, ["queued", "retrying", "failed", "canceled"]),
            ),
          )
          .returning({ id: schema.emailDeliveries.id });
        if (canceled.length !== 1) throw new Error("Activation delivery changed during renewal");
      }
      await tx
        .delete(schema.emailOutbox)
        .where(eq(schema.emailOutbox.deliveryId, lockedDelivery.id));
      await tx
        .delete(schema.verification)
        .where(
          and(
            eq(schema.verification.value, subjectValue),
            sql`${schema.verification.identifier} like 'tenant-owner-activation:%'`,
          ),
        );
      deliveryId = undefined;
    }
    if (!deliveryId) {
      const token = createToken();
      const expiresAt = new Date(now().getTime() + 60 * 60 * 1_000);
      await tx.insert(schema.verification).values({
        id: createId(),
        identifier: activationIdentifier(token),
        value: subjectValue,
        expiresAt,
      });
      const actionUrl = new URL("/activate-owner", options.adminOrigin);
      actionUrl.hash = new URLSearchParams({ token }).toString();
      deliveryId = await options.mail.enqueue(tx, {
        scope: { userId: user.id },
        recipient: input.email,
        sourceId,
        template: {
          kind: "tenant-owner-activation",
          recipientName: "Пользователь",
          organizationName: input.tenantName,
          actionUrl: actionUrl.toString(),
          expiresInMinutes: 60,
        },
      });
      if (options.renewActivation && existingDelivery) {
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenant.id,
          actorUserId: null,
          action: "tenant.owner.activation_renewed",
          outcome: "success",
          targetType: "email_delivery",
          targetId: deliveryId,
        });
      }
    }

    return { tenantId: tenant.id, userId: user.id, memberId, deliveryId };
  });
}

export function parseProvisionTenantOwnerArgs(argv: string[]): ProvisionTenantOwnerInput {
  // pnpm 11 forwards the conventional script separator to the child process.
  // Accept exactly one leading separator so the documented command works,
  // while preserving strict rejection of unexpected arguments elsewhere.
  const { args } = normalizeCliArgs(argv);
  if (args.some((argument) => argument === "--password" || argument.startsWith("--password="))) {
    throw new Error("Password arguments are forbidden; the owner sets it through email");
  }
  const values: Record<string, string> = {};
  const allowed = new Set(["--email", "--tenant-name", "--tenant-slug"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !allowed.has(flag)) throw new Error("Unknown or malformed argument");
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (values[flag] !== undefined) throw new Error(`Duplicate argument: ${flag}`);
    values[flag] = value;
  }
  return provisionInputSchema.parse({
    email: values["--email"],
    tenantName: values["--tenant-name"],
    tenantSlug: values["--tenant-slug"],
  });
}

function normalizeCliArgs(argv: string[]): { args: string[]; renewActivation: boolean } {
  const withoutSeparator = argv[0] === "--" ? argv.slice(1) : argv;
  let renewActivation = false;
  const args: string[] = [];
  for (const argument of withoutSeparator) {
    if (argument !== "--renew-activation") {
      args.push(argument);
      continue;
    }
    if (renewActivation) throw new Error("Duplicate argument: --renew-activation");
    renewActivation = true;
  }
  return { args, renewActivation };
}

interface CliStream {
  write(value: string): unknown;
}

export async function runProvisionTenantOwnerCli(options: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: CliStream;
  stderr?: CliStream;
}): Promise<number> {
  try {
    // Parse before configuration or database setup so forbidden password
    // arguments fail without touching infrastructure and can never enter a
    // connection/configuration error.
    const input = parseProvisionTenantOwnerArgs(options.argv);
    const { renewActivation } = normalizeCliArgs(options.argv);
    const env = loadEnv(options.env);
    const { db, pool } = createDb(env.DATABASE_URL);
    try {
      const result = await provisionTenantOwner({
        db,
        mail: new MailDeliveryService(new MailCryptoService(env.MAIL_PAYLOAD_ENCRYPTION_KEY)),
        adminOrigin: env.ADMIN_ORIGIN,
        input,
        renewActivation,
      });
      (options.stdout ?? process.stdout).write(`${JSON.stringify(result)}\n`);
    } finally {
      await pool.end();
    }
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Tenant owner provisioning failed";
    (options.stderr ?? process.stderr).write(`${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  void runProvisionTenantOwnerCli({ argv: process.argv.slice(2) }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
