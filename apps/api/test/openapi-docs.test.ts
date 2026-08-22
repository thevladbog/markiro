import express from "express";
import { createServer, type Server } from "node:http";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { buildPlatformAuth, type Db } from "@markiro/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { SecurityAuditService } from "../src/authorization/security-audit.service";
import { KioskPairController } from "../src/modules/kiosk/kiosk-pair.controller";
import { PairingService } from "../src/modules/kiosk/pairing.service";
import { KiosksController } from "../src/modules/kiosks/kiosks.controller";
import { KiosksService } from "../src/modules/kiosks/kiosks.service";
import { StationDevicesController } from "../src/modules/station-devices/station-devices.controller";
import { StationDevicesService } from "../src/modules/station-devices/station-devices.service";
import { StationPairController } from "../src/modules/station-pairing/station-pair.controller";
import { StationPairingService } from "../src/modules/station-pairing/station-pairing.service";
import { ProductsController } from "../src/modules/products/products.controller";
import { ProductsService } from "../src/modules/products/products.service";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { disableScalarDynamicCodeProbe, mountOpenApiDocs } from "../src/openapi-docs";
import {
  addPlatformSessionSecurity,
  PLATFORM_SESSION_SECURITY,
} from "../src/platform-http/platform-openapi";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { TenantGuard } from "../src/tenancy/tenant.guard";
import { StationOnlyGuard } from "../src/tenancy/station-only.guard";

function scriptElements(html: string): Array<{ attributes: string; body: string }> {
  const lower = html.toLowerCase();
  const elements: Array<{ attributes: string; body: string }> = [];
  let cursor = 0;

  while (cursor < html.length) {
    const opening = lower.indexOf("<script", cursor);
    if (opening === -1) break;
    const openingBoundary = lower[opening + "<script".length];
    if (openingBoundary !== ">" && !/\s/.test(openingBoundary ?? "")) {
      cursor = opening + "<script".length;
      continue;
    }
    const openingEnd = lower.indexOf(">", opening + "<script".length);
    if (openingEnd === -1) throw new Error("documentation HTML contains an unclosed script tag");

    let closing = lower.indexOf("</script", openingEnd + 1);
    let closingEnd = -1;
    while (closing !== -1) {
      closingEnd = closing + "</script".length;
      while (/\s/.test(lower[closingEnd] ?? "")) closingEnd += 1;
      if (lower[closingEnd] === ">") break;
      closing = lower.indexOf("</script", closing + "</script".length);
    }
    if (closing === -1) throw new Error("documentation HTML contains an unclosed script element");

    elements.push({
      attributes: html.slice(opening + "<script".length, openingEnd),
      body: html.slice(openingEnd + 1, closing),
    });
    cursor = closingEnd + 1;
  }

  return elements;
}

function scriptSources(html: string): string[] {
  return scriptElements(html).map(({ attributes, body }) => {
    if (body.trim()) throw new Error("documentation HTML contains an inline script");
    const source = attributes.match(/(?:^|\s)src\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!source) throw new Error("documentation HTML contains an inline script");
    return source;
  });
}

function operationResponse(
  document: OpenAPIObject,
  path: string,
  status: "200" | "201",
  method: "get" | "post" = "post",
): Record<string, unknown> {
  const operation = document.paths[path]?.[method];
  if (!operation) throw new Error(`Missing ${method.toUpperCase()} operation for ${path}`);
  const response = operation.responses[status];
  if (!response || "$ref" in response)
    throw new Error(`Missing inline ${status} response for ${path}`);
  return response as unknown as Record<string, unknown>;
}

interface TestSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, TestSchema>;
  items?: TestSchema;
}

function responseSchema(response: Record<string, unknown>): TestSchema {
  const content = response.content as Record<string, { schema?: TestSchema }> | undefined;
  const schema = content?.["application/json"]?.schema;
  if (!schema) throw new Error("Missing application/json response schema");
  return schema;
}

function property(schema: TestSchema, name: string): TestSchema {
  const result = schema.properties?.[name];
  if (!result) throw new Error(`Missing schema property ${name}`);
  return result;
}

function arrayItems(schema: TestSchema): TestSchema {
  if (schema.type !== "array" || !schema.items) throw new Error("Expected array item schema");
  return schema.items;
}

function expectExactObjectFields(schema: TestSchema, fields: readonly string[]): void {
  expect(schema.type).toBe("object");
  expect([...(schema.required ?? [])].sort()).toEqual([...fields].sort());
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...fields].sort());
}

