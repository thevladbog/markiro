import { randomUUID } from "node:crypto";
import { HttpException, type INestApplication } from "@nestjs/common";
import { toNodeHandler } from "better-auth/node";
import { json, type NextFunction, type Request, type Response } from "express";
import { handleUsAuth } from "../modules/traceability/auth/us-auth";
import type { UsRuntime } from "./us-runtime";

function isUsBusinessPath(path: string): boolean {
  // Express routes are case-insensitive by default; security scope must match.
  path = path.toLowerCase();
  return (
    path === "/api/us-auth" ||
    path.startsWith("/api/us-auth/") ||
    path === "/traceability" ||
    path.startsWith("/traceability/")
  );
}

/** Runs before Nest routing. CORS is not mutation authorization. */
export function mountUsHttp(app: INestApplication, runtime: UsRuntime): void {
  const host = new URL(runtime.env.BETTER_AUTH_URL).host;
  const parseJson = json({ limit: "16kb", inflate: false });
  const authHandler = toNodeHandler((request) =>
    handleUsAuth(runtime.auth, request, () => runtime.assertDatabaseReady()),
  );

  app.use((request: Request & { usRequestId?: string }, response: Response, next: NextFunction) => {
    if (!isUsBusinessPath(request.path)) return next();
    response.setHeader("Cache-Control", "no-store");
    request.usRequestId = randomUUID();
    response.setHeader("X-Request-Id", request.usRequestId);
    if (request.headers.host !== host)
      return response.status(403).json({ code: "us_host_required" });
    // The HTTP adapter constructs its Fetch URL from these headers. No proxy is trusted.
    for (const key of Object.keys(request.headers)) {
      if (key.startsWith("x-forwarded-") || key === "forwarded" || key === ":authority")
        delete request.headers[key];
    }
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (mutation && request.headers.origin !== runtime.env.ADMIN_ORIGIN)
      return response.status(403).json({ code: "us_origin_required" });
    if (mutation && !request.is("application/json"))
      return response.status(415).json({ code: "us_json_required" });
    parseJson(request, response, (error: unknown) => {
      if (error) {
        const status = typeof error === "object" && "status" in error ? error.status : undefined;
        const safeStatus = status === 413 || status === 415 ? status : 400;
        response
          .status(safeStatus)
          .json({ code: safeStatus === 413 ? "us_body_too_large" : "us_invalid_body" });
        return;
      }
      if (request.path === "/api/us-auth" || request.path.startsWith("/api/us-auth/")) {
        void authHandler(request, response).catch((error: unknown) => {
          if (response.headersSent) {
            response.destroy();
            return;
          }
          const status = error instanceof HttpException ? error.getStatus() : 503;
          response.status(status).json({ code: "us_database_unavailable" });
        });
      } else next();
    });
  });
}
