import "reflect-metadata";
import express, { type Express } from "express";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { apiReference } from "@scalar/nestjs-api-reference";
import { AppModule } from "./app.module";
import { mountAuth, setupAuth } from "./auth/auth.setup";
import { corsDelegate } from "./cors";
import { loadEnv } from "./env";

const logger = new Logger("bootstrap");

async function bootstrap() {
  const env = loadEnv();
  const setup = setupAuth(env);

  // Better Auth needs the raw request body, so the Nest body parser is
  // disabled and express.json() is installed AFTER the auth handler below.
  const app = await NestFactory.create(
    AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL }),
    { bodyParser: false },
  );
  // Enabled before mountAuth below so the CORS middleware (registered here
  // via server.use()) sits ahead of the auth handler in Express's middleware
  // stack and applies to /api/auth/* too, not just Nest-routed controllers.
  //
  // A per-request delegate, not one static allowlist: KIOSK_ORIGIN is trusted
  // on `/kiosk/*` only, while everything else stays limited to ADMIN_ORIGIN.
  // See cors.ts for why that split matters and how the two lists differ.
  app.enableCors(corsDelegate(env));
  const server = app.getHttpAdapter().getInstance() as Express;

  // A numeric hop count, NEVER `true`. `true` makes Express trust the
  // left-most entry of X-Forwarded-For, which an attacker fully controls --
  // that both makes the kiosk-pairing limiter trivially bypassable by
  // rotating a header value and turns `kiosk_pair_attempts.source` (an
  // unbounded `text` column written from the one unauthenticated route in
  // the system) into an attacker-controlled row-growth vector. A hop count
  // counts inward from the right of X-Forwarded-For, which is the only end
  // the reverse proxy itself authoritatively controls.
  server.set("trust proxy", env.TRUST_PROXY_HOPS);
  if (process.env.NODE_ENV === "production" && env.TRUST_PROXY_HOPS === 0) {
    // Not a boot failure -- refusing to start over a rate-limiter
    // degradation would be its own outage -- but this must never be a
    // silent misconfiguration: every caller now resolves to the same
    // socket-peer address, so the kiosk-pairing limiter's per-source budget
    // collapses onto one bucket and only the global backstop still works.
    logger.warn(
      "TRUST_PROXY_HOPS=0 in production: req.ip is the socket peer, not the original " +
        "client. Per-source kiosk-pairing rate limiting is degraded to the global " +
        "backstop only -- set TRUST_PROXY_HOPS=1 behind a single reverse proxy such as Caddy.",
    );
  }

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
