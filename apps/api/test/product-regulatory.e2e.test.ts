import { createHash, randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, eq } from "drizzle-orm";
import express from "express";
import { schema, type Db } from "@markiro/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("product regulatory e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    })
      .overrideProvider(ObjectStorageService)
      .useValue({
        ensureBucket: vi.fn().mockResolvedValue(undefined),
        put: vi.fn(),
        delete: vi.fn(),
        get: vi.fn(),
        presignRead: vi.fn(),
      })
      .compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpAndActivate(agent: ReturnType<typeof request.agent>) {
    const email = `reg-${randomUUID()}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "Regulatory owner" })
      .expect(200);
    const organization = await agent
      .post("/api/auth/organization/create")
      .send({
        name: "Regulatory Plant",
        slug: `regulatory-${randomUUID()}`,
        keepCurrentActiveOrganization: true,
      })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: organization.body.id })
      .expect(200);
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, organization.body.id as string))
      .limit(1);
    if (!member) throw new Error("Expected organization owner");
    return { tenantId: organization.body.id as string, actorUserId: member.userId };
  }

  async function seedProfile(tenantId: string, actorUserId: string) {
    const productId = randomUUID();
    const schemaVersionId = randomUUID();
    const scopeKey = `category:softdrinks|tnved:${randomUUID()}`;
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: `0${String(Date.now()).slice(-13)}`,
      name: "Напиток",
      chzProductGroupCode: 23,
      boxCapacity: 12,
      palletCapacity: 60,
      status: "active",
    });
    await db.insert(schema.nationalCatalogSchemaVersions).values({
      id: schemaVersionId,
      scopeKey,
      categoryId: "softdrinks",
      categoryName: "Безалкогольные напитки",
      selectors: {},
      contentHash: createHash("sha256").update(scopeKey).digest("hex"),
      definition: {
        categoryId: "softdrinks",
        scopeKey,
        attributes: [
          {
            id: "hasSweetener",
            label: "Содержит подсластитель",
            valueType: "boolean",
            multiplicity: "one",
            requiredLayers: ["circulation"],
            requiredWhen: [],
            presets: [],
          },
        ],
      },
      status: "active",
      fetchedAt: new Date(),
      validatedAt: new Date(),
      activatedAt: new Date(),
    });
    await db.insert(schema.productRegulatoryProfiles).values({
      tenantId,
      productId,
      categoryId: "softdrinks",
      categoryName: "Безалкогольные напитки",
      schemaVersionId,
      source: "manual",
      confirmedBy: actorUserId,
      confirmedAt: new Date(),
    });
    return { productId, schemaVersionId };
  }

  it("reads a tenant profile and keeps readiness dimensions independent", async () => {
    const owner = request.agent(app!.getHttpServer());
    const foreign = request.agent(app!.getHttpServer());
    const tenant = await signUpAndActivate(owner);
    await signUpAndActivate(foreign);
    const seeded = await seedProfile(tenant.tenantId, tenant.actorUserId);

    const profile = await owner.get(`/products/${seeded.productId}/regulatory-profile`).expect(200);
    expect(profile.body).toMatchObject({
      productId: seeded.productId,
      binding: { revision: 1, categoryId: "softdrinks" },
    });

    const readiness = await owner.get(`/products/${seeded.productId}/readiness`).expect(200);
    expect(readiness.body.dimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: "production", state: "ready" }),
        expect.objectContaining({ dimension: "circulation", state: "not_ready" }),
        expect.objectContaining({ dimension: "egais", state: "not_applicable" }),
      ]),
    );
    await foreign.get(`/products/${seeded.productId}/regulatory-profile`).expect(404);
  });

  it("stores a manual typed value, increments revision, and writes an exact audit event", async () => {
    const owner = request.agent(app!.getHttpServer());
    const tenant = await signUpAndActivate(owner);
    const seeded = await seedProfile(tenant.tenantId, tenant.actorUserId);

    const response = await owner
      .patch(`/products/${seeded.productId}/regulatory-attributes`)
      .send({
        baseRevision: 1,
        values: [{ attributeId: "hasSweetener", value: { type: "boolean", value: false } }],
      })
      .expect(200);
    expect(response.body).toMatchObject({
      binding: { revision: 2 },
      values: [
        {
          attributeId: "hasSweetener",
          value: { type: "boolean", value: false },
          source: "manual",
        },
      ],
    });

    const [audit] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenant.tenantId),
          eq(schema.tenantAuditEvents.action, "product.regulatory_attributes.updated"),
          eq(schema.tenantAuditEvents.targetId, seeded.productId),
        ),
      )
      .limit(1);
    expect(audit).toMatchObject({
      actorUserId: tenant.actorUserId,
      outcome: "success",
      targetType: "product",
      before: [{ attributeId: "hasSweetener", value: null }],
      after: [{ attributeId: "hasSweetener", value: { type: "boolean", value: false } }],
    });
  });
});
