import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { schema, type Db } from "@markiro/db";
import type { LabelTemplateSpec } from "@markiro/domain";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import type { AuthorizationService } from "../src/authorization/authorization.service";
import type { SecurityAuditService } from "../src/authorization/security-audit.service";
import { ShiftsController } from "../src/modules/shifts/shifts.controller";
import { ShiftsService } from "../src/modules/shifts/shifts.service";
import type { OperatorsService } from "../src/modules/operators/operators.service";
import type { SsccService } from "../src/modules/sscc/sscc.service";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import type { EntitlementAdmissionService } from "../src/subscriptions/entitlement-admission.service";
import type { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { TenantGuard, type RequestWithTenant } from "../src/tenancy/tenant.guard";
import { listenOnLoopback } from "./support/listen-loopback";

const tenantId = "tenant-preview";
const productId = "11111111-1111-4111-8111-111111111111";
const templateId = "22222222-2222-4222-8222-222222222222";
const spec: LabelTemplateSpec = {
  widthMm: 60,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    { id: "title", kind: "text", xMm: 2, yMm: 2, text: "Продукция", fontSizePt: 10 },
    {
      id: "code",
      kind: "barcode",
      xMm: 2,
      yMm: 10,
      format: "datamatrix",
      data: "km.code",
      sizeMm: 20,
    },
  ],
};
const preview = { id: templateId, name: "Preview label", purpose: "box", spec };
const query = { productId, templateId, purpose: "box" } as const;

describe("shift template preview HTTP boundary", () => {
  let app: INestApplication;
  const getLabelTemplatePreview = vi.fn(async () => preview);

  beforeAll(async () => {
    const reflector = new Reflector();
    const authorization = {
      resolvePrincipal: async (userId: string) => ({
        capabilities: userId === "reader" ? ["operations.read"] : [],
      }),
    } as unknown as AuthorizationService;
    const entitlements = {
      resolve: async () => ({ access: "read_only" }),
    } as unknown as EntitlementsService;
    const moduleRef = await Test.createTestingModule({
      controllers: [ShiftsController],
      providers: [{ provide: ShiftsService, useValue: { getLabelTemplatePreview } }],
    })
      .overrideGuard(TenantGuard)
      .useValue({
        canActivate: (context: { switchToHttp: () => { getRequest: () => RequestWithTenant } }) => {
          const req = context.switchToHttp().getRequest();
          const kind = req.headers["x-test-principal"];
          req.tenantId = tenantId;
          if (kind === "station" || kind === "handheld") {
            req.authKind = "station";
            req.deviceKind = kind;
            req.deviceId = "station-preview";
          } else if (kind === "reader" || kind === "member") {
            req.authKind = "session";
            req.userId = kind;
          }
          return true;
        },
      })
      .overrideGuard(AuthorizationGuard)
      .useValue(
        new AuthorizationGuard(reflector, authorization, {
          authorizationDenied: () => undefined,
        } as unknown as SecurityAuditService),
      )
      .overrideGuard(SubscriptionAccessGuard)
      .useValue(new SubscriptionAccessGuard(reflector, entitlements, "all"))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => app.close());

  it.each(["station", "reader"])(
    "lets a %s read an eligible preview under a restricted subscription",
    async (kind) => {
      const response = await request(app.getHttpServer())
        .get("/shifts/label-template-preview")
        .set("x-test-principal", kind)
        .query(query)
        .expect(200);
      expect(response.body).toEqual(preview);
      expect(getLabelTemplatePreview).toHaveBeenLastCalledWith(tenantId, query);
    },
  );

  it.each(["handheld", "member", "kiosk"])("denies a %s credential", async (kind) => {
    getLabelTemplatePreview.mockClear();
    await request(app.getHttpServer())
      .get("/shifts/label-template-preview")
      .set("x-test-principal", kind)
      .query(query)
      .expect(403);
    expect(getLabelTemplatePreview).not.toHaveBeenCalled();
  });

  it.each([
    { productId, purpose: "box" },
    { templateId, purpose: "box" },
    { productId, templateId },
    { ...query, productId: "invalid" },
    { ...query, templateId: "invalid" },
    { ...query, purpose: "product" },
    { ...query, tenantId: "another-tenant" },
  ])("rejects malformed or injected scope %#", async (invalid) => {
    getLabelTemplatePreview.mockClear();
    await request(app.getHttpServer())
      .get("/shifts/label-template-preview")
      .set("x-test-principal", "station")
      .query(invalid)
      .expect(400);
    expect(getLabelTemplatePreview).not.toHaveBeenCalled();
  });

  it("publishes required query scope and the shared label spec response", () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const operation = document.paths["/shifts/label-template-preview"]?.get;
    expect(operation?.security).toEqual([{ cabinetSession: [] }, { stationApiKey: [] }]);
    expect(operation?.parameters).toEqual(
      expect.arrayContaining(
        ["productId", "templateId", "purpose"].map((name) =>
          expect.objectContaining({ name, in: "query", required: true }),
        ),
      ),
    );
    expect(operation?.responses["200"]).toMatchObject({
      content: {
        "application/json": {
          schema: {
            required: ["id", "name", "purpose", "spec"],
            additionalProperties: false,
            properties: {
              purpose: { enum: ["box", "pallet", "product_duplicate"] },
              spec: {
                type: "object",
                properties: { widthMm: { type: "number" }, elements: { type: "array" } },
              },
            },
          },
        },
      },
    });
    expect(operation?.responses).toHaveProperty("404");
  });
});

