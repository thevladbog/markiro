import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schema } from "@markiro/db";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../src/modules/mail/mail-delivery.service";
import { activationIdentifier } from "../src/modules/tenant-owner-activation/token";
import {
  parseProvisionTenantOwnerArgs,
  provisionTenantOwner,
  runProvisionTenantOwnerCli,
} from "../src/cli/provision-tenant-owner";
import { DefaultDemoSettingFixture } from "./support/default-demo-setting";

const ready = Boolean(process.env.DATABASE_URL);

describe.skipIf(!ready)("tenant owner provisioning", () => {
  const connection = createDb(process.env.DATABASE_URL!);
  const defaultDemo = new DefaultDemoSettingFixture(connection.db);

  async function createDemo(durationDays = 14, published = true): Promise<string> {
    const itemId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await connection.db.insert(schema.catalogItems).values({
      id: itemId,
      code: `test-demo-${crypto.randomUUID()}`,
      nameRu: "Демо",
      nameEn: "Demo",
      kind: "plan",
    });
    await connection.db.insert(schema.catalogItemVersions).values({
      id: versionId,
      catalogItemId: itemId,
      kind: "plan",
      version: 1,
      nameRu: "Демо",
      nameEn: "Demo",
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
    if (published) {
      await connection.db
        .update(schema.catalogItemVersions)
        .set({ status: "published", publishedAt: new Date() })
        .where(eq(schema.catalogItemVersions.id, versionId));
    }
    return versionId;
  }

  async function useDemo(durationDays = 14, published = true): Promise<string> {
    const versionId = await createDemo(durationDays, published);
    await defaultDemo.install(versionId);
    return versionId;
  }

  beforeAll(async () => {
    await defaultDemo.capture();
  });

  afterAll(async () => {
    try {
      const deliveries = await connection.db
        .select({ id: schema.emailDeliveries.id })
        .from(schema.emailDeliveries)
        .where(
          or(
            like(schema.emailDeliveries.recipient, "first-owner-%@example.com"),
            like(schema.emailDeliveries.recipient, "renew-owner-%@example.com"),
            like(schema.emailDeliveries.recipient, "locked-renew-%@example.com"),
            like(schema.emailDeliveries.recipient, "unmanaged-owner-%@example.com"),
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
    } finally {
      try {
        await defaultDemo.restore();
      } finally {
        await connection.pool.end();
      }
    }
  });

  it("creates one tenant, owner, incomplete profile, and activation delivery when repeated", async () => {
    const demoVersionId = await useDemo();
    const suffix = crypto.randomUUID();
    const email = `first-owner-${suffix}@example.com`;
    const tenantSlug = `first-tenant-${suffix}`;
    const mail = new MailDeliveryService(new MailCryptoService(Buffer.alloc(32, 0x71)), () =>
      crypto.randomUUID(),
    );

    const input = {
      email,
      tenantName: "Первый завод",
      tenantSlug,
    };
    const [first, concurrent] = await Promise.all([
      provisionTenantOwner({
        db: connection.db,
        mail,
        adminOrigin: "https://cabinet.example.test",
        input,
      }),
      provisionTenantOwner({
        db: connection.db,
        mail,
        adminOrigin: "https://cabinet.example.test",
        input,
      }),
    ]);
    const repeated = await provisionTenantOwner({
      db: connection.db,
      mail,
      adminOrigin: "https://cabinet.example.test",
      input,
    });

    expect(concurrent).toEqual(first);
    expect(repeated).toEqual(first);

    const organizations = await connection.db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, tenantSlug));
    const users = await connection.db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, email));
    const profiles = await connection.db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, first.userId));
    const memberships = await connection.db
      .select()
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, first.tenantId),
          eq(schema.member.userId, first.userId),
        ),
      );
    const deliveries = await connection.db
      .select()
      .from(schema.emailDeliveries)
      .where(
        and(
          eq(schema.emailDeliveries.userId, first.userId),
          eq(schema.emailDeliveries.sourceId, `tenant-owner:${first.tenantId}`),
        ),
      );
    const verifications = await connection.db
      .select()
      .from(schema.verification)
      .where(
        eq(
          schema.verification.value,
          JSON.stringify({ userId: first.userId, tenantId: first.tenantId }),
        ),
      );
    const accounts = await connection.db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, first.userId));
    const audits = await connection.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, first.tenantId));
    const subscriptions = await connection.db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, first.tenantId));
    const subscriptionEvents = await connection.db
      .select({
        kind: schema.subscriptionEvents.eventKind,
        tenantId: schema.subscriptionEvents.tenantId,
      })
      .from(schema.subscriptionEvents)
      .where(eq(schema.subscriptionEvents.tenantId, first.tenantId));

    expect(organizations).toHaveLength(1);
    expect(users).toHaveLength(1);
    expect(profiles).toEqual([
      expect.objectContaining({ userId: first.userId, firstName: "", lastName: "" }),
    ]);
    expect(memberships).toEqual([expect.objectContaining({ role: "owner" })]);
    expect(deliveries).toEqual([
      expect.objectContaining({ id: first.deliveryId, recipient: email, status: "queued" }),
    ]);
    expect(verifications).toHaveLength(1);
    expect(verifications[0]!.identifier).toMatch(/^tenant-owner-activation:/);
    expect(accounts).toHaveLength(0);
    expect(audits).toEqual([
      expect.objectContaining({
        action: "tenant.owner.provisioned",
        outcome: "success",
        targetType: "member",
        targetId: first.memberId,
      }),
    ]);
    expect(subscriptions).toEqual([
      expect.objectContaining({
        tenantId: first.tenantId,
        planVersionId: demoVersionId,
        status: "pending_activation",
        startsAt: null,
        endsAt: null,
      }),
    ]);
    expect(subscriptionEvents).toEqual([
      expect.objectContaining({ kind: "demo.provisioned", tenantId: first.tenantId }),
    ]);
  });

  it("renews an expired unused activation only when explicitly requested", async () => {
    await useDemo();
    const suffix = crypto.randomUUID();
    const email = `renew-owner-${suffix}@example.com`;
    const tenantSlug = `renew-tenant-${suffix}`;
    const mail = new MailDeliveryService(new MailCryptoService(Buffer.alloc(32, 0x73)));
    const base = {
      db: connection.db,
      mail,
      adminOrigin: "https://cabinet.example.test",
      input: { email, tenantName: "Renew tenant", tenantSlug },
    };
    const first = await provisionTenantOwner({
      ...base,
      createToken: () => "old-activation-token",
    });
    await connection.db
      .update(schema.verification)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.verification.identifier, activationIdentifier("old-activation-token")));
    await connection.db
      .update(schema.emailDeliveries)
      .set({ status: "failed", terminalAt: new Date() })
      .where(eq(schema.emailDeliveries.id, first.deliveryId));

    const renewed = await provisionTenantOwner({
      ...base,
      createToken: () => "new-activation-token",
      renewActivation: true,
    });
    expect(renewed).toMatchObject({
      tenantId: first.tenantId,
      userId: first.userId,
      memberId: first.memberId,
    });
    expect(renewed.deliveryId).not.toBe(first.deliveryId);

    const [oldDelivery] = await connection.db
      .select({
        status: schema.emailDeliveries.status,
        payload: schema.emailDeliveries.encryptedPayload,
      })
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.id, first.deliveryId));
    expect(oldDelivery).toEqual({ status: "canceled", payload: null });
    const tokens = await connection.db
      .select({ identifier: schema.verification.identifier })
      .from(schema.verification)
      .where(
        eq(
          schema.verification.value,
          JSON.stringify({ userId: first.userId, tenantId: first.tenantId }),
        ),
      );
    expect(tokens).toEqual([{ identifier: activationIdentifier("new-activation-token") }]);
  });

  it("rejects renewal while the mail worker owns the delivery lock", async () => {
    await useDemo();
    const suffix = crypto.randomUUID();
    const email = `locked-renew-${suffix}@example.com`;
    const input = {
      email,
      tenantName: "Locked renewal tenant",
      tenantSlug: `locked-renew-${suffix}`,
    };
    const mail = new MailDeliveryService(new MailCryptoService(Buffer.alloc(32, 0x74)));
    const first = await provisionTenantOwner({
      db: connection.db,
      mail,
      adminOrigin: "https://cabinet.example.test",
      input,
      createToken: () => "locked-old-activation-token",
    });
    const worker = await connection.pool.connect();
    await worker.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [first.deliveryId]);
    const renewal = provisionTenantOwner({
      db: connection.db,
      mail,
      adminOrigin: "https://cabinet.example.test",
      input,
      createToken: () => "locked-new-activation-token",
      renewActivation: true,
    }).then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    try {
      const outcome = await Promise.race([
        renewal,
        new Promise<{ kind: "timeout" }>((resolve) =>
          setTimeout(() => resolve({ kind: "timeout" }), 100),
        ),
      ]);
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect(outcome.error).toEqual(
          new Error("Activation delivery is currently sending; retry after it settles"),
        );
      }
    } finally {
      await worker.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [first.deliveryId]);
      worker.release();
    }
    await renewal;

    const [unchangedDelivery] = await connection.db
      .select({ status: schema.emailDeliveries.status })
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.id, first.deliveryId));
    expect(unchangedDelivery).toEqual({ status: "queued" });
  });

  it("fails before tenant writes without a default demo and allows only the explicit CLI compatibility path", async () => {
    await useDemo(14, false);
    const suffix = crypto.randomUUID();
    const input = {
      email: `unmanaged-owner-${suffix}@example.com`,
      tenantName: "Migration tenant",
      tenantSlug: `unmanaged-${suffix}`,
    };
    const mail = new MailDeliveryService(new MailCryptoService(Buffer.alloc(32, 0x75)));

    await expect(
      provisionTenantOwner({
        db: connection.db,
        mail,
        adminOrigin: "https://cabinet.example.test",
        input,
      }),
    ).rejects.toMatchObject({ response: { code: "default_demo_not_configured" } });
    expect(
      await connection.db
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.slug, input.tenantSlug)),
    ).toEqual([]);

    const unmanaged = await provisionTenantOwner({
      db: connection.db,
      mail,
      adminOrigin: "https://cabinet.example.test",
      input,
      allowUnmanagedWithoutDemo: true,
    });
    expect(
      await connection.db
        .select({ id: schema.tenantSubscriptions.id })
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, unmanaged.tenantId)),
    ).toEqual([]);
    const [audit] = await connection.db
      .select({
        action: schema.platformAuditEvents.action,
        reason: schema.platformAuditEvents.reason,
        tenantId: schema.platformAuditEvents.tenantId,
      })
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.tenantId, unmanaged.tenantId));
    expect(audit).toEqual({
      action: "platform.tenant.created_unmanaged",
      reason: "operator_allowed_unmanaged_without_default_demo",
      tenantId: unmanaged.tenantId,
    });

    const renewed = await provisionTenantOwner({
      db: connection.db,
      mail,
      adminOrigin: "https://cabinet.example.test",
      input,
      createToken: () => `renewed-${suffix}`,
      renewActivation: true,
    });
    expect(renewed).toMatchObject({
      tenantId: unmanaged.tenantId,
      userId: unmanaged.userId,
      memberId: unmanaged.memberId,
    });
    expect(renewed.deliveryId).not.toBe(unmanaged.deliveryId);
  });

  it("does not restore over a competing default-demo setting change", async () => {
    const earlierVersionId = await useDemo();
    const ownedVersionId = await useDemo();
    const competingFixture = new DefaultDemoSettingFixture(connection.db);
    await competingFixture.capture();
    await competingFixture.install(earlierVersionId);

    await expect(defaultDemo.restore()).resolves.toBe(false);
    const [unchanged] = await connection.db
      .select({ versionId: schema.platformSettings.defaultDemoCatalogVersionId })
      .from(schema.platformSettings)
      .where(eq(schema.platformSettings.key, "default"));
    expect(unchanged).toEqual({ versionId: earlierVersionId });

    await expect(competingFixture.restore()).resolves.toBe(true);
    const [restoredCompetitor] = await connection.db
      .select({ versionId: schema.platformSettings.defaultDemoCatalogVersionId })
      .from(schema.platformSettings)
      .where(eq(schema.platformSettings.key, "default"));
    expect(restoredCompetitor).toEqual({ versionId: ownedVersionId });
  });

  it("does not install over a competing default-demo change made after capture", async () => {
    const attemptedVersionId = await createDemo();
    const competingVersionId = await createDemo();
    const attemptedFixture = new DefaultDemoSettingFixture(connection.db);
    const competingFixture = new DefaultDemoSettingFixture(connection.db);
    await attemptedFixture.capture();
    await competingFixture.capture();
    await competingFixture.install(competingVersionId);

    try {
      await expect(attemptedFixture.install(attemptedVersionId)).rejects.toThrow(
        "Default demo setting ownership lost",
      );
      const [unchanged] = await connection.db
        .select({ versionId: schema.platformSettings.defaultDemoCatalogVersionId })
        .from(schema.platformSettings)
        .where(eq(schema.platformSettings.key, "default"));
      expect(unchanged).toEqual({ versionId: competingVersionId });
    } finally {
      const [current] = await connection.db
        .select({ versionId: schema.platformSettings.defaultDemoCatalogVersionId })
        .from(schema.platformSettings)
        .where(eq(schema.platformSettings.key, "default"));
      if (current?.versionId === attemptedVersionId) {
        await attemptedFixture.restore();
      } else if (current?.versionId === competingVersionId) {
        await competingFixture.restore();
      }
    }
  });
});

