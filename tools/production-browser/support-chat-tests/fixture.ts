import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test as base, expect } from "@playwright/test";
import type { ViteDevServer } from "../../../apps/admin/node_modules/vite";

export interface SupportBrowserStack {
  adminUrl: string;
  platformUrl: string;
  setPlatformRole(userId: string): Promise<void>;
  command(input: {
    kind: "addMember" | "revokeMember" | "seedRemote" | "sync" | "failNextRead";
    tenantId?: string;
    userId?: string;
    episodeId?: string;
    messages?: Array<{ text: string; private: boolean; activity?: boolean }>;
  }): Promise<void>;
}

const repo = join(import.meta.dirname, "../../..");
const requireFromAdmin = createRequire(join(repo, "apps/admin/package.json"));

async function startFrontend(
  app: "admin" | "saas-admin",
  port: number,
  target: string,
): Promise<ViteDevServer> {
  const vite = await import(pathToFileURL(requireFromAdmin.resolve("vite")).href);
  const proxy =
    app === "admin"
      ? {
          "/api/auth": { target, changeOrigin: true },
          "/api": {
            target,
            changeOrigin: true,
            rewrite: (path: string) => path.replace(/^\/api/, ""),
          },
        }
      : {
          "/api/platform-auth": { target, changeOrigin: true },
          "/api/platform": {
            target,
            changeOrigin: true,
            rewrite: (path: string) => path.replace(/^\/api/, ""),
          },
        };
  const server = await vite.createServer({
    configFile: join(repo, "apps", app, "vite.config.ts"),
    root: join(repo, "apps", app),
    server: { host: "127.0.0.1", port, strictPort: true, proxy },
  });
  await server.listen();
  return server;
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function freeLoopbackPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

export const test = base.extend<{ stack: SupportBrowserStack }>({
  stack: async ({}, use) => {
    if (
      process.env.SUPPORT_CHAT_ISOLATED_DB !== "1" ||
      process.env.SUPPORT_CHAT_TEST_MAINTENANCE_URL !==
        "postgresql://postgres@127.0.0.1:40061/postgres"
    ) {
      throw new Error("Browser stack requires the explicit local scratch PostgreSQL fixture");
    }
    const control = await mkdtemp(join(tmpdir(), "markiro-support-browser-"));
    let child: ChildProcess | undefined;
    let admin: ViteDevServer | undefined;
    let platform: ViteDevServer | undefined;
    let childOutput = "";
    try {
      const adminPort = await freeLoopbackPort();
      const platformPort = await freeLoopbackPort();
      if (adminPort === platformPort) throw new Error("Distinct browser ports required");
      child = spawn(
        "corepack",
        [
          "pnpm",
          "--filter",
          "@markiro/api",
          "exec",
          "vitest",
          "run",
          "test/support-chat-browser-server.test.ts",
        ],
        {
          cwd: repo,
          env: {
            ...process.env,
            NODE_ENV: "test",
            SUPPORT_CHAT_BROWSER_CONTROL_DIR: control,
            SUPPORT_CHAT_BROWSER_ADMIN_PORT: String(adminPort),
            SUPPORT_CHAT_BROWSER_PLATFORM_PORT: String(platformPort),
            VITE_CONFIG_NATIVE_IGNORE_WARNING: "true",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout?.on("data", (chunk: Buffer) => {
        childOutput = (childOutput + chunk.toString()).slice(-6000);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        childOutput = (childOutput + chunk.toString()).slice(-6000);
      });
      await waitUntil(
        () => existsSync(join(control, "ready.json")) || child?.exitCode !== null,
        "local API fixture",
        90_000,
      );
      if (!existsSync(join(control, "ready.json"))) {
        throw new Error(`Local API fixture exited before readiness: ${childOutput}`);
      }
      const ready = JSON.parse(await readFile(join(control, "ready.json"), "utf8")) as {
        port: number;
      };
      if (!Number.isInteger(ready.port) || ready.port < 1024 || ready.port > 65535) {
        throw new Error("Invalid loopback API fixture port");
      }
      const target = `http://127.0.0.1:${ready.port}`;
      admin = await startFrontend("admin", adminPort, target);
      platform = await startFrontend("saas-admin", platformPort, target);
      await use({
        adminUrl: `http://localhost:${adminPort}`,
        platformUrl: `http://localhost:${platformPort}`,
        setPlatformRole: async (userId: string) => {
          const nonce = randomUUID();
          await writeFile(
            join(control, "platform-role-request.json"),
            JSON.stringify({ userId, nonce }),
          );
          await waitUntil(
            () =>
              existsSync(join(control, `platform-role-ack-${nonce}`)) || child?.exitCode !== null,
            "test platform role seed",
            10_000,
          );
          if (!existsSync(join(control, `platform-role-ack-${nonce}`))) {
            throw new Error(`Local API fixture exited during role seed: ${childOutput}`);
          }
        },
        command: async (input) => {
          const nonce = randomUUID();
          await writeFile(
            join(control, "support-command.json"),
            JSON.stringify({ ...input, nonce }),
          );
          await waitUntil(
            () =>
              existsSync(join(control, `support-command-ack-${nonce}`)) || child?.exitCode !== null,
            "test support command",
            10_000,
          );
          if (!existsSync(join(control, `support-command-ack-${nonce}`))) {
            throw new Error(`Local API fixture exited during support command: ${childOutput}`);
          }
        },
      });
    } finally {
      await platform?.close();
      await admin?.close();
      if (child && child.exitCode === null) {
        await writeFile(join(control, "stop"), "1");
        await Promise.race([
          new Promise<void>((resolve) => child!.once("exit", () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
        ]);
        if (child.exitCode === null) child.kill("SIGTERM");
      }
      await rm(control, { recursive: true, force: true });
    }
  },
});

export { expect };
