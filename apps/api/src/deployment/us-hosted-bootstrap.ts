import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { createDb } from "@markiro/db";
import { UsDevelopmentModule } from "./us-development.module";
import { mountUsHttp } from "./us-http";
import { UsHostedRuntime } from "./us-hosted-runtime";
import { UsHostedHttpsAdapter } from "./us-hosted-https-adapter";
import { createUsHostedDatabase } from "./us-hosted-database";
import {
  verifyUsHostedRelease,
  disposeUsHostedRelease,
  type VerifiedUsHostedRelease,
} from "./us-hosted-release-verifier";
import {
  collectUsHostedMaterial,
  disposeUsHostedMaterial,
  type UsHostedMaterialOwner,
} from "./us-hosted-material-owner";

export class UsHostedApiStartupError extends Error {
  constructor() {
    super("us_hosted_api_startup_refused");
  }
}
export class UsHostedApiShutdownError extends Error {
  constructor() {
    super("us_hosted_api_shutdown_failed");
  }
}

/** Real fixed producer composition; deployment readiness remains separately locked. */
export async function createUsHostedApplication(): Promise<INestApplication> {
  let release: VerifiedUsHostedRelease | undefined;
  let material: UsHostedMaterialOwner | undefined;
  let connection: ReturnType<typeof createDb> | undefined;
  let runtime: UsHostedRuntime | undefined;
  let adapter: UsHostedHttpsAdapter | undefined;
  let nestClose: ((signal?: string) => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  const ownedClose = (signal?: string): Promise<void> => {
    closing ??= (async () => {
      // Prove native request settlement BEFORE Nest hooks can tear down any clients.
      try {
        await adapter?.close();
      } catch {
        throw new UsHostedApiShutdownError();
      }
      let failed = false;
      try {
        await nestClose?.(signal);
      } catch {
        failed = true;
      }
      try {
        if (runtime) await runtime.onApplicationShutdown();
        else await connection?.pool.end();
      } catch {
        failed = true;
      }
      try {
        if (material) disposeUsHostedMaterial(material);
      } catch {
        failed = true;
      }
      try {
        if (release) disposeUsHostedRelease(release);
      } catch {
        failed = true;
      }
      if (failed) throw new UsHostedApiShutdownError();
    })();
    return closing;
  };
  try {
    release = await verifyUsHostedRelease("api");
    material = await collectUsHostedMaterial(release);
    connection = createUsHostedDatabase(release, material);
    runtime = new UsHostedRuntime(release, material, connection);
    adapter = new UsHostedHttpsAdapter(release, material);
    const app = await NestFactory.create(UsDevelopmentModule.register(runtime), adapter, {
      logger: false,
      bodyParser: false,
      abortOnError: false,
    });
    nestClose = app.close.bind(app);
    app.close = ownedClose;
    app.enableCors({ origin: [runtime.env.ADMIN_ORIGIN], credentials: true });
    mountUsHttp(app, runtime);
    // Explicit executable signal handlers use the owned close path; no implicit bypass hook.
    return app;
  } catch {
    try {
      await ownedClose();
    } catch {
      /* Preserve the fixed primary startup category. */
    }
    throw new UsHostedApiStartupError();
  }
}
