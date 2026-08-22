import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { NextFunction, Response } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PlatformOperationsController } from "../src/modules/platform-operations/platform-operations.controller";
import { PlatformOperationsService } from "../src/modules/platform-operations/platform-operations.service";
import {
  PLATFORM_ACCESS_POLICY,
  type PlatformCapabilityPolicy,
} from "../src/platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../src/platform-auth/platform-auth.guard";
import { listenOnLoopback } from "./support/listen-loopback";

const checkedAt = "2026-08-22T08:00:00.000Z";
const health = {
  status: "ok" as const,
  checkedAt,
  checks: {
    database: { status: "healthy" as const, checkedAt },
    jobs: { status: "healthy" as const, checkedAt },
    smtp: { status: "healthy" as const, checkedAt },
    storage: { status: "healthy" as const, checkedAt },
  },
  integrations: { dadata: { status: "ready" as const } },
};
const overview = {
  generatedAt: checkedAt,
  definitions: {
    activeTenants: {
      version: "active-tenants-v1" as const,
      subscriptionStatuses: ["trial", "active"] as const,
    },
    tenantsApproachingRestriction: {
      version: "subscriptions-ending-v1" as const,
      subscriptionStatuses: ["trial", "active"] as const,
      windowDays: 14 as const,
    },
    overdueInvoices: {
      version: "overdue-invoices-v1" as const,
      invoiceStatuses: ["issued"] as const,
    },
  },
  activeTenants: 0,
  tenantsApproachingRestriction: 0,
  overdueInvoices: 0,
  decisionQueue: [],
  recentActivity: [],
  health,
};

describe("platform operations routes", () => {
  let app: INestApplication;
  const service = {
    overview: vi.fn(async () => overview),
    monitoring: vi.fn(async () => health),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformOperationsController],
      providers: [{ provide: PlatformOperationsService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    app.use((rawRequest: RequestWithPlatformPrincipal, _response: Response, next: NextFunction) => {
      rawRequest.platformPrincipal = {
        userId: "platform-admin",
        role: "platform_admin",
        capabilities: ["tenants.read", "diagnostics.read"],
        twoFactorReady: true,
      };
      next();
    });
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves the overview and monitoring responses at their canonical paths", async () => {
    await request(app.getHttpServer())
      .get("/api/platform/operations/overview")
      .expect(200)
      .expect(overview);
    await request(app.getHttpServer())
      .get("/api/platform/operations/monitoring")
      .expect(200)
      .expect(health);
    expect(service.overview).toHaveBeenCalledWith("platform_admin");
  });

  it("declares overview for every tenant-reading role and reserves monitoring for diagnostics", () => {
    const overviewPolicy = Reflect.getMetadata(
      PLATFORM_ACCESS_POLICY,
      PlatformOperationsController.prototype.overview,
    ) as PlatformCapabilityPolicy;
    const monitoringPolicy = Reflect.getMetadata(
      PLATFORM_ACCESS_POLICY,
      PlatformOperationsController.prototype.monitoring,
    ) as PlatformCapabilityPolicy;

    expect(overviewPolicy).toEqual({ mode: "capabilities", capabilities: ["tenants.read"] });
    expect(monitoringPolicy).toEqual({
      mode: "capabilities",
      capabilities: ["diagnostics.read"],
    });
  });
});