describe("shift template preview eligibility", () => {
  const template = {
    ...preview,
    tenantId,
    enabled: true,
    chzProductGroupCodes: [4],
  };

  function fixture(product: object | undefined, label: object | undefined) {
    const conditions: Array<{ table: unknown; sql: string; params: unknown[] }> = [];
    const db = {
      select: () => ({
        from: (table: unknown) => {
          const node = {
            leftJoin: () => node,
            where: async (condition: SQL) => {
              const compiled = new PgDialect().sqlToQuery(condition);
              conditions.push({ table, sql: compiled.sql, params: compiled.params });
              const row = table === schema.products ? product : label;
              return row ? [row] : [];
            },
          };
          return node;
        },
      }),
    } as unknown as Db;
    return {
      conditions,
      service: new ShiftsService(
        db,
        {} as OperatorsService,
        {} as SsccService,
        {} as EntitlementsService,
        {} as EntitlementAdmissionService,
      ),
    };
  }

  it.each(["box", "pallet", "product_duplicate"] as const)(
    "returns the saved shared spec for an eligible %s template",
    async (purpose) => {
      const { service, conditions } = fixture({ chzProductGroupCode: 4 }, { ...template, purpose });
      expect(await service.getLabelTemplatePreview(tenantId, { ...query, purpose })).toEqual({
        ...preview,
        purpose,
      });
      expect(conditions[0]).toMatchObject({
        table: schema.products,
        params: [tenantId, productId],
      });
      expect(conditions[0]?.sql).toContain('"products"."tenant_id"');
      expect(conditions[1]).toMatchObject({
        table: schema.labelTemplates,
        params: [tenantId, templateId, purpose, true],
      });
      expect(conditions[1]?.sql).toContain('"label_templates"."tenant_id"');
    },
  );

  it.each(["box", "pallet", "product_duplicate"] as const)(
    "offers only universal %s templates when the product category is unknown",
    async (purpose) => {
      const scoped = fixture({ chzProductGroupCode: null }, { ...template, purpose });
      await expect(
        scoped.service.getLabelTemplatePreview(tenantId, { ...query, purpose }),
      ).rejects.toMatchObject({ status: 404 });
      const universal = fixture(
        { chzProductGroupCode: null },
        { ...template, purpose, chzProductGroupCodes: null },
      );
      expect(
        await universal.service.getLabelTemplatePreview(tenantId, { ...query, purpose }),
      ).toEqual({ ...preview, purpose });
    },
  );

  it.each(["box", "pallet", "product_duplicate"] as const)(
    "denies disabled, mismatched-purpose and other-category %s templates",
    async (purpose) => {
      for (const invalid of [
        { ...template, purpose, enabled: false },
        { ...template, purpose: purpose === "box" ? "pallet" : "box" },
        { ...template, purpose, chzProductGroupCodes: [9] },
      ]) {
        const { service } = fixture({ chzProductGroupCode: 4 }, invalid);
        await expect(
          service.getLabelTemplatePreview(tenantId, { ...query, purpose }),
        ).rejects.toMatchObject({ status: 404 });
      }
    },
  );

  it("denies a product absent from this tenant before loading any template", async () => {
    const { service, conditions } = fixture(undefined, template);
    await expect(service.getLabelTemplatePreview(tenantId, query)).rejects.toMatchObject({
      status: 404,
    });
    expect(conditions).toHaveLength(1);
  });

  it("denies a template absent from this tenant", async () => {
    const { service } = fixture({ chzProductGroupCode: 4 }, undefined);
    await expect(service.getLabelTemplatePreview(tenantId, query)).rejects.toMatchObject({
      status: 404,
    });
  });
});
