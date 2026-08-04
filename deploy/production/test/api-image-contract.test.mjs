import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../..", import.meta.url);

test("API image keeps the production runtime closure minimal and hardened", async () => {
  const source = await readFile(new URL("deploy/production/api.Dockerfile", root), "utf8");

  assert.match(source, /FROM node:24\.19\.0-bookworm-slim AS build/);
  assert.match(source, /corepack prepare pnpm@11\.10\.0 --activate/);
  assert.match(source, /pnpm install --frozen-lockfile/);
  assert.match(source, /turbo build --filter @markiro\/api\.\.\./);
  assert.match(source, /pnpm --filter @markiro\/api deploy --legacy --prod \/out\/api/);
  assert.match(source, /FROM node:24\.19\.0-bookworm-slim AS runtime/);
  assert.match(source, /apt-get install[^\n]*tini/);
  assert.match(source, /COPY --from=build(?: --chown=node:node)? \/out\/api \/app/);
  assert.match(
    source,
    /COPY --from=build(?: --chown=node:node)? \/workspace\/packages\/db\/migrations \/app\/node_modules\/@markiro\/db\/migrations/,
  );
  assert.match(source, /USER node/);
  assert.match(source, /ENTRYPOINT \["\/usr\/bin\/tini", "--"\]/);
  assert.match(source, /CMD \["node", "dist\/main\.js"\]/);
  assert.doesNotMatch(source, /drizzle-kit|pnpm install[^\n]*--prod/);
});

test("Docker build context excludes local state while retaining required build inputs", async () => {
  const source = await readFile(new URL(".dockerignore", root), "utf8");

  for (const pattern of [
    /^\.git$/m,
    /^\.worktrees$/m,
    /^node_modules$/m,
    /^dist\/$/m,
    /^\*\*\/dist\/$/m,
    /^\.env$/m,
    /^\.pnpm-store$/m,
    /^\.turbo$/m,
    /^coverage\/$/m,
    /^\.markiro-releases\/$/m,
  ]) {
    assert.match(source, pattern);
  }

  for (const entry of [
    "!package.json",
    "!pnpm-lock.yaml",
    "!pnpm-workspace.yaml",
    "!turbo.json",
    "!tsconfig.base.json",
    "!patches/**",
    "!apps/api/**",
    "!packages/db/**",
    "!packages/domain/**",
    "!packages/email/**",
    "!packages/db/migrations/**",
  ]) {
    assert.match(source, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }

  const lastSourceInclude = source.lastIndexOf("!packages/db/**");
  assert.ok(source.lastIndexOf("**/node_modules") > lastSourceInclude);
  assert.ok(source.lastIndexOf("**/dist/") > lastSourceInclude);
});
