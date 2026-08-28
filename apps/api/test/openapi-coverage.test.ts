import "reflect-metadata";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static OpenAPI coverage gate: every Nest route must carry an
 * `@ApiOperation` summary and at least one documented success response so
 * Scalar renders real request/response documentation instead of bare paths.
 * `@ApiExcludeEndpoint()` is the explicit escape hatch for routes that must
 * stay out of the public document.
 *
 * This deliberately reads decorator metadata instead of building the app:
 * SwaggerModule.createDocument needs a fully wired AppModule (database,
 * Better Auth, storage), which would turn a lint-shaped invariant into an
 * environment-dependent e2e test.
 */

const PATH_METADATA = "path";
const METHOD_METADATA = "method";
const API_OPERATION = "swagger/apiOperation";
const API_RESPONSE = "swagger/apiResponse";
const API_EXCLUDE_ENDPOINT = "swagger/apiExcludeEndpoint";

// 204/205 have no body by definition; a bare status declaration is complete.
const BODYLESS_STATUSES = new Set(["204", "205"]);

const HTTP_METHOD_NAMES = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD"];

// `import.meta.glob` would be the idiomatic vitest way, but this package
// typechecks under `module: "commonjs"`, where `import.meta` is a hard
// TS1343 error — so the controllers are discovered by walking the tree and
// loaded via dynamic import (vite transforms the TS sources either way).
const SRC_DIR = join(process.cwd(), "src");

function findControllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return findControllerFiles(full);
    return entry.isFile() && entry.name.endsWith(".controller.ts") ? [full] : [];
  });
}

interface RouteProblem {
  route: string;
  problems: string[];
}

async function collectProblems(): Promise<RouteProblem[]> {
  const files = findControllerFiles(SRC_DIR).sort();
  expect(files.length).toBeGreaterThan(40); // guard against a silently-empty walk

  const failures: RouteProblem[] = [];

  for (const file of files) {
    const moduleExports: Record<string, unknown> = await import(file);
    for (const exported of Object.values(moduleExports)) {
      if (typeof exported !== "function") continue;
      const controllerPath: unknown = Reflect.getMetadata(PATH_METADATA, exported);
      if (typeof controllerPath !== "string") continue;

      const classResponses: Record<string, unknown> =
        Reflect.getMetadata(API_RESPONSE, exported) ?? {};

      const prototype = (exported as { prototype: object }).prototype;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        if (name === "constructor") continue;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        const handler = descriptor?.value;
        if (typeof handler !== "function") continue;

        const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
        if (typeof method !== "number") continue;
        if (Reflect.getMetadata(API_EXCLUDE_ENDPOINT, handler)?.disable) continue;

        const routePath: unknown = Reflect.getMetadata(PATH_METADATA, handler);
        const route = `${HTTP_METHOD_NAMES[method] ?? method} /${controllerPath}${
          typeof routePath === "string" && routePath !== "/" ? `/${routePath}` : ""
        } (${relative(SRC_DIR, file)}#${name})`;

        const problems: string[] = [];

        const operation = Reflect.getMetadata(API_OPERATION, handler) as
          { summary?: string } | undefined;
        if (!operation?.summary?.trim()) {
          problems.push("missing @ApiOperation({ summary })");
        }

        const responses: Record<string, { schema?: unknown; content?: unknown; type?: unknown }> = {
          ...classResponses,
          ...(Reflect.getMetadata(API_RESPONSE, handler) ?? {}),
        };
        const successEntries = Object.entries(responses).filter(([status]) => {
          const code = Number(status);
          return Number.isFinite(code) && code >= 200 && code < 400;
        });
        if (successEntries.length === 0) {
          problems.push("no documented 2xx/3xx response");
        } else {
          const described = successEntries.some(
            ([status, options]) =>
              BODYLESS_STATUSES.has(status) ||
              Boolean(options.schema) ||
              Boolean(options.content) ||
              Boolean(options.type),
          );
          if (!described) {
            problems.push("success response has no schema/content (and is not 204/205)");
          }
        }

        if (problems.length > 0) failures.push({ route, problems });
      }
    }
  }

  return failures.sort((a, b) => a.route.localeCompare(b.route));
}

describe("OpenAPI documentation coverage", () => {
  it("documents a summary and a success response for every route", async () => {
    const failures = await collectProblems();
    const report = failures
      .map(({ route, problems }) => `${route}\n  - ${problems.join("\n  - ")}`)
      .join("\n");
    expect(failures, `Undocumented routes:\n${report}`).toEqual([]);
  });
});
