import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const root = new URL("../../..", import.meta.url);

test("API runtime trusts the pinned Yandex Managed PostgreSQL CA", async () => {
  const source = await readFile(new URL("deploy/production/api.Dockerfile", root), "utf8");
  const pem = await readFile(new URL("deploy/production/yandex-cloud-ca.pem", root), "utf8").catch(
    () => "",
  );
  const certificates =
    pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];

  assert.match(
    source,
    /COPY --chown=root:root deploy\/production\/yandex-cloud-ca\.pem \/etc\/ssl\/certs\/yandex-cloud-ca\.pem/,
  );
  assert.match(source, /ENV NODE_EXTRA_CA_CERTS=\/etc\/ssl\/certs\/yandex-cloud-ca\.pem/);
  assert.equal(certificates.length, 2);
  assert.equal(
    new X509Certificate(certificates[0]).fingerprint256,
    "E1:D5:3D:D1:D7:56:6D:0D:C6:91:C9:ED:6F:CA:0C:91:0F:58:B9:5D:4E:D7:F0:A9:58:AC:C7:67:A1:B2:49:37",
  );
  assert.match(new X509Certificate(certificates[1]).subject, /CN=YandexInternalRootCA/);
});

test("API image keeps the production runtime closure minimal and hardened", async () => {
  const source = await readFile(new URL("deploy/production/api.Dockerfile", root), "utf8");

  assert.match(source, /FROM node:24\.19\.0-bookworm-slim AS build/);
  assert.match(source, /corepack prepare pnpm@11\.10\.0 --activate/);
  assert.match(source, /pnpm install --frozen-lockfile/);
  assert.match(
    source,
    /COPY packages\/legal-documents\/package\.json \.\/packages\/legal-documents\/package\.json/,
  );
  assert.match(source, /COPY packages\/legal-documents \.\/packages\/legal-documents/);
  const domainBuild = source.indexOf("RUN pnpm --filter @markiro/domain build");
  const dbBuild = source.indexOf("RUN pnpm --filter @markiro/db build");
  const emailBuild = source.indexOf("RUN pnpm --filter @markiro/email build");
  const legalBuild = source.indexOf("RUN pnpm --filter @markiro/legal-documents build");
  const apiBuild = source.indexOf("RUN pnpm --filter @markiro/api build");
  assert.ok(
    domainBuild >= 0 &&
      dbBuild > domainBuild &&
      emailBuild > dbBuild &&
      legalBuild > emailBuild &&
      apiBuild > legalBuild,
  );
  assert.match(
    source,
    /pnpm --config\.allow-unused-patches=true --filter @markiro\/api deploy --legacy --prod \/out\/api/,
  );
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
  for (const extension of ["ts", "tsx", "mts", "cts"]) {
    assert.match(source, new RegExp(`-name '\\*\\.${extension}'`));
  }
  assert.match(
    source,
    /! -name '\*\.d\.ts' ! -name '\*\.d\.tsx' ! -name '\*\.d\.mts' ! -name '\*\.d\.cts' -delete/,
  );
  assert.match(
    source,
    /rm -rf \/out\/api\/src \/out\/api\/test \/out\/api\/tests \/out\/api\/scripts \/out\/api\/\.turbo/,
  );
  for (const directory of ["test", "tests", "scripts", ".turbo"]) {
    assert.match(source, new RegExp(`-name ${directory.replace(".", "\\.")}`));
  }
  assert.match(source, /-prune -exec rm -rf \{\} \+/);
  assert.match(source, /-name nest-cli\.json/);
  assert.match(source, /-name 'tsconfig\*\.json'/);
  assert.match(source, /find \/out\/api\/dist -type f/);
  assert.match(source, /find -L \/out\/api\/node_modules\/@markiro -type f/);
  assert.match(source, /rm -f \/out\/api\/turbo\.json/);
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
    "!packages/legal-documents/**",
    "!packages/db/migrations/**",
    "!deploy/production/yandex-cloud-ca.pem",
  ]) {
    assert.match(source, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }

  const lastSourceInclude = source.lastIndexOf("!packages/legal-documents/**");
  assert.ok(source.lastIndexOf("**/node_modules") > lastSourceInclude);
  assert.ok(source.lastIndexOf("**/dist/") > lastSourceInclude);
});

test("API shutdown hooks exit with the hook outcome instead of re-sending the signal", async () => {
  const sourceText = await readFile(new URL("apps/api/src/main.ts", root), "utf8");
  const source = ts.createSourceFile(
    "main.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const calls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "enableShutdownHooks"
    )
      calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.length, 2);
  const [signals, options] = calls[0].arguments;
  assert.ok(ts.isArrayLiteralExpression(signals));
  assert.equal(signals.elements.length, 0);
  assert.ok(ts.isObjectLiteralExpression(options));
  const useProcessExit = options.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) && property.name.getText(source) === "useProcessExit",
  );
  assert.ok(useProcessExit);
  assert.equal(useProcessExit.initializer.kind, ts.SyntaxKind.TrueKeyword);
});
