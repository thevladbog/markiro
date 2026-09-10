import { Global, Module, type DynamicModule, type Provider } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { DB } from "../src/auth/auth.module";
import { JobsModule, PgBossService } from "../src/jobs/jobs.module";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { PlatformReportRunnerService } from "../src/platform-reports/platform-report-runner.service";
import { PlatformReportSourceService } from "../src/platform-reports/report-source.service";
import { PlatformReportsService } from "../src/platform-reports/platform-reports.service";
import { PlatformReportsModule } from "../src/platform-reports/platform-reports.module";
import { loadEnv } from "../src/env";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";
import { SubscriptionStatusJob } from "../src/subscriptions/subscription-status.job";

@Global()
@Module({
  providers: [
    { provide: DB, useValue: {} },
    { provide: ObjectStorageService, useValue: {} },
    { provide: SubscriptionStatusJob, useValue: {} },
  ],
  exports: [DB, ObjectStorageService, SubscriptionStatusJob],
})
class Boundaries {}

describe("platform reports module integration", () => {
  it("resolves real report workers in JobsModule without PlatformAuthModule and API service with the global queue", async () => {
    const env = loadEnv({
      ...PLATFORM_TEST_ENV,
      DATABASE_URL: "postgres://localhost/unavailable",
      BETTER_AUTH_SECRET: "fixture-placeholder",
      BETTER_AUTH_URL: "http://localhost:3000",
      PAIRING_CODE_PEPPER: "fixture-placeholder",
    });
    const jobs = JobsModule.forRoot(env.DATABASE_URL, env);
    const builder = Test.createTestingModule({
      imports: [Boundaries, jobs, PlatformReportsModule],
    });
    const real = new Set<unknown>([
      PgBossService,
      PlatformReportRunnerService,
      PlatformReportSourceService,
      PlatformAuditService,
    ]);
    const override = (provider: Provider) => {
      const token = typeof provider === "object" ? provider.provide : provider;
      if (!real.has(token)) builder.overrideProvider(token).useValue({});
    };
    for (const provider of jobs.providers ?? []) override(provider);
    for (const imported of jobs.imports ?? [])
      for (const provider of (imported as DynamicModule).providers ?? []) override(provider);
    const module = await builder.compile();
    try {
      expect(module.get(PlatformReportRunnerService)).toBeInstanceOf(PlatformReportRunnerService);
      expect(module.get(PlatformReportsService)).toBeInstanceOf(PlatformReportsService);
      expect(module.get(PgBossService)).toBeInstanceOf(PgBossService);
    } finally {
      await module.close();
    }
  });
});