describe("tenant owner provisioning CLI arguments", () => {
  it("accepts pnpm's separator and normalizes the documented arguments", () => {
    expect(
      parseProvisionTenantOwnerArgs([
        "--",
        "--email",
        " Owner@Example.COM ",
        "--tenant-name",
        " Завод ",
        "--tenant-slug",
        "zavod",
      ]),
    ).toEqual({ email: "owner@example.com", tenantName: "Завод", tenantSlug: "zavod" });
  });

  it("accepts the explicit activation-renewal switch without treating it as a value", () => {
    expect(
      parseProvisionTenantOwnerArgs([
        "--renew-activation",
        "--email",
        "owner@example.com",
        "--tenant-name",
        "Завод",
        "--tenant-slug",
        "zavod",
      ]),
    ).toEqual({ email: "owner@example.com", tenantName: "Завод", tenantSlug: "zavod" });
  });

  it("accepts only the exact valueless unmanaged migration switch", () => {
    expect(
      parseProvisionTenantOwnerArgs([
        "--allow-unmanaged-without-demo",
        "--email",
        "owner@example.com",
        "--tenant-name",
        "Завод",
        "--tenant-slug",
        "zavod",
      ]),
    ).toEqual({ email: "owner@example.com", tenantName: "Завод", tenantSlug: "zavod" });
    expect(() =>
      parseProvisionTenantOwnerArgs([
        "--allow-unmanaged-without-demo=true",
        "--email",
        "owner@example.com",
        "--tenant-name",
        "Завод",
        "--tenant-slug",
        "zavod",
      ]),
    ).toThrow(/unknown|malformed/i);
  });

  it("rejects password arguments instead of accepting or returning a secret", () => {
    const sensitiveValue = `synthetic-${crypto.randomUUID()}`;
    expect(() =>
      parseProvisionTenantOwnerArgs([
        "--email",
        "owner@example.com",
        "--tenant-name",
        "Завод",
        "--tenant-slug",
        "zavod",
        "--password",
        sensitiveValue,
      ]),
    ).toThrow(/password/i);

    for (const args of [[`--password=${sensitiveValue}`], [sensitiveValue]]) {
      try {
        parseProvisionTenantOwnerArgs(args);
        throw new Error("Expected password-shaped arguments to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain(sensitiveValue);
      }
    }

    expect(
      parseProvisionTenantOwnerArgs([
        "--email",
        " Owner@Example.COM ",
        "--tenant-name",
        " Завод ",
        "--tenant-slug",
        "zavod",
      ]),
    ).toEqual({ email: "owner@example.com", tenantName: "Завод", tenantSlug: "zavod" });
  });

  it("keeps separated, equals, and positional secrets out of CLI output", async () => {
    const sensitiveValue = `synthetic-${crypto.randomUUID()}`;
    for (const args of [
      ["--password", sensitiveValue],
      [`--password=${sensitiveValue}`],
      [sensitiveValue],
    ]) {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      await expect(
        runProvisionTenantOwnerCli({ argv: args, env: {}, stdout, stderr }),
      ).resolves.toBe(1);
      expect(stdout.write).not.toHaveBeenCalled();
      expect(JSON.stringify(stderr.write.mock.calls)).not.toContain(sensitiveValue);
    }
  });

  it("keeps secrets out of the real documented pnpm invocation", () => {
    const sensitiveValue = `synthetic-${crypto.randomUUID()}`;
    const result = spawnSync(
      "pnpm",
      [
        "--silent",
        "--filter",
        "@markiro/api",
        "provision:tenant-owner",
        "--",
        `--password=${sensitiveValue}`,
      ],
      { cwd: resolve(process.cwd(), "../.."), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(`${result.stdout}${result.stderr}`).not.toContain(sensitiveValue);
  });

  it.skipIf(process.env.LOCAL_INFRA_SMOKE !== "1")(
    "prints only identifiers on stdout through the real documented command",
    async () => {
      const suffix = crypto.randomUUID();
      const result = spawnSync(
        "pnpm",
        [
          "--silent",
          "--filter",
          "@markiro/api",
          "provision:tenant-owner",
          "--",
          "--email",
          `subprocess-owner-${suffix}@example.com`,
          "--tenant-name",
          "Subprocess tenant",
          "--tenant-slug",
          `subprocess-${suffix}`,
          "--allow-unmanaged-without-demo",
        ],
        { cwd: resolve(process.cwd(), "../.."), encoding: "utf8", env: process.env },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(Object.keys(output).sort()).toEqual(["deliveryId", "memberId", "tenantId", "userId"]);
      const cleanupConnection = createDb(process.env.DATABASE_URL!);
      try {
        await cleanupConnection.db
          .delete(schema.organization)
          .where(eq(schema.organization.id, output.tenantId as string));
        await cleanupConnection.db
          .delete(schema.user)
          .where(eq(schema.user.id, output.userId as string));
      } finally {
        await cleanupConnection.pool.end();
      }
    },
    20_000,
  );
});
