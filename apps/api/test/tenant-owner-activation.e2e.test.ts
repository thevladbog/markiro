import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, or } from "drizzle-orm";
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

  async function usePublishedDemo(durationDays: number): Promise<string> {
    const itemId = randomUUID();
    const versionId = randomUUID();
    await connection.db.insert(schema.catalogItems).values({
      id: itemId,
      code: `activation-demo-${randomUUID()}`,
      nameRu: "Демо активации",
      nameEn: "Activation demo",
      kind: "plan",
    });
    await connection.db.insert(schema.catalogItemVersions).values({
      id: versionId,
      catalogItemId: itemId,
      kind: "plan",
      version: 1,
      nameRu: "Демо активации",
      nameEn: "Activation demo",
      unit: "month",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: "0.00",
      vatIncluded: true,
    });
    await connection.db.insert(schema.planEntitlements).values({
      catalogVersionId: versionId,
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 2,
      demoDurationDays: durationDays,
    });
    await connection.db
      .update(schema.catalogItemVersions)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(schema.catalogItemVersions.id, versionId));
    await connection.db
      .insert(schema.platformSettings)
      .values({ key: "default", defaultDemoCatalogVersionId: versionId })
      .onConflictDoUpdate({
        target: schema.platformSettings.key,
        set: { defaultDemoCatalogVersionId: versionId, updatedAt: new Date() },
      });
    return versionId;
  }

  afterAll(async () => {
    const deliveries = await connection.db
      .select({ id: schema.emailDeliveries.id })
      .from(schema.emailDeliveries)
      .where(
        or(
          like(schema.emailDeliveries.recipient, "fresh-activation-%@example.com"),
          like(schema.emailDeliveries.recipient, "existing-activation-%@example.com"),
        ),
      );
    if (deliveries.length > 0) {
      await connection.db.delete(schema.emailOutbox).where(
        inArray(
          schema.emailOutbox.deliveryId,
          deliveries.map((delivery) => delivery.id),
        ),
      );
    }
    await connection.pool.end();
  });

  it("verifies a fresh owner and creates a credential exactly once", async () => {
    const demoVersionId = await usePublishedDemo(9);
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
    const [pendingBeforeCompletion] = await connection.db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, result.tenantId));
    expect(pendingBeforeCompletion).toEqual(
      expect.objectContaining({ status: "pending_activation", startsAt: null, endsAt: null }),
    );
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

    const [trial] = await connection.db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, result.tenantId));
    expect(trial).toEqual(
      expect.objectContaining({
        planVersionId: demoVersionId,
        status: "trial",
        startsAt: expect.any(Date),
        endsAt: expect.any(Date),
      }),
    );
    expect(trial!.endsAt!.getTime() - trial!.startsAt!.getTime()).toBe(9 * 24 * 60 * 60 * 1_000);
    const activationEvents = await connection.db
      .select({
        kind: schema.subscriptionEvents.eventKind,
        effectiveAt: schema.subscriptionEvents.effectiveAt,
      })
      .from(schema.subscriptionEvents)
      .where(
        and(
          eq(schema.subscriptionEvents.tenantId, result.tenantId),
          eq(schema.subscriptionEvents.eventKind, "demo.activated"),
        ),
      );
    expect(activationEvents).toEqual([{ kind: "demo.activated", effectiveAt: trial!.startsAt }]);
  });

  it("verifies an existing multi-tenant account without changing its credential", async () => {
    await usePublishedDemo(14);
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
    const [trial] = await connection.db
      .select({ status: schema.tenantSubscriptions.status })
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, result.tenantId));
    expect(trial).toEqual({ status: "trial" });
  });
});
