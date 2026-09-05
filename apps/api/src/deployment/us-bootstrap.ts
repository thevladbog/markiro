import { type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createDb } from "@markiro/db";
import { loadUsDevelopmentEnv } from "./entry-policy";
import { UsDevelopmentModule } from "./us-development.module";
import { UsRuntime } from "./us-runtime";
import { mountUsHttp } from "./us-http";

export async function createUsDevelopmentApplication(
  raw: NodeJS.ProcessEnv,
  connect: typeof createDb = createDb,
): Promise<INestApplication> {
  const env = loadUsDevelopmentEnv(raw);
  const connection = connect(env.DATABASE_URL, {
    max: 5,
    connectionTimeoutMillis: 2000,
    // Cancel on PostgreSQL itself so Drizzle can finish ROLLBACK before reuse.
    statement_timeout: 5000,
  });
  let app: INestApplication | undefined;
  try {
    const runtime = new UsRuntime(env, connection);
    app = await NestFactory.create(UsDevelopmentModule.register(runtime), {
      logger: false,
      bodyParser: false,
      abortOnError: false,
    });
    app.enableCors({ origin: [env.ADMIN_ORIGIN], credentials: true });
    mountUsHttp(app, runtime);
    app.enableShutdownHooks([], { useProcessExit: true });
    return app;
  } catch (error) {
    if (app) await app.close();
    else await connection.pool.end();
    throw error;
  }
}
