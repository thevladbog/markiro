import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { EntitlementSourcesService } from "../src/subscriptions/entitlement-sources.service";
import { projectEntitlements } from "../src/subscriptions/entitlement-projection";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { AppModule } from "../src/app.module";
import { setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { PgBossService } from "../src/jobs/jobs.module";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../src/tenancy/tenant.guard";
import { NationalCatalogCapabilitiesService } from "../src/modules/national-catalog/national-catalog-capabilities.service";
import { NationalCatalogImageService } from "../src/modules/national-catalog/national-catalog-image.service";
import { NationalCatalogImportApplyService } from "../src/modules/national-catalog/national-catalog-import-apply.service";
import { NationalCatalogImportPreviewService } from "../src/modules/national-catalog/national-catalog-import-preview.service";
import { NationalCatalogImportController } from "../src/modules/national-catalog/national-catalog-import.controller";
import { NationalCatalogImportService } from "../src/modules/national-catalog/national-catalog-import.service";
import { NationalCatalogLinkController } from "../src/modules/national-catalog/national-catalog-link.controller";
import { NationalCatalogLinkService } from "../src/modules/national-catalog/national-catalog-link.service";
import { NationalCatalogJobsService } from "../src/modules/national-catalog/national-catalog-jobs.service";

const req = { tenantId: "tenant", userId: "user" } as RequestWithTenant;
const sessionId = "00000000-0000-4000-8000-000000000001";
const workId = "00000000-0000-4000-8000-000000000002";
const accepted = { accepted: true };

async function fixture() {
  let resolve: (value: typeof accepted) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<typeof accepted>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  const committed = { promise, resolve, reject };
  const order: string[] = [];
  const write = vi.fn(() =>
    committed.promise.then((result) => {
      order.push("commit");
      return result;
    }),
  );
  const read = vi.fn(async () => ({ saved: true }));
  const wake = vi.fn(async () => {
    order.push("wake");
  });
  const module = await Test.createTestingModule({
    controllers: [NationalCatalogImportController, NationalCatalogLinkController],
    providers: [
      { provide: PgBossService, useValue: { wakeNationalCatalog: wake } },
      {
        provide: NationalCatalogImportService,
        useValue: { start: write, retry: write, select: write, cancel: write, read, items: read },
      },
      {
        provide: NationalCatalogImportPreviewService,
        useValue: { prepare: write, retryPreparation: write, readPreparation: read },
      },
      {
        provide: NationalCatalogImportApplyService,
        useValue: { start: write, retry: write, read },
      },
      {
        provide: NationalCatalogImageService,
        useValue: {
          prepare: write,
          readPreview: vi.fn(async () => ({ contentType: "image/webp", buffer: Buffer.alloc(0) })),
        },
      },
      { provide: NationalCatalogCapabilitiesService, useValue: { read } },
      {
        provide: NationalCatalogLinkService,
        useValue: { refresh: write, remove: write, readDetail: read },
      },
    ],
  })
    .overrideGuard(TenantGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(AuthorizationGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(SubscriptionAccessGuard)
    .useValue({ canActivate: () => true })
    .compile();
  return {
    module,
    controller: module.get(NationalCatalogImportController),
    links: module.get(NationalCatalogLinkController),
    committed,
    order,
    wake,
  };
}

type Controllers = Pick<Awaited<ReturnType<typeof fixture>>, "controller" | "links">;
const mutations: Array<{ name: string; call: (controllers: Controllers) => Promise<unknown> }> = [
  { name: "start", call: ({ controller }) => controller.start(req, { mode: "own_catalog" }) },
  {
    name: "retry enumeration",
    call: ({ controller }) => controller.retrySession(req, sessionId, {}),
  },
  {
    name: "prepare",
    call: ({ controller }) =>
      controller.prepare(req, sessionId, {
        requestId: workId,
        itemIds: [workId],
        manualNames: [],
        categoryChoices: [],
      }),
  },
  {
    name: "retry preparation",
    call: ({ controller }) => controller.retryPreparation(req, sessionId, workId, {}),
  },
  {
    name: "prepare photo",
    call: ({ controller }) => controller.prepareImage(req, sessionId, workId, workId, {}),
  },
  {
    name: "apply",
    call: ({ controller }) =>
      controller.apply(req, sessionId, { requestId: workId, decisions: [] }),
  },
  {
    name: "retry apply",
    call: ({ controller }) =>
      controller.retryApply(req, sessionId, workId, { previewIds: [workId] }),
  },
  { name: "refresh link", call: ({ links }) => links.refresh(req, workId, {}) },
];

describe("National Catalog request queue wake", () => {
  it("compiles the production controller and worker dependency graph without starting jobs or database work", async () => {
    const env = loadEnv({
      ...process.env,
      DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
      BETTER_AUTH_SECRET: "national-catalog-dependency-test-secret-1234567890",
      BETTER_AUTH_URL: "http://localhost:3000",
    });
    const setup = setupAuth(env);
    const query = vi.spyOn(setup.pool, "query").mockImplementation(() => {
      throw new Error("Dependency compilation must not query the database");
    });
    try {
      const module = await Test.createTestingModule({
        imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
      }).compile();
      try {
        expect(module.get(NationalCatalogImportController)).toBeInstanceOf(
          NationalCatalogImportController,
        );
        expect(module.get(NationalCatalogLinkController)).toBeInstanceOf(
          NationalCatalogLinkController,
        );
        expect(module.get(PgBossService)).toBeInstanceOf(PgBossService);
        expect(module.get(NationalCatalogJobsService)).toBeInstanceOf(NationalCatalogJobsService);
        expect(module.get(EntitlementSourcesService)).toBeInstanceOf(EntitlementSourcesService);
        const capabilities = module.get(NationalCatalogCapabilitiesService);
        const observed = {
          observedAt: new Date().toISOString(),
          chz: "ready" as const,
          nationalCatalog: "not_ready" as const,
        };
        const observation = vi
          .spyOn(capabilities, "observeEntitlementConnectivity")
          .mockResolvedValue(observed);
        const snapshot = projectEntitlements({
          current: {
            tenantId: "tenant",
            access: "unmanaged",
            subscription: null,
            quotas: { lines: null, stations: null, kiosks: null, cabinetUsers: null },
            features: { labelEditor: true, publicApi: true, pallets: true },
          },
          usage: { lines: 0, stations: 0, kiosks: 0, cabinetUsers: 0 },
          sources: [],
          at: new Date(),
          enforcementMode: "managed_only",
          revision: "0",
          usageRevision: "0",
          boundaries: [],
          readinessReasons: [],
        });
        expect(
          (await module.get(EntitlementsService).observeConnectivity(snapshot)).connectivity,
        ).toEqual(observed);
        expect(observation).toHaveBeenCalledExactlyOnceWith("tenant");
        observation.mockRestore();
        expect(query).not.toHaveBeenCalled();
      } finally {
        await module.close();
      }
    } finally {
      query.mockRestore();
      if (!setup.pool.ended) await setup.pool.end();
    }
  });

  it.each(mutations)("$name wakes only after the intent transaction settles", async ({ call }) => {
    const f = await fixture();
    try {
      const request = call(f);
      expect(f.wake).not.toHaveBeenCalled();
      f.committed.resolve(accepted);
      await expect(request).resolves.toBe(accepted);
      expect(f.wake).toHaveBeenCalledExactlyOnceWith();
      expect(f.order).toEqual(["commit", "wake"]);
    } finally {
      await f.module.close();
    }
  });

  it.each(mutations)("$name does not wake for a rejected intent", async ({ call }) => {
    const f = await fixture();
    try {
      const request = call(f);
      f.committed.reject(new Error("transaction rolled back"));
      await expect(request).rejects.toThrow("transaction rolled back");
      expect(f.wake).not.toHaveBeenCalled();
    } finally {
      await f.module.close();
    }
  });

  it("never wakes work from stored GET endpoints", async () => {
    const f = await fixture();
    try {
      await f.controller.capabilitiesRead(req);
      await f.controller.read(req, sessionId);
      await f.controller.preparation(req, sessionId, workId);
      await f.controller.result(req, sessionId, workId);
      await f.controller.items(req, sessionId, {
        search: "",
        includeArchived: "false",
        limit: 100,
      });
      const response = {
        setHeader: vi.fn(),
        type: vi.fn(() => response),
        send: vi.fn(),
      };
      await f.controller.image(req, sessionId, workId, response as unknown as Response);
      await f.links.read(req, workId);
      expect(f.wake).not.toHaveBeenCalled();
    } finally {
      await f.module.close();
    }
  });
});
