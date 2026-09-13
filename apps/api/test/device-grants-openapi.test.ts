import { GrantEvidenceNativeService } from "../src/modules/device-grants/grant-evidence-native.service";
import { describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { DeviceGrantsController } from "../src/modules/device-grants/device-grants.controller";
import { KioskGrantsController } from "../src/modules/device-grants/kiosk-grants.controller";
import { GrantIssuerService } from "../src/modules/device-grants/grant-issuer.service";
import { PickupOrdersService } from "../src/modules/pickup-orders/pickup-orders.service";
import { TenantGuard } from "../src/tenancy/tenant.guard";
import { StationOnlyGuard } from "../src/tenancy/station-only.guard";
import { KioskDeviceGuard } from "../src/tenancy/kiosk-device.guard";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";

describe("negotiated offline grants OpenAPI", () => {
  it("generates all negotiated native contracts and keeps credential domains distinct", async () => {
    const builder = Test.createTestingModule({
      controllers: [DeviceGrantsController, KioskGrantsController],
      providers: [GrantIssuerService, PickupOrdersService, GrantEvidenceNativeService].map(
        (provide) => ({
          provide,
          useValue: {},
        }),
      ),
    });
    for (const guard of [TenantGuard, StationOnlyGuard, KioskDeviceGuard, SubscriptionAccessGuard])
      builder.overrideGuard(guard).useValue({ canActivate: () => true });
    const app = (await builder.compile()).createNestApplication();
    await app.init();
    try {
      const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());
      expect(Object.keys(doc.paths).sort()).toEqual([
        "/kiosk/grants/v1/configuration",
        "/kiosk/grants/v1/device",
        "/kiosk/grants/v1/evidence/orders",
        "/kiosk/grants/v1/keyset",
        "/kiosk/grants/v1/reservations",
        "/kiosk/grants/v1/tasks",
        "/station/grants/v1/configuration",
        "/station/grants/v1/device",
        "/station/grants/v1/evidence/inventories/{id}/event-batches",
        "/station/grants/v1/evidence/inventories/{id}/leave",
        "/station/grants/v1/evidence/scans",
        "/station/grants/v1/evidence/shift-closures",
        "/station/grants/v1/keyset",
        "/station/grants/v1/tasks",
      ]);
      for (const [path, item] of Object.entries(doc.paths)) {
        const operation = item.get ?? item.post;
        expect(operation?.summary).toBeTruthy();
        expect(operation?.security).toEqual(
          path.startsWith("/station") ? [{ stationApiKey: [] }] : [{ kioskToken: [] }],
        );
        expect(operation?.responses["200"]).toBeDefined();
        expect(operation?.responses["429"]).toBeDefined();
        if (item.post) {
          expect(item.post.requestBody).toMatchObject({
            required: true,
            content: {
              "application/json": {
                schema: {
                  additionalProperties: false,
                  required: expect.arrayContaining(
                    path.includes("/evidence/")
                      ? ["protocol", "batchId", "payloadDigest", "grants", "eventGrants", "payload"]
                      : ["protocol", "capability", "requestId"],
                  ),
                },
              },
            },
          });
          expect(JSON.stringify(item.post.responses["200"])).not.toContain("PRIVATE KEY");
        }
      }
      const task = doc.paths["/station/grants/v1/tasks"]?.post;
      expect(task?.requestBody).toMatchObject({
        content: {
          "application/json": {
            schema: { required: expect.arrayContaining(["taskKind", "taskId"]) },
          },
        },
      });
      expect(JSON.stringify(task?.responses["200"])).toContain("taskSnapshots");
      expect(
        JSON.stringify(doc.paths["/kiosk/grants/v1/reservations"]?.post?.responses["200"]),
      ).toContain("admissionProof");
    } finally {
      await app.close();
    }
  });
});
