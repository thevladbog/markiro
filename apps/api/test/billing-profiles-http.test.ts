import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BillingProfilesController } from "../src/modules/billing-profiles/billing-profiles.controller";
import { BillingProfilesService } from "../src/modules/billing-profiles/billing-profiles.service";

describe("billing profiles HTTP contract", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BillingProfilesController],
      providers: [
        {
          provide: BillingProfilesService,
          useValue: {
            getOperator: async () => null,
            getTenant: async () => null,
          },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(["/platform/billing/operator-profile", "/platform/billing/tenants/tenant-1/profile"])(
    "serializes an absent profile as JSON null at %s",
    async (path) => {
      const response = await request(app.getHttpServer()).get(path).expect(200);

      expect(response.headers["content-type"]).toMatch(/^application\/json\b/u);
      expect(response.text).toBe("null");
      expect(response.body).toBeNull();
    },
  );
});
