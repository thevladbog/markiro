import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import "reflect-metadata";
import { createDb } from "@markiro/db";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { createUsDevelopmentApplication } from "../src/deployment/us-bootstrap";
import { UsRuntime } from "../src/deployment/us-runtime";
import { UsRequestHttpRuntime } from "../src/deployment/us-request-http-runtime";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { storageEnvironment } from "./support/us-request-worker-storage-fixture";
import * as policy from "../src/deployment/entry-policy";

const fixture = () =>
  parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8"));

describe("edition entry boundaries", () => {
  it.each([undefined, "RU"])("keeps the RU entry compatible with %s", (edition) => {
    expect(() => policy.assertRuEntryEdition(edition)).not.toThrow();
  });
  it.each(["US", "us", "", null, "EU"])("refuses %s at the RU entry", (edition) => {
    expect(() => policy.assertRuEntryEdition(edition)).toThrow();
  });
  it("accepts the isolated synthetic US example", () => {
    const env = policy.loadUsDevelopmentEnv(fixture());
    expect(env.PORT).toBe(3100);
    expect(env.SMTP_PORT).toBe(11025);
    expect(env.S3_BUCKET).toBe("markiro-us-development");
  });
  it.each([
    ["MARKIRO_DEPLOYMENT_EDITION", undefined],
    ["MARKIRO_DEPLOYMENT_EDITION", "RU"],
    ["MARKIRO_DEPLOYMENT_EDITION", "us"],
    ["NODE_ENV", "production"],
    ["NODE_ENV", undefined],
    ["VITE_DEPLOYMENT_EDITION", "RU"],
    ["VITE_DEPLOYMENT_EDITION", undefined],
    ["DATABASE_URL", "postgres://user:pass@localhost:5432/markiro"],
    ["DATABASE_URL", "postgres://user:pass@db.example.com:55432/markiro_us_dev"],
    ["DATABASE_URL", "postgres://user:pass@127.0.0.1:55432/markiro_us_dev?host=db.example.com"],
    ["DATABASE_URL", undefined],
    ["SMTP_HOST", "smtp.example.com"],
    ["SMTP_PORT", "1025"],
    ["SMTP_HOST", undefined],
    ["SMTP_SECURE", "true"],
    ["S3_ENDPOINT", "http://127.0.0.1:9000"],
    ["S3_ENDPOINT", "https://storage.example.com"],
    ["S3_ENDPOINT", undefined],
    ["S3_BUCKET", "markiro-private"],
    ["ADMIN_ORIGIN", "http://localhost:5173"],
    ["BETTER_AUTH_URL", "https://admin.markiro.app"],
    ["PORT", "3000"],
    ["PORT", undefined],
  ] as const)("refuses unsafe or absent %s (%s)", (key, value) => {
    const raw: NodeJS.ProcessEnv = { ...fixture(), [key]: value };
    expect(() => policy.loadUsDevelopmentEnv(raw)).toThrow();
  });
  it("does not reveal a rejected connection string in its diagnostic", () => {
    try {
      policy.loadUsDevelopmentEnv({
        ...fixture(),
        DATABASE_URL: "postgres://private-user:private-secret@db.example.com/db",
      });
      expect.fail("unsafe configuration was accepted");
    } catch (error) {
      expect(String(error)).not.toContain("private-secret");
      expect(String(error)).not.toContain("private-user");
      expect(String(error)).toContain("DATABASE_URL");
    }
  });
});

