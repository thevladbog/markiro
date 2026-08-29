import type { ExecutionContext, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { InventoryCloseService } from "../src/modules/inventories/inventory-close.service";
import { InventoryCorrectionsService } from "../src/modules/inventories/inventory-corrections.service";
import { InventoryDocumentsService } from "../src/modules/inventories/inventory-documents.service";
import { InventoryLifecycleService } from "../src/modules/inventories/inventory-lifecycle.service";
import { InventoryReconciliationService } from "../src/modules/inventories/inventory-reconciliation.service";
import { InventoriesController } from "../src/modules/inventories/inventories.controller";
import { InventoriesService } from "../src/modules/inventories/inventories.service";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../src/tenancy/tenant.guard";
import { listenOnLoopback } from "./support/listen-loopback";

const INVENTORY_ID = "00000000-0000-4000-8000-000000000001";

describe("inventory import multipart filename", () => {
  let app: INestApplication;
  const importEvidence = vi.fn().mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000002",
    declaredStatus: "INTRODUCED",
    parsedStatus: "INTRODUCED",
    result: "succeeded",
    rowCount: 1,
    errorCount: 0,
    duplicateCount: 0,
    sha256: "a".repeat(64),
    diagnostics: [],
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InventoriesController],
      providers: [
        { provide: InventoriesService, useValue: { importEvidence } },
        { provide: InventoryLifecycleService, useValue: {} },
        { provide: InventoryReconciliationService, useValue: {} },
        { provide: InventoryCorrectionsService, useValue: {} },
        { provide: InventoryCloseService, useValue: {} },
        { provide: InventoryDocumentsService, useValue: {} },
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest<RequestWithTenant>();
          req.tenantId = "00000000-0000-4000-8000-000000000003";
          req.userId = "00000000-0000-4000-8000-000000000004";
          return true;
        },
      })
      .overrideGuard(AuthorizationGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SubscriptionAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it("decodes a browser-style UTF-8 filename before handing it to the service", async () => {
    const filename = "Ввод в оборот. Производство РФ.csv";

    await request(app.getHttpServer())
      .post(`/inventories/${INVENTORY_ID}/imports/INTRODUCED`)
      .attach("file", Buffer.from("fixture"), { filename, contentType: "text/csv" })
      .expect(201);

    expect(importEvidence).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
      INVENTORY_ID,
      "INTRODUCED",
      expect.objectContaining({ originalName: filename }),
    );
  });
});
