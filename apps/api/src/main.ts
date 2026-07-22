import "reflect-metadata";
import express, { type Express } from "express";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { apiReference } from "@scalar/nestjs-api-reference";
import { AppModule } from "./app.module";
import { mountAuth, setupAuth } from "./auth/auth.setup";
import { loadEnv } from "./env";

async function bootstrap() {
  const env = loadEnv();
  const setup = setupAuth(env);

  // Better Auth needs the raw request body, so the Nest body parser is
  // disabled and express.json() is installed AFTER the auth handler below.
  const app = await NestFactory.create(
    AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL }),
    { bodyParser: false },
  );
  const server = app.getHttpAdapter().getInstance() as Express;
  mountAuth(server, setup.auth);
  server.use(express.json());

  // Without this, SIGINT/SIGTERM kill the process directly and Nest never
  // runs onModuleDestroy — so PgBossService.onModuleDestroy (boss.stop())
  // would never fire and pg-boss's connection pool would be torn down
  // abruptly instead of closing cleanly.
  app.enableShutdownHooks();

  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle("Markiro API").setVersion("0.1").build(),
  );
  app.use("/openapi.json", (_req: unknown, res: { json(b: unknown): void }) => res.json(doc));
  app.use("/docs", apiReference({ content: doc }));
  await app.listen(env.PORT);
}
void bootstrap();
