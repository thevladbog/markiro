import express from "express";
import sharp from "sharp";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@markiro/db";
import { DefaultDemoSettingFixture } from "./support/default-demo-setting";
import { AppModule } from "../src/app.module";
import { provisionTenantOwner } from "../src/cli/provision-tenant-owner";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../src/modules/mail/mail-delivery.service";
import { MailJobsService } from "../src/modules/mail/mail-jobs.service";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = process.env.LOCAL_INFRA_SMOKE === "1";

describe.skipIf(!ready)("local Mailpit and MinIO product lifecycle", () => {
  let env: ReturnType<typeof loadEnv>;
  let setup: AuthSetup;
  let app: INestApplication;
  let jobs: MailJobsService;
  let defaultDemo: DefaultDemoSettingFixture;

  beforeAll(async () => {
    env = loadEnv();
    setup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    jobs = app.get(MailJobsService);
    await app.get(ObjectStorageService).ensureBucket();

    defaultDemo = new DefaultDemoSettingFixture(setup.db);
    await defaultDemo.capture();
    const itemId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await setup.db.insert(schema.catalogItems).values({
      id: itemId,
      code: `infra-demo-${crypto.randomUUID()}`,
      nameRu: "Демо",
      nameEn: "Demo",
      kind: "plan",
    });
    await setup.db.insert(schema.catalogItemVersions).values({
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
      status: "draft",
    });
    await setup.db.insert(schema.planEntitlements).values({
      catalogVersionId: versionId,
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 2,
      demoDurationDays: 14,
    });
    await setup.db
      .update(schema.catalogItemVersions)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(schema.catalogItemVersions.id, versionId));
    await defaultDemo.install(versionId);
  });

  afterAll(async () => {
    try {
      await defaultDemo?.restore();
    } finally {
      await app?.close();
    }
  });

  it("activates an owner, follows an invitation, and manages private avatars", async () => {
    const suffix = crypto.randomUUID();
    const email = `infra-owner-${suffix}@example.com`;
    const password = `Owner-${suffix}!Aa1`;
    const result = await provisionTenantOwner({
      db: setup.db,
      mail: new MailDeliveryService(new MailCryptoService(env.MAIL_PAYLOAD_ENCRYPTION_KEY)),
      adminOrigin: env.ADMIN_ORIGIN,
      input: {
        email,
        tenantName: "Infrastructure smoke tenant",
        tenantSlug: `infra-smoke-${suffix}`,
      },
    });

    await jobs.processDelivery(result.deliveryId);
    const activationHtml = await waitForCapturedHtml(email);
    expect(activationHtml).toContain("Активировать доступ");
    const token = extractActivationToken(activationHtml);

    const owner = request.agent(app.getHttpServer());
    await owner
      .post("/tenant-owner-activation/status")
      .send({ token })
      .expect(201, { hasAccount: false });
    await owner.post("/tenant-owner-activation/complete").send({ token, password }).expect(204);
    await owner.post("/api/auth/sign-in/email").send({ email, password }).expect(200);
    await owner
      .post("/api/auth/organization/set-active")
      .send({ organizationId: result.tenantId })
      .expect(200);
    await owner
      .patch("/profile")
      .send({ firstName: "Иван", lastName: "Владелец", middleName: null })
      .expect(200);

    const firstAvatar = await avatar("#2463eb");
    await owner
      .post("/profile/avatar")
      .attach("avatar", firstAvatar, { filename: "first.jpg", contentType: "image/jpeg" })
      .expect(201);
    const firstAsset = await activeAvatar(result.userId);
    await expectPrivate(firstAsset.objectKey);
    const firstSigned = await owner.get("/profile/avatar-url").expect(200);
    expect((await fetch(firstSigned.body.url as string)).status).toBe(200);

    const secondAvatar = await avatar("#18a56f");
    await owner
      .post("/profile/avatar")
      .attach("avatar", secondAvatar, { filename: "second.jpg", contentType: "image/jpeg" })
      .expect(201);
    const secondAsset = await activeAvatar(result.userId);
    expect(secondAsset.id).not.toBe(firstAsset.id);
    await expectPrivate(secondAsset.objectKey);
    expect((await fetch(firstSigned.body.url as string)).status).toBe(404);
    const secondSigned = await owner.get("/profile/avatar-url").expect(200);
    expect((await fetch(secondSigned.body.url as string)).status).toBe(200);
    await owner.delete("/profile/avatar").expect(204);
    expect((await fetch(secondSigned.body.url as string)).status).toBe(404);

    const inviteeEmail = `infra-invitee-${suffix}@example.com`;
    const invitation = await owner
      .post("/team/invitations")
      .send({ email: inviteeEmail, role: "manager", position: "Начальник смены" })
      .expect(201);
    const deliveryId = invitation.body.delivery?.id as string | undefined;
    expect(deliveryId).toEqual(expect.any(String));
    await jobs.processDelivery(deliveryId!);
    const invitationHtml = await waitForCapturedHtml(inviteeEmail);
    expect(invitationHtml).toContain(`/invitations/${invitation.body.id as string}`);

    const invitee = request.agent(app.getHttpServer());
    await invitee
      .post(`/invitations/${invitation.body.id as string}/register`)
      .send({
        firstName: "Мария",
        lastName: "Менеджер",
        middleName: null,
        password: `Invitee-${suffix}!Aa1`,
      })
      .expect(201);
    await invitee.post(`/invitations/${invitation.body.id as string}/accept`).expect(200);
    const [inviteeUser] = await setup.db
      .select({ id: schema.user.id, emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.email, inviteeEmail));
    const [inviteeMember] = await setup.db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, result.tenantId),
          eq(schema.member.userId, inviteeUser!.id),
        ),
      );
    expect(inviteeUser?.emailVerified).toBe(true);
    expect(inviteeMember?.role).toBe("manager");

    await setup.db.delete(schema.organization).where(eq(schema.organization.id, result.tenantId));
    await setup.db.delete(schema.user).where(eq(schema.user.id, result.userId));
    await setup.db.delete(schema.user).where(eq(schema.user.id, inviteeUser!.id));
  }, 30_000);

  async function activeAvatar(userId: string): Promise<{ id: string; objectKey: string }> {
    const [asset] = await setup.db
      .select({ id: schema.mediaAssets.id, objectKey: schema.mediaAssets.objectKey })
      .from(schema.userProfiles)
      .innerJoin(schema.mediaAssets, eq(schema.mediaAssets.id, schema.userProfiles.avatarAssetId))
      .where(eq(schema.userProfiles.userId, userId));
    if (!asset) throw new Error("Expected an active avatar asset");
    return asset;
  }

  async function expectPrivate(objectKey: string): Promise<void> {
    const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`${env.S3_ENDPOINT}${env.S3_BUCKET}/${encodedKey}`);
    expect(response.status).toBe(403);
  }
});

async function avatar(background: string): Promise<Buffer> {
  return sharp({ create: { width: 700, height: 300, channels: 3, background } })
    .jpeg()
    .toBuffer();
}

function extractActivationToken(html: string): string {
  const match = html.match(/\/activate-owner#token=([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error("Mailpit activation email had no fragment token");
  return match[1];
}

async function waitForCapturedHtml(email: string): Promise<string> {
  const query = new URLSearchParams({ query: `to:${email}` });
  const url = `http://127.0.0.1:8025/view/latest.html?${query}`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return response.text();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Mailpit did not capture a message for ${email}`);
}
