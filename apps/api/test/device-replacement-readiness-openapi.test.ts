import { describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { DeviceReplacementReadinessController } from "../src/modules/device-licensing/device-replacement-readiness.controller";
import { DeviceReplacementReadinessService } from "../src/modules/device-licensing/device-replacement-readiness.service";
import { TenantGuard } from "../src/tenancy/tenant.guard";
import { StationOnlyGuard } from "../src/tenancy/station-only.guard";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";

it("publishes strict native replacement routes with station credentials and nullable intent", async () => {
  const builder = Test.createTestingModule({
    controllers: [DeviceReplacementReadinessController],
    providers: [{ provide: DeviceReplacementReadinessService, useValue: {} }],
  });
  for (const guard of [TenantGuard, StationOnlyGuard, SubscriptionAccessGuard])
    builder.overrideGuard(guard).useValue({ canActivate: () => true });
  const app = (await builder.compile()).createNestApplication();
  await app.init();
  try {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/station/device-replacement-intent",
      "/station/device-replacement-intent/v1",
      "/station/device-replacement-intent/v1/acknowledge",
      "/station/device-replacement-readiness",
    ]);
    expect(doc.paths["/station/device-replacement-intent"]?.get?.responses["200"]).toMatchObject({
      content: { "application/json": { schema: { nullable: true, additionalProperties: false } } },
    });
    for (const path of [
      "/station/device-replacement-intent",
      "/station/device-replacement-intent/v1",
    ])
      expect(doc.paths[path]?.get?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "x-station-capabilities",
            in: "header",
            required: false,
            description: expect.stringContaining("replacement-readiness-v1"),
          }),
        ]),
      );
    for (const item of Object.values(doc.paths))
      expect((item.get ?? item.post)?.security).toEqual([{ stationApiKey: [] }]);
    expect(doc.paths["/station/device-replacement-readiness"]?.post?.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: {
            additionalProperties: false,
            required: expect.arrayContaining([
              "requestId",
              "intentId",
              "credentialEpoch",
              "pending",
              "installedGrants",
            ]),
          },
        },
      },
    });
  } finally {
    await app.close();
  }
});
describe("native replacement identity", () => {
  it("rejects cabinet and kiosk requests before accessing the service", () => {
    const controller = new DeviceReplacementReadinessController({} as never);
    for (const authKind of ["cabinet", "kiosk"])
      expect(() =>
        controller.currentIntent({
          authKind,
          tenantId: "tenant",
          deviceId: "device",
          deviceKind: "station",
          deviceApiKeyId: "key",
        } as never),
      ).toThrow();
  });
});

it("passes explicit or missing capability headers to the authenticated v1 observation", () => {
  const currentIntentProjection = vi.fn();
  const controller = new DeviceReplacementReadinessController({ currentIntentProjection } as never);
  const req = {
    authKind: "station",
    tenantId: "tenant",
    deviceId: "device",
    deviceKind: "handheld",
    deviceApiKeyId: "key",
  };
  for (const header of [undefined, "handheld-v1,replacement-readiness-v1"])
    controller.currentIntentV1(req as never, {}, header);
  expect(currentIntentProjection.mock.calls).toEqual(
    [undefined, "handheld-v1,replacement-readiness-v1"].map((header) => [
      { tenantId: "tenant", deviceId: "device", kind: "handheld", apiKeyId: "key" },
      undefined,
      header,
    ]),
  );
});
