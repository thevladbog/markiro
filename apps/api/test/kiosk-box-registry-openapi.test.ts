import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { describe, expect, it } from "vitest";
import { KioskController } from "../src/modules/kiosk/kiosk.controller";
import { BoxRegistryService } from "../src/modules/kiosk/box-registry.service";
import { PickupOrdersService } from "../src/modules/pickup-orders/pickup-orders.service";
import { OrgProfileService } from "../src/modules/org-profile/org-profile.service";
import { KioskDeviceGuard } from "../src/tenancy/kiosk-device.guard";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";

describe("kiosk box registry OpenAPI contract", () => {
  it("documents revision paging, exact change union, and error statuses", async () => {
    const ref = await Test.createTestingModule({
      controllers: [KioskController],
      providers: [
        { provide: BoxRegistryService, useValue: {} },
        { provide: PickupOrdersService, useValue: {} },
        { provide: OrgProfileService, useValue: {} },
      ],
    })
      .overrideGuard(KioskDeviceGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SubscriptionAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = ref.createNestApplication();
    await app.init();
    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("registry contract").setVersion("test").build(),
      );
      const operation = document.paths["/kiosk/box-registry"]?.get;
      expect(operation).toBeDefined();
      const parameters = operation?.parameters ?? [];
      expect(
        parameters.map((parameter) => ("$ref" in parameter ? "$ref" : parameter.name)).sort(),
      ).toEqual(["cursor", "limit", "since", "until"]);
      expect(JSON.stringify(parameters)).toContain("revision");
      expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(["200", "400", "401", "409"]);
      const conflict = operation?.responses["409"];
      expect(JSON.stringify(conflict)).toContain("registry_snapshot_changed");

      const ok = operation?.responses["200"];
      if (!ok || "$ref" in ok) throw new Error("missing inline 200 response");
      const content = ok.content as
        Record<string, { schema?: Record<string, unknown> }> | undefined;
      const schema = content?.["application/json"]?.schema;
      expect(schema).toMatchObject({
        type: "object",
        required: ["until", "items"],
        properties: {
          until: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
          nextCursor: { type: "string" },
          items: { type: "array" },
        },
      });
      const items = (schema?.properties as Record<string, Record<string, unknown>>).items;
      if (!items) throw new Error("missing items schema");
      const union = (items.items as { oneOf?: Array<{ required?: string[] }> }).oneOf;
      expect(union?.map((variant) => [...(variant.required ?? [])].sort())).toEqual([
        ["bottleCount", "boxId", "contentKeys", "kind", "productId", "sscc", "updatedAt"].sort(),
        ["kind", "sscc", "updatedAt"].sort(),
      ]);
    } finally {
      await app.close();
    }
  });

  it("documents atomic box order results and the aggregate budget error", async () => {
    const ref = await Test.createTestingModule({
      controllers: [KioskController],
      providers: [
        { provide: BoxRegistryService, useValue: {} },
        { provide: PickupOrdersService, useValue: {} },
        { provide: OrgProfileService, useValue: {} },
      ],
    })
      .overrideGuard(KioskDeviceGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SubscriptionAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = ref.createNestApplication();
    await app.init();
    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("orders contract").setVersion("test").build(),
      );
      const responses = document.paths["/kiosk/orders"]?.post?.responses ?? {};
      expect(Object.keys(responses)).toEqual(expect.arrayContaining(["201", "400", "413", "422"]));
      expect(JSON.stringify(responses["201"])).toContain("acceptedBoxes");
      expect(JSON.stringify(responses["413"])).toContain("box_request_too_large");
      const requestBody = document.paths["/kiosk/orders"]?.post?.requestBody;
      expect(JSON.stringify(requestBody)).toContain("At least one line");
      expect(requestBody && !("$ref" in requestBody)).toBe(true);
      if (!requestBody || "$ref" in requestBody) throw new Error("missing inline request body");
      const requestSchema = (
        requestBody.content as Record<string, { schema?: Record<string, unknown> }>
      )["application/json"]?.schema;
      const properties = requestSchema?.properties as Record<string, Record<string, unknown>>;
      expect(properties.items).toMatchObject({ type: "array", maxItems: 500 });
      expect(properties.boxes).toMatchObject({ type: "array", maxItems: 100 });
      expect(Object.keys(properties)).toEqual(
        expect.arrayContaining(["createdAt", "admissionProof", "admissionNonce"]),
      );
      const boxItems = properties.boxes?.items as Record<string, unknown> | undefined;
      if (!boxItems) throw new Error("missing boxes item schema");
      expect(
        boxItems.properties as Record<string, unknown>,
      ).toEqual({ sscc: { type: "string", pattern: "^[0-9]{18}$" } });
      expect(boxItems.additionalProperties).toBe(false);
      expect(JSON.stringify(responses["201"])).toContain("unknown_box");
      expect(JSON.stringify(responses["422"])).toContain("order_rejected");
    } finally {
      await app.close();
    }
  });
});
