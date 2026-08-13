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
      expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(["200", "400", "401"]);

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
});
