import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";
import { createUsEntryBoundary } from "./vite.us-entry-boundary.ts";

export function createUsHostedAdminConfig(
  raw: NodeJS.ProcessEnv,
  mode: string,
  command: "build" | "serve",
  isPreview: boolean,
): UserConfig {
  if (
    raw.VITE_DEPLOYMENT_EDITION !== "US" ||
    (raw.MARKIRO_DEPLOYMENT_EDITION !== undefined && raw.MARKIRO_DEPLOYMENT_EDITION !== "US") ||
    mode !== "production" ||
    command !== "build" ||
    isPreview
  )
    throw new Error("us_hosted_static_build_refused");
  return {
    root: fileURLToPath(new URL("./us-hosted", import.meta.url)),
    base: "/",
    envDir: false,
    envPrefix: [],
    publicDir: false,
    plugins: [react(), createUsEntryBoundary()],
    define: { "import.meta.env.VITE_DEPLOYMENT_EDITION": JSON.stringify("US") },
    build: {
      outDir: fileURLToPath(new URL("./dist-us", import.meta.url)),
      emptyOutDir: true,
      sourcemap: false,
      manifest: true,
    },
  };
}
export default defineConfig(({ mode, command, isPreview = false }) =>
  createUsHostedAdminConfig(process.env, mode, command, isPreview),
);
