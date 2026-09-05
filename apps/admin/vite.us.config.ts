import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type UserConfig, type ViteDevServer } from "vite";

/** Local validation only. No inherited .env, RU proxy, public files or dist output. */
export function createUsAdminConfig(raw: NodeJS.ProcessEnv, mode: string) {
  if (
    raw.VITE_DEPLOYMENT_EDITION !== "US" ||
    (raw.MARKIRO_DEPLOYMENT_EDITION !== undefined && raw.MARKIRO_DEPLOYMENT_EDITION !== "US") ||
    !["development", "test"].includes(mode)
  )
    throw new Error("US local browser requires explicit US edition and development/test mode");

  const proxy = {
    "^/api/us-auth/": { target: "http://localhost:3100", changeOrigin: true },
    "^/api/us/(deployment|traceability/profile)(\\?.*)?$": {
      target: "http://localhost:3100",
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api\/us/, ""),
    },
    "^/api/us/traceability/access$": {
      target: "http://localhost:3100",
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api\/us/, ""),
    },
    "^/api/us/traceability/(parties|locations)(/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})?(\\?.*)?$":
      {
        target: "http://localhost:3100",
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api\/us/, ""),
      },
  };
  function rejectUnknownApi(server: Pick<ViteDevServer, "middlewares">) {
    server.middlewares.use((request, response, next) => {
      const path = request.url ?? "/";
      if (
        path.startsWith("/api/") &&
        !Object.keys(proxy).some((pattern) => new RegExp(pattern).test(path))
      ) {
        response.writeHead(404, { "Cache-Control": "no-store" });
        response.end();
        return;
      }
      next();
    });
  }
  const adminSource = fileURLToPath(new URL("./src/", import.meta.url));
  const entryBoundary = {
    name: "us-entry-boundary",
    enforce: "pre",
    transform(_source: string, id: string) {
      if (
        id.startsWith(adminSource) &&
        !id.startsWith(`${adminSource}us/`) &&
        !id.startsWith(`${adminSource}assets/`)
      ) {
        this.error("US entry cannot import RU application code");
      }
    },
  } satisfies Plugin;
  return {
    root: fileURLToPath(new URL("./us", import.meta.url)),
    envDir: false,
    envPrefix: [],
    publicDir: false,
    plugins: [
      react(),
      entryBoundary,
      {
        name: "us-api-allowlist",
        configureServer: rejectUnknownApi,
        configurePreviewServer: rejectUnknownApi,
      },
    ],
    define: { "import.meta.env.VITE_DEPLOYMENT_EDITION": JSON.stringify("US") },
    server: {
      host: "localhost",
      port: 5174,
      strictPort: true,
      proxy,
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    },
    preview: { host: "localhost", port: 5174, strictPort: true, proxy },
    build: {
      outDir: fileURLToPath(new URL("./dist-us", import.meta.url)),
      emptyOutDir: true,
      sourcemap: false,
      manifest: true,
    },
  } satisfies UserConfig;
}

export default defineConfig(({ mode }) => createUsAdminConfig(process.env, mode));
