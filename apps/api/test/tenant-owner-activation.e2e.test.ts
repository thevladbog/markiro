import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, schema } from "@markiro/db";
import { provisionTenantOwner } from "../src/cli/provision-tenant-owner";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../src/modules/mail/mail-delivery.service";
import { TenantOwnerActivationService } from "../src/modules/tenant-owner-activation/tenant-owner-activation.service";

const hashCredentialPassword = hashPassword as unknown as (password: string) => Promise<string>;
const verifyCredentialPassword = verifyPassword as unknown as (input: {
  hash: string;
  password: string;
}) => Promise<boolean>;

const ready = Boolean(process.env.DATABASE_URL);

describe.skipIf(!ready)("tenant owner activation", () => {
  const connection = createDb(process.env.DATABASE_URL!);
  const activation = new TenantOwnerActivationService(connection.db);
  const mail = new MailDeliveryService(new MailCryptoService(Buffer.alloc(32, 0x72)));

  afterAll(async () => {
    await connection.pool.end();
  });

  it("verifies a fresh owner and creates a credential exactly once", async () => {
    const token = `fresh-${randomUUID()}`;
    const email = `fresh-activation-${randomUUID()}@example.com`;
    const result = await provisionTenantOwner({
      db: connection.db,
      mail,
      adminOrigin: "https://cabinet.example.test",
      input: {
        email,
        tenantName: "Fresh activation tenant",
        tenantSlug: `fresh-activation-${randomUUID()}`,
      },
      createToken: () => token,
    });

    await expect(activation.getStatus(token)).resolves.toEqual({ hasAccount: false });
    await activation.complete(token, { password: "fresh-password-123" });

    const [user] = await connection.db
      .select({ emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.id, result.userId));
    const [account] = await connection.db
      .select({ password: schema.account.password })
      .from(schema.account)
      .where(
        and(eq(schema.account.userId, result.userId), eq(schema.account.providerId, "credential")),
      );
    expect(user?.emailVerified).toBe(true);
    expect(account?.password).toEqual(expect.any(String));
    await expect(
      verifyCredentialPassword({ hash: account!.password!, password: "fresh-password-123" }),
    ).resolves.toBe(true);
    await expect(activation.complete(token, { password: "another-password" })).rejects.toThrow();

    await connection.db
      .delete(schema.organization)
      .where(eq(schema.organization.id, result.tenantId));
    await connection.db.delete(schema.user).where(eq(schema.user.id, result.userId));
  });

  it("verifies an existing multi-tenant account without changing its credential", async () => {
    const userId = randomUUID();
    const existingTenantId = randomUUID();
    const existingMemberId = randomUUID();
    const email = `existing-activation-${randomUUID()}@example.com`;
    const originalHash = await hashCredentialPassword("existing-password-123");
    await connection.db.insert(schema.user).values({
      id: userId,
      name: "Existing user",
      email,
      emailVerified: false,
    });
    await connection.db.insert(schema.account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: originalHash,
    });
    await connection.db.insert(schema.organization).values({
      id: existingTenantId,
      name: "Existing tenant",
      slug: `existing-${randomUUID()}`,
      createdAt: new Date(),
    });
    await connection.db.insert(schema.member).values({
      id: existingMemberId,
      organizationId: existingTenantId,
      userId,
      role: "manager",
      createdAt: new Date(),
    });

    const token = `existing-${randomUUID()}`;
    const result = await provisionTenantOwner({
      db: connection.db,
      mail,
      adminOrigin: "https://cabinet.example.test",
      input: {
        email,
        tenantName: "Second tenant",
        tenantSlug: `second-${randomUUID()}`,
      },
      createToken: () => token,
    });

    await expect(activation.getStatus(token)).resolves.toEqual({ hasAccount: true });
    await activation.complete(token, {});

    const [account] = await connection.db
      .select({ password: schema.account.password })
      .from(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "credential")));
    const [user] = await connection.db
      .select({ emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(account?.password).toBe(originalHash);
    expect(user?.emailVerified).toBe(true);

    await connection.db
      .delete(schema.organization)
      .where(eq(schema.organization.id, result.tenantId));
    await connection.db
      .delete(schema.organization)
      .where(eq(schema.organization.id, existingTenantId));
    await connection.db.delete(schema.user).where(eq(schema.user.id, userId));
  });
});