describe("self-hosted OpenAPI documentation", () => {
  let server: Server;

  it.each([
    ["http://api.example.test", "markiro-platform.session_token"],
    ["https://api.example.test", "__Secure-markiro-platform.session_token"],
  ])("defines the initialized Better Auth cookie security scheme for %s", async (baseURL, name) => {
    const auth = buildPlatformAuth({} as Db, {
      secret: "0123456789abcdef0123456789abcdef",
      baseURL,
      trustedOrigins: ["https://saas.example.test"],
    });
    const cookieName = (await auth.$context).authCookies.sessionToken.name;
    const configuration = addPlatformSessionSecurity(
      new DocumentBuilder().setTitle("platform contract test").setVersion("test"),
      cookieName,
    ).build();

    expect(configuration.components?.securitySchemes).toEqual({
      [PLATFORM_SESSION_SECURITY]: {
        type: "apiKey",
        in: "cookie",
        name,
      },
    });
  });

  it("parses script end tags with valid whitespace before the closing bracket", () => {
    expect(scriptSources('<script src="/docs/scalar.js"></script   >')).toEqual([
      "/docs/scalar.js",
    ]);
  });

  it("documents the cabinet product image upload, delete, and immutable read routes", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [
        { provide: ProductsService, useValue: {} },
        { provide: ObjectStorageService, useValue: {} },
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthorizationGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SubscriptionAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("contract test").setVersion("test").build(),
      );
      const imagePath = document.paths["/products/{id}/image"];
      expect(imagePath?.post?.requestBody).toMatchObject({
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["image"],
              properties: { image: { type: "string", format: "binary" } },
            },
          },
        },
      });
      expect(imagePath?.delete).toBeDefined();
      expect(document.paths["/products/{id}/image/{checksum}"]?.get).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("documents the authenticated station identity backfill response exactly", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StationPairController],
      providers: [{ provide: StationPairingService, useValue: {} }],
    })
      .overrideGuard(TenantGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(StationOnlyGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("contract test").setVersion("test").build(),
      );
      const response = operationResponse(document, "/station/identity", "200", "get");
      expect(response).toMatchObject({
        headers: {
          "Cache-Control": { schema: { type: "string", enum: ["no-store"] } },
        },
        content: {
          "application/json": {
            schema: { type: "object", required: ["device"] },
          },
        },
      });
      const schema = responseSchema(response);
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["device", "subscription"]);
      expectExactObjectFields(schema.properties!.device!, [
        "id",
        "name",
        "tenantId",
        "organizationName",
        "line",
      ]);
      expectExactObjectFields(schema.properties!.subscription!, [
        "access",
        "status",
        "startsAt",
        "endsAt",
      ]);
      expect(JSON.stringify(response)).not.toMatch(/apiKey|credential|secret/i);
    } finally {
      await app.close();
    }
  });

  it("does not mistake data-src for the executable script src attribute", () => {
    expect(() => scriptSources('<script data-src="/docs/scalar.js"></script>')).toThrow(
      /inline script/,
    );
  });

  beforeAll(async () => {
    const app = express();
    mountOpenApiDocs(app);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  });

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  it.each(["/docs", "/docs/"])("serves a CSP-compatible same-origin shell at %s", async (path) => {
    const response = await request(server).get(path).expect(200).expect("content-type", /html/);

    expect(scriptSources(response.text)).toEqual(["/docs/scalar.js", "/docs/bootstrap.js"]);
    expect(response.text).toContain('<div id="app"></div>');
    expect(response.text).not.toMatch(/\b(?:src|href)=["'](?:https?:)?\/\//i);
  });

  it("serves the Scalar browser bundle from the API runtime", async () => {
    const response = await request(server)
      .get("/docs/scalar.js")
      .expect(200)
      .expect("content-type", /javascript/);

    expect(response.text.length).toBeGreaterThan(100_000);
    expect(response.text).toContain("createApiReference");
    expect(response.text).not.toContain("Function(``)");
  });

  it("fails closed if Scalar changes its exact dynamic-code feature probe", () => {
    const probe = "try{return Function(``),!0}catch{return!1}";

    expect(() => disableScalarDynamicCodeProbe("no probe")).toThrow(/exactly one/);
    expect(() => disableScalarDynamicCodeProbe(`${probe}${probe}`)).toThrow(/exactly one/);
  });

  it("initializes Scalar from an external script against the same-origin OpenAPI document", async () => {
    const response = await request(server)
      .get("/docs/bootstrap.js")
      .expect(200)
      .expect("content-type", /javascript/);

    expect(response.text).toContain('Scalar.createApiReference("#app"');
    expect(response.text).toContain('url: "/openapi.json"');
    expect(response.text).toContain("withDefaultFonts: false");
    expect(response.text).toContain("agent: { disabled: true }");
    expect(response.text).toContain("mcp: { disabled: true }");
    expect(response.text).toContain("hideTestRequestButton: true");
    expect(response.text).not.toContain("showToolbar");
    expect(response.text).not.toMatch(/https?:\/\//i);
  });

  it("does not turn unknown documentation resources into the documentation shell", async () => {
    await request(server).get("/docs/missing.js").expect(404);
  });

  it("documents every one-time secret response with no-store and a concrete body schema", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        KiosksController,
        KioskPairController,
        StationDevicesController,
        StationPairController,
      ],
      providers: [
        { provide: KiosksService, useValue: {} },
        { provide: PairingService, useValue: {} },
        { provide: StationDevicesService, useValue: {} },
        { provide: StationPairingService, useValue: {} },
        { provide: SecurityAuditService, useValue: {} },
        { provide: SubscriptionAccessGuard, useValue: { canActivate: () => true } },
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthorizationGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SubscriptionAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("contract test").setVersion("test").build(),
      );
      const contracts = [
        ["/station-devices/{id}/pairing-code", "201", ["code", "expiresAt"]],
        ["/station/pair", "201", ["device", "credential", "operators"]],
        ["/kiosks/{id}/pairing-code", "201", ["code", "expiresAt"]],
        ["/kiosk/pair", "201", ["device", "token", "nextDeviceSeq", "bootstrap"]],
        ["/kiosks/{id}/enroll", "200", ["token"]],
      ] as const;

      for (const [path, status, fields] of contracts) {
        const response = operationResponse(document, path, status);
        expect(response).toMatchObject({
          headers: {
            "Cache-Control": { schema: { type: "string", enum: ["no-store"] } },
          },
          content: {
            "application/json": {
              schema: { type: "object", required: [...fields] },
            },
          },
        });
        const serialized = JSON.stringify(response);
        expect(serialized).not.toMatch(/example/i);
        for (const field of fields) expect(serialized).toContain(`"${field}"`);
      }

      const pairingCodeFields = ["code", "expiresAt"] as const;
      expectExactObjectFields(
        responseSchema(operationResponse(document, "/station-devices/{id}/pairing-code", "201")),
        pairingCodeFields,
      );
      expectExactObjectFields(
        responseSchema(operationResponse(document, "/kiosks/{id}/pairing-code", "201")),
        pairingCodeFields,
      );

      const station = responseSchema(operationResponse(document, "/station/pair", "201"));
      expect(Object.keys(station.properties ?? {}).sort()).toEqual([
        "credential",
        "device",
        "operators",
        "subscription",
      ]);
      const stationDevice = property(station, "device");
      expectExactObjectFields(stationDevice, [
        "id",
        "name",
        "tenantId",
        "organizationName",
        "line",
      ]);
      expectExactObjectFields(property(stationDevice, "line"), ["id", "name"]);
      expectExactObjectFields(property(station, "credential"), ["apiKey", "serverUrl"]);
      expectExactObjectFields(arrayItems(property(station, "operators")), [
        "operatorId",
        "name",
        "login",
        "role",
        "pinHash",
        "badgeHash",
        "active",
      ]);
      expectExactObjectFields(property(station, "subscription"), [
        "access",
        "status",
        "startsAt",
        "endsAt",
      ]);

      const kiosk = responseSchema(operationResponse(document, "/kiosk/pair", "201"));
      expectExactObjectFields(kiosk, ["device", "token", "nextDeviceSeq", "bootstrap"]);
      expectExactObjectFields(property(kiosk, "device"), ["kioskId", "kioskName", "place"]);
      const bootstrap = property(kiosk, "bootstrap");
      expectExactObjectFields(bootstrap, [
        "generatedAt",
        "branding",
        "pickupPolicy",
        "config",
        "badgeSalt",
        "reasons",
        "products",
        "employees",
        "operators",
        "subscription",
      ]);
      expectExactObjectFields(property(bootstrap, "branding"), [
        "organizationName",
        "logoUrl",
        "logoRevision",
      ]);
      expectExactObjectFields(property(bootstrap, "pickupPolicy"), ["limitsEnabled"]);
      expectExactObjectFields(property(bootstrap, "config"), [
        "dayLimitPerEmployee",
        "showPrices",
        "printEmployeeQrOnSlip",
      ]);
      expectExactObjectFields(arrayItems(property(bootstrap, "reasons")), ["id", "name"]);
      expectExactObjectFields(arrayItems(property(bootstrap, "products")), [
        "id",
        "gtin14",
        "name",
        "unitPrice",
        "egaisCode",
      ]);
      expectExactObjectFields(arrayItems(property(bootstrap, "employees")), [
        "id",
        "fullName",
        "role",
        "badgeHash",
        "limitMode",
        "dayLimit",
        "canWriteoff",
        "takenTodayElsewhere",
      ]);
      const kioskOperator = arrayItems(property(bootstrap, "operators"));
      expectExactObjectFields(kioskOperator, [
        "employeeId",
        "name",
        "login",
        "role",
        "pinHash",
        "badgeHash",
        "active",
      ]);
      expect(kioskOperator.properties).not.toHaveProperty("operatorId");
      expectExactObjectFields(property(bootstrap, "subscription"), [
        "access",
        "status",
        "startsAt",
        "endsAt",
      ]);

      expectExactObjectFields(
        responseSchema(operationResponse(document, "/kiosks/{id}/enroll", "200")),
        ["token"],
      );
    } finally {
      await app.close();
    }
  });
});