describe.skipIf(!process.env.US_TEST_DATABASE_URL)("US HTTP owned setup and teardown", () => {
  const planConfig = {
    US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
    US_PLAN_ARTIFACT_S3_REGION: "us-east-1",
    US_PLAN_ARTIFACT_S3_BUCKET: "us-plan-test",
    US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "plan-test",
    US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "plan-test-secret",
    US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
  };
  async function owned<T>(
    work: (
      database: Awaited<ReturnType<typeof createUsProfileTestDatabase>>,
      target: string,
    ) => Promise<T>,
  ) {
    const base = process.env.US_TEST_DATABASE_URL;
    if (!base) throw new Error("Explicit isolated US database required");
    const database = await createUsProfileTestDatabase(base);
    try {
      const identity = await database.pool.query("SELECT current_database() AS name");
      const url = new URL(base);
      url.pathname = `/${String(identity.rows[0]?.name)}`;
      return await work(database, url.toString());
    } finally {
      await database.close();
    }
  }
  it("keeps caller DB ownership and defaults direct constructors to unavailable resources", async () => {
    await owned(async (database) => {
      const requests = new UsRequestHttpRuntime(database.db);
      expect(await requests.resources.availability()).toEqual({
        build: "unavailable",
        packageStorage: "unconfigured",
      });
      requests.dispose();
      requests.dispose();
      expect((await database.pool.query("SELECT 1 AS healthy")).rows[0]).toEqual({ healthy: 1 });
    });
  }, 60_000);

  it.each(["request", "plan"] as const)(
    "disposes both clients and ends the owned pool exactly once when %s teardown throws",
    async (broken) => {
      await owned(async (_database, target) => {
        const connection = createDb(target);
        const runtime = new UsRuntime(
          policy.loadUsDevelopmentEnv({ ...fixture(), ...planConfig }),
          connection,
          undefined,
          { source: { ...fixture(), ...storageEnvironment() } },
        );
        runtime.requestHttp.resources.requirePackageStore();
        if (!runtime.planArtifactStorage) throw new Error("Missing fixture Plan storage");
        const originalRequest = runtime.requestHttp.dispose.bind(runtime.requestHttp);
        const originalPlan = runtime.planArtifactStorage.onModuleDestroy.bind(
          runtime.planArtifactStorage,
        );
        const requestDispose = vi.spyOn(runtime.requestHttp, "dispose");
        const planDispose = vi.spyOn(runtime.planArtifactStorage, "onModuleDestroy");
        const failure = new Error("Synthetic disposal failure");
        if (broken === "request")
          requestDispose.mockImplementation(() => {
            originalRequest();
            throw failure;
          });
        else
          planDispose.mockImplementation(() => {
            originalPlan();
            throw failure;
          });
        const end = vi.spyOn(connection.pool, "end");
        const first = runtime.onApplicationShutdown();
        expect(runtime.onApplicationShutdown()).toBe(first);
        await expect(first).rejects.toThrow(failure);
        expect(requestDispose).toHaveBeenCalledTimes(1);
        expect(planDispose).toHaveBeenCalledTimes(1);
        expect(end).toHaveBeenCalledTimes(1);
        expect(() => runtime.requestHttp.resources.requirePackageStore()).toThrow();
      });
    },
    60_000,
  );

  it("cleans constructed clients and owned pool after Nest setup failure", async () => {
    await owned(async (database, target) => {
      const connection = createDb(target);
      const end = vi.spyOn(connection.pool, "end");
      let runtime: UsRuntime | undefined;
      const failure = new Error("Synthetic Nest setup failure");
      const create = vi.spyOn(NestFactory, "create").mockImplementation(async (module) => {
        if (typeof module === "object" && "providers" in module) {
          for (const provider of module.providers ?? [])
            if (
              typeof provider === "object" &&
              "useValue" in provider &&
              provider.useValue instanceof UsRuntime
            )
              runtime = provider.useValue;
        }
        runtime?.requestHttp.resources.requirePackageStore();
        throw failure;
      });
      try {
        await expect(
          createUsDevelopmentApplication(
            { ...fixture(), ...storageEnvironment(), ...planConfig },
            () => connection,
          ),
        ).rejects.toThrow(failure);
        expect(end).toHaveBeenCalledTimes(1);
        expect(() => runtime?.requestHttp.resources.requirePackageStore()).toThrow();
        expect((await database.pool.query("SELECT 1 AS healthy")).rows[0]).toEqual({ healthy: 1 });
      } finally {
        create.mockRestore();
      }
    });
  }, 60_000);
});
