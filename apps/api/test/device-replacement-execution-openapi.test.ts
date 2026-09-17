import { DeviceReplacementTargetPairingService } from "../src/modules/device-licensing/device-replacement-target-pairing.service";
import { DeviceReplacementRecoveryService } from "../src/modules/device-licensing/device-replacement-recovery.service";
import { expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { DeviceReplacementController } from "../src/modules/device-licensing/device-replacement.controller";
import { PlatformDeviceReplacementController } from "../src/modules/device-licensing/platform-device-replacement.controller";
import { DeviceReplacementService } from "../src/modules/device-licensing/device-replacement.service";
import { DeviceReplacementReadinessService } from "../src/modules/device-licensing/device-replacement-readiness.service";
import { DeviceReplacementExecutionService } from "../src/modules/device-licensing/device-replacement-execution.service";
import { TenantGuard } from "../src/tenancy/tenant.guard";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";

it("publishes strict normal/emergency preview and execution routes in both trust domains", async () => {
  const builder = Test.createTestingModule({
    controllers: [DeviceReplacementController, PlatformDeviceReplacementController],
    providers: [
      DeviceReplacementService,
      DeviceReplacementReadinessService,
      DeviceReplacementExecutionService,
      DeviceReplacementRecoveryService,
      DeviceReplacementTargetPairingService,
    ].map((provide) => ({ provide, useValue: {} })),
  });
  for (const guard of [TenantGuard, AuthorizationGuard, SubscriptionAccessGuard])
    builder.overrideGuard(guard).useValue({ canActivate: () => true });
  const app = (await builder.compile()).createNestApplication();
  await app.init();
  try {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    for (const prefix of ["", "/platform/tenants/{tenantId}"]) {
      for (const suffix of [
        "execution/preview",
        "execute",
        "emergency/preview",
        "emergency/execute",
      ]) {
        const operation =
          doc.paths[`${prefix}/device-licensing/replacements/{preparationId}/${suffix}`]?.post;
        expect(operation).toBeDefined();
        expect(operation?.requestBody).toHaveProperty("required", true);
        const body = operation?.requestBody;
        if (!body || !("content" in body)) throw new Error("Inline request body expected");
        const schema = body.content["application/json"]?.schema;
        if (!schema || "$ref" in schema) throw new Error("Inline schema expected");
        const variants = schema.oneOf ?? [schema];
        for (const variant of variants)
          expect(variant).toMatchObject({
            additionalProperties: false,
            required: expect.arrayContaining(["requestId", "expectedRevision"]),
          });
        expect(operation?.responses).toHaveProperty("200");
        expect(operation?.responses).toHaveProperty("409");
        expect(operation?.security?.length).toBeGreaterThan(0);
      }
    }
  } finally {
    await app.close();
  }
});
