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
        formatVersion: 2,
        categoryId: "softdrinks",
        scopeKey,
        attributes: [
          {
            id: "hasSweetener",
            label: "Содержит подсластитель",
            valueType: "boolean",
            multiplicity: "one",
            unit: null,
            requirementRules: [{ layer: "circulation", level: "mandatory", when: null }],
            presetMode: "none",
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

  async function seedUnboundProduct(tenantId: string, groupCode = 23) {
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: gtin14(),
      name: "Новый товар",
      chzProductGroupCode: groupCode,
      boxCapacity: 12,
      palletCapacity: 60,
      status: "active",
    });
    return productId;
  }

  async function seedMappedSchema(
    actorUserId: string,
    groupCode = 23,
    mappingState: "exact" | "ambiguous" = "exact",
  ) {
    const schemaVersionId = randomUUID();
    const categoryId = `category-${randomUUID()}`;
    const scopeKey = `${categoryId}|group:${groupCode}`;
    await db.insert(schema.nationalCatalogSchemaVersions).values({
      id: schemaVersionId,
      scopeKey,
      categoryId,
      categoryName: "Проверяемая категория",
      selectors: { groupCode },
      contentHash: createHash("sha256").update(scopeKey).digest("hex"),
      definition: {
        formatVersion: 2,
        categoryId,
        scopeKey,
        attributes: [
          {
            id: "brandColor",
            label: "Цвет бренда",
            valueType: "string",
            multiplicity: "one",
            unit: null,
            requirementRules: [],
            presetMode: "none",
            presets: [],
          },
        ],
      },
      status: "active",
      fetchedAt: new Date(),
      validatedAt: new Date(),
      activatedAt: new Date(),
    });
    await db.insert(schema.nationalCatalogCategoryGroupMappings).values({
      chzProductGroupCode: groupCode,
      schemaVersionId,
      categoryId,
      state: mappingState,
      reviewedBy: actorUserId,
      reviewedAt: new Date(),
    });
    return { schemaVersionId, categoryId, scopeKey };
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

  it("previews and applies an exact category transfer, then stores multiple EGAIS codes", async () => {
    const owner = request.agent(app!.getHttpServer());
    const tenant = await signUpAndActivate(owner);
    const seeded = await seedProfile(tenant.tenantId, tenant.actorUserId);
    await owner
      .patch(`/products/${seeded.productId}/regulatory-attributes`)
      .send({
        baseRevision: 1,
        values: [{ attributeId: "hasSweetener", value: { type: "boolean", value: false } }],
      })
      .expect(200);

    const targetSchemaVersionId = randomUUID();
    const targetScope = `category:softdrinks-v2|tnved:${randomUUID()}`;
    await db.insert(schema.nationalCatalogSchemaVersions).values({
      id: targetSchemaVersionId,
      scopeKey: targetScope,
      categoryId: "softdrinks-v2",
      categoryName: "Напитки v2",
      selectors: {},
      contentHash: createHash("sha256").update(targetScope).digest("hex"),
      definition: {
        formatVersion: 2,
        categoryId: "softdrinks-v2",
        scopeKey: targetScope,
        attributes: [
          {
            id: "hasSweetener",
            label: "Содержит подсластитель",
            valueType: "boolean",
            multiplicity: "one",
            unit: null,
            requirementRules: [{ layer: "circulation", level: "mandatory", when: null }],
            presetMode: "none",
            presets: [],
          },
        ],
      },
      status: "active",
      fetchedAt: new Date(),
      validatedAt: new Date(),
      activatedAt: new Date(),
    });
    await db.insert(schema.nationalCatalogCategoryGroupMappings).values({
      chzProductGroupCode: 23,
      schemaVersionId: targetSchemaVersionId,
      categoryId: "softdrinks-v2",
      state: "exact",
    });

    const preview = await owner
      .post(`/products/${seeded.productId}/category-change-previews`)
      .send({
        baseRevision: 2,
        targetSchemaVersionId,
        tnVedCode: "2202991900",
        okpd2Code: null,
      })
      .expect(201);
    expect(preview.body.diff.entries).toEqual([
      expect.objectContaining({
        targetAttributeId: "hasSweetener",
        disposition: "transferable",
      }),
    ]);

    const applied = await owner
      .post(`/products/${seeded.productId}/regulatory-proposals/${preview.body.proposalId}/apply`)
      .send({ acceptedEntryIds: [preview.body.diff.entries[0].entryId] })
      .expect(200);
    expect(applied.body).toMatchObject({
      binding: { revision: 3, schemaVersionId: targetSchemaVersionId },
      values: [{ attributeId: "hasSweetener", source: "manual" }],
    });

    const primaryCode = "1234567890123456789";
    const secondaryCode = "9876543210987654321";
    const egais = await owner
      .put(`/products/${seeded.productId}/egais-codes`)
      .send({ baseRevision: 3, codes: [primaryCode, secondaryCode], primaryCode })
      .expect(200);
    expect(egais.body).toMatchObject({
      binding: { revision: 4 },
      egaisCodes: expect.arrayContaining([
        expect.objectContaining({ code: primaryCode, isPrimary: true }),
        expect.objectContaining({ code: secondaryCode, isPrimary: false }),
      ]),
    });
    const [product] = await db
      .select({ egaisCode: schema.products.egaisCode })
      .from(schema.products)
      .where(eq(schema.products.id, seeded.productId));
    expect(product?.egaisCode).toBe(primaryCode);
  });

  it("creates an initial binding, scopes lifecycle routes by tenant, and replays exactly once", async () => {
    const owner = request.agent(app!.getHttpServer());
    const foreign = request.agent(app!.getHttpServer());
    const tenant = await signUpAndActivate(owner);
    await signUpAndActivate(foreign);
    const productId = await seedUnboundProduct(tenant.tenantId);
    const targetSchema = await seedMappedSchema(tenant.actorUserId);

    const preview = await owner
      .post(`/products/${productId}/category-binding-previews`)
      .send({
        baseRevision: 0,
        targetSchemaVersionId: targetSchema.schemaVersionId,
        tnVedCode: null,
        okpd2Code: null,
      })
      .expect(201);
    expect(preview.body).toMatchObject({
      baseRevision: 0,
      diff: { version: 1, kind: "category_binding", entries: [] },
    });

    const proposalPath = `/products/${productId}/regulatory-proposals/${preview.body.proposalId}`;
    await foreign.get(proposalPath).expect(404);
    await foreign.post(`${proposalPath}/reject`).send({}).expect(404);
    await foreign.post(`${proposalPath}/apply`).send({ acceptedEntryIds: [] }).expect(404);
    await owner
      .get(proposalPath)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          id: preview.body.proposalId,
          kind: "category_binding",
          source: "manual",
          status: "preview",
          diff: preview.body.diff,
        });
      });

    const applied = await owner
      .post(`${proposalPath}/apply`)
      .send({ acceptedEntryIds: [] })
      .expect(200);
    expect(applied.body.binding).toMatchObject({
      revision: 1,
      schemaVersionId: targetSchema.schemaVersionId,
      source: "manual",
    });
    await owner.post(`${proposalPath}/apply`).send({ acceptedEntryIds: [] }).expect(200);
    await owner
      .post(`${proposalPath}/apply`)
      .send({ acceptedEntryIds: [randomUUID()] })
      .expect(409);

    const history = await db
      .select()
      .from(schema.productRegulatoryBindingHistory)
      .where(
        and(
          eq(schema.productRegulatoryBindingHistory.tenantId, tenant.tenantId),
          eq(schema.productRegulatoryBindingHistory.productId, productId),
        ),
      );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      proposalId: preview.body.proposalId,
      priorCategoryId: null,
      nextCategoryId: targetSchema.categoryId,
      resultingRevision: 1,
      source: "manual",
      actorId: tenant.actorUserId,
    });

    const audits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenant.tenantId),
          eq(schema.tenantAuditEvents.action, "product.regulatory_proposal.applied"),
          eq(schema.tenantAuditEvents.targetId, productId),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: tenant.actorUserId,
      outcome: "success",
      targetType: "product",
      after: expect.objectContaining({
        proposalId: preview.body.proposalId,
        proposalKind: "category_binding",
        source: "manual",
        sourceRef: null,
        priorRevision: 0,
        resultingRevision: 1,
        selectedEntryIds: [],
        selectionHash: createHash("sha256").update("[]").digest("hex"),
      }),
    });

    await owner.post(`${proposalPath}/reject`).send({}).expect(409);
    await owner
      .post(`/products/${productId}/category-binding-previews`)
      .send({
        baseRevision: 0,
        targetSchemaVersionId: targetSchema.schemaVersionId,
        tnVedCode: null,
        okpd2Code: null,
      })
      .expect(409);
  });

  it("enforces explicit binding/change semantics and category compatibility before preview", async () => {
    const owner = request.agent(app!.getHttpServer());
    const tenant = await signUpAndActivate(owner);
    const productId = await seedUnboundProduct(tenant.tenantId);
    const ambiguous = await seedMappedSchema(tenant.actorUserId, 23, "ambiguous");

    await owner
      .post(`/products/${productId}/category-change-previews`)
      .send({
        baseRevision: 1,
        targetSchemaVersionId: ambiguous.schemaVersionId,
        tnVedCode: null,
        okpd2Code: null,
      })
      .expect(404);
    await owner
      .post(`/products/${productId}/category-binding-previews`)
      .send({
        baseRevision: 0,
        targetSchemaVersionId: ambiguous.schemaVersionId,
        tnVedCode: null,
        okpd2Code: null,
      })
      .expect(409);
    await owner
      .post(`/products/${productId}/category-binding-previews`)
      .send({
        baseRevision: 0,
        targetSchemaVersionId: ambiguous.schemaVersionId,
        tnVedCode: null,
        okpd2Code: null,
        mappingConfirmed: true,
      })
      .expect(201);

    const beerProductId = await seedUnboundProduct(tenant.tenantId, 15);
    await owner
      .post(`/products/${beerProductId}/category-binding-previews`)
      .send({
        baseRevision: 0,
        targetSchemaVersionId: ambiguous.schemaVersionId,
        tnVedCode: null,
        okpd2Code: null,
        mappingConfirmed: true,
      })
      .expect(409);
    await db
      .update(schema.products)
      .set({ archived: true })
      .where(eq(schema.products.id, productId));
    await owner
      .post(`/products/${productId}/category-binding-previews`)
      .send({
        baseRevision: 0,
        targetSchemaVersionId: ambiguous.schemaVersionId,
        tnVedCode: null,
        okpd2Code: null,
        mappingConfirmed: true,
      })
      .expect(409);
  });

  it("rejects previews idempotently but expires previews to stale before apply", async () => {
    const owner = request.agent(app!.getHttpServer());
    const tenant = await signUpAndActivate(owner);
    const productId = await seedUnboundProduct(tenant.tenantId);
    const targetSchema = await seedMappedSchema(tenant.actorUserId);
    const preview = await owner
      .post(`/products/${productId}/category-binding-previews`)
      .send({
        baseRevision: 0,
        targetSchemaVersionId: targetSchema.schemaVersionId,
        tnVedCode: null,
        okpd2Code: null,
      })
      .expect(201);
    const proposalPath = `/products/${productId}/regulatory-proposals/${preview.body.proposalId}`;
    await owner.post(`${proposalPath}/reject`).send({}).expect(200);
    await owner.post(`${proposalPath}/reject`).send({}).expect(200);
    await owner.post(`${proposalPath}/apply`).send({ acceptedEntryIds: [] }).expect(409);

    const expiringProductId = await seedUnboundProduct(tenant.tenantId);
    const expiring = await owner
      .post(`/products/${expiringProductId}/category-binding-previews`)
      .send({
        baseRevision: 0,
        targetSchemaVersionId: targetSchema.schemaVersionId,
        tnVedCode: null,
        okpd2Code: null,
      })
      .expect(201);
    await db
      .update(schema.productRegulatoryProposals)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.productRegulatoryProposals.id, expiring.body.proposalId));
    await owner
      .post(`/products/${expiringProductId}/regulatory-proposals/${expiring.body.proposalId}/apply`)
      .send({ acceptedEntryIds: [] })
      .expect(409);
    const [expiredRow] = await db
      .select({ status: schema.productRegulatoryProposals.status })
      .from(schema.productRegulatoryProposals)
      .where(eq(schema.productRegulatoryProposals.id, expiring.body.proposalId));
    expect(expiredRow?.status).toBe("stale");
  });

  it("applies National Catalog provenance and validates every operation before writing", async () => {
    const owner = request.agent(app!.getHttpServer());
    const tenant = await signUpAndActivate(owner);
    const seeded = await seedProfile(tenant.tenantId, tenant.actorUserId);
    const [product] = await db
      .select({ gtin14: schema.products.gtin14, name: schema.products.name })
      .from(schema.products)
      .where(eq(schema.products.id, seeded.productId));
    const snapshotId = randomUUID();
    const sourceRef = "national-catalog-card:720679";
    const snapshotFetchedAt = new Date("2026-08-31T12:00:00.000Z");
    await db.insert(schema.nationalCatalogCardSnapshots).values({
      id: snapshotId,
      tenantId: tenant.tenantId,
      productId: seeded.productId,
      gtin14: product!.gtin14,
      cardId: "720679",
      cardStatus: "published",
      sourceMethod: "product",
      payloadFormatVersion: 2,
      contentHash: createHash("sha256").update(sourceRef).digest("hex"),
      payload: { id: 720679 },
      fetchedAt: snapshotFetchedAt,
    });
    const entryId = randomUUID();
    const proposalId = randomUUID();
    const now = new Date();
    await db.insert(schema.productRegulatoryProposals).values({
      id: proposalId,
      tenantId: tenant.tenantId,
      productId: seeded.productId,
      snapshotId,
      kind: "national_catalog_import",
      source: "national_catalog",
      sourceRef,
      baseRevision: 1,
      diff: {
        version: 1,
        kind: "national_catalog_import",
        entries: [
          {
            entryId,
            target: "attribute",
            targetSchemaVersionId: seeded.schemaVersionId,
            targetAttributeId: "hasSweetener",
            disposition: "convertible",
            currentValue: null,
            proposedValue: { type: "boolean", value: true },
          },
        ],
      },
      expiresAt: new Date(now.getTime() + 60_000),
      createdBy: tenant.actorUserId,
      createdAt: now,
    });

    await owner
      .post(`/products/${seeded.productId}/regulatory-proposals/${proposalId}/apply`)
      .send({ acceptedEntryIds: [entryId] })
      .expect(200);
    const [value] = await db
      .select()
      .from(schema.productRegulatoryAttributeValues)
      .where(
        and(
          eq(schema.productRegulatoryAttributeValues.productId, seeded.productId),
          eq(schema.productRegulatoryAttributeValues.attributeId, "hasSweetener"),
        ),
      );
    expect(value).toMatchObject({
      source: "national_catalog",
      sourceRef,
      observedAt: snapshotFetchedAt,
    });
    const selectionHash = createHash("sha256")
      .update(JSON.stringify([entryId]))
      .digest("hex");
    const [appliedProposal] = await db
      .select()
      .from(schema.productRegulatoryProposals)
      .where(eq(schema.productRegulatoryProposals.id, proposalId));
    expect(appliedProposal).toMatchObject({
      status: "applied",
      sourceRef,
      appliedSelection: [entryId],
      appliedSelectionHash: selectionHash,
    });

    const invalidProposalId = randomUUID();
    const validMappingId = randomUUID();
    await db.insert(schema.nationalCatalogAttributeMappings).values({
      id: validMappingId,
      schemaVersionId: seeded.schemaVersionId,
      sourceAttributeId: "good_name",
      targetField: "print_name",
      conversion: { kind: "string_trim" },
      mappingVersion: 1,
    });
    const validStableEntryId = randomUUID();
    const invalidStableEntryId = randomUUID();
    await db.insert(schema.productRegulatoryProposals).values({
      id: invalidProposalId,
      tenantId: tenant.tenantId,
      productId: seeded.productId,
      snapshotId,
      kind: "national_catalog_import",
      source: "national_catalog",
      sourceRef,
      baseRevision: 2,
      diff: {
        version: 1,
        kind: "national_catalog_import",
        entries: [
          {
            entryId: validStableEntryId,
            target: "stable_field",
            targetField: "print_name",
            mappingId: validMappingId,
            mappingVersion: 1,
            conversion: { kind: "string_trim" },
            currentValue: null,
            proposedValue: "Новое имя для печати",
          },
          {
            entryId: invalidStableEntryId,
            target: "stable_field",
            targetField: "name",
            mappingId: randomUUID(),
            mappingVersion: 1,
            conversion: { kind: "identity" },
            currentValue: product!.name,
            proposedValue: "Не должно примениться",
          },
        ],
      },
      expiresAt: new Date(Date.now() + 60_000),
      createdBy: tenant.actorUserId,
    });
    await owner
      .post(`/products/${seeded.productId}/regulatory-proposals/${invalidProposalId}/apply`)
      .send({ acceptedEntryIds: [validStableEntryId, invalidStableEntryId] })
      .expect(409);
    const [unchanged] = await db
      .select({ name: schema.products.name, printName: schema.products.printName })
      .from(schema.products)
      .where(eq(schema.products.id, seeded.productId));
    expect(unchanged).toEqual({ name: product!.name, printName: null });
    const [invalidProposal] = await db
      .select({ status: schema.productRegulatoryProposals.status })
      .from(schema.productRegulatoryProposals)
      .where(eq(schema.productRegulatoryProposals.id, invalidProposalId));
    expect(invalidProposal?.status).toBe("preview");
  });

  it("marks a proposal stale when its captured current value changes and refuses legacy guesswork", async () => {
    const owner = request.agent(app!.getHttpServer());
    const tenant = await signUpAndActivate(owner);
    const seeded = await seedProfile(tenant.tenantId, tenant.actorUserId);
    await db.insert(schema.nationalCatalogCategoryGroupMappings).values({
      chzProductGroupCode: 23,
      schemaVersionId: seeded.schemaVersionId,
      categoryId: "softdrinks",
      state: "exact",
      reviewedBy: tenant.actorUserId,
      reviewedAt: new Date(),
    });
    await owner
      .patch(`/products/${seeded.productId}/regulatory-attributes`)
      .send({
        baseRevision: 1,
        values: [{ attributeId: "hasSweetener", value: { type: "boolean", value: false } }],
      })
      .expect(200);
    const preview = await owner
      .post(`/products/${seeded.productId}/category-change-previews`)
      .send({
        baseRevision: 2,
        targetSchemaVersionId: seeded.schemaVersionId,
        tnVedCode: null,
        okpd2Code: null,
      })
      .expect(201);
    const entryId = preview.body.diff.entries[0].entryId as string;
    await db
      .update(schema.productRegulatoryAttributeValues)
      .set({ value: { type: "boolean", value: true } })
      .where(eq(schema.productRegulatoryAttributeValues.id, entryId));
    await owner
      .post(`/products/${seeded.productId}/regulatory-proposals/${preview.body.proposalId}/apply`)
      .send({ acceptedEntryIds: [entryId] })
      .expect(409);
    const [stale] = await db
      .select({
        status: schema.productRegulatoryProposals.status,
        reason: schema.productRegulatoryProposals.terminalReason,
      })
      .from(schema.productRegulatoryProposals)
      .where(eq(schema.productRegulatoryProposals.id, preview.body.proposalId));
    expect(stale).toEqual({ status: "stale", reason: "current_value_changed" });
    const [staleAudit] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenant.tenantId),
          eq(schema.tenantAuditEvents.action, "product.regulatory_proposal.stale"),
          eq(schema.tenantAuditEvents.targetId, seeded.productId),
        ),
      );
    expect(staleAudit).toMatchObject({
      actorUserId: tenant.actorUserId,
      outcome: "failure",
      after: {
        proposalId: preview.body.proposalId,
        proposalKind: "category_change",
        source: "manual",
        sourceRef: null,
        result: "stale",
        reason: "current_value_changed",
      },
    });

    const legacyProposalId = randomUUID();
    await db.insert(schema.productRegulatoryProposals).values({
      id: legacyProposalId,
      tenantId: tenant.tenantId,
      productId: seeded.productId,
      kind: "category_change",
      source: "manual",
      sourceRef: "not-json",
      baseRevision: 2,
      diff: {
        target: {
          schemaVersionId: seeded.schemaVersionId,
          categoryId: "softdrinks",
          categoryName: "Безалкогольные напитки",
          tnVedCode: null,
          okpd2Code: null,
        },
        values: [],
      },
      status: "applied",
      expiresAt: new Date(Date.now() + 60_000),
      appliedAt: new Date(),
      appliedSelection: null,
    });
    await owner
      .get(`/products/${seeded.productId}/regulatory-proposals/${legacyProposalId}`)
      .expect(200);
    await owner
      .post(`/products/${seeded.productId}/regulatory-proposals/${legacyProposalId}/apply`)
      .send({ acceptedEntryIds: [] })
      .expect(409);
  });
});

function gtin14(): string {
  const value = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`) % 100_000_000_000_000n;
  return value.toString().padStart(14, "0");
}
