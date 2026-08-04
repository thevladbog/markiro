import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const RUNBOOK = "docs/runbooks/saas-production-deploy.md";

test("the SaaS production runbook is an executable, fail-closed deploy and rollback procedure", async () => {
  const source = await readFile(RUNBOOK, "utf8");

  for (const heading of [
    "First deploy",
    "Routine deploy",
    "Failure decision table",
    "Rollback",
    "Observation window",
    "Public DNS go-live gate",
  ]) {
    assert.match(source, new RegExp(`^## .*${heading}`, "im"), `missing ${heading} section`);
  }

  assert.match(source, /stat -f '%Lp %N' "\$MARKIRO_ENV_FILE"/);
  assert.match(source, /stat -c '%a %n' "\$MARKIRO_ENV_FILE"/);
  assert.match(source, /mode `0600`/i);
  assert.match(source, /managed PostgreSQL backup/i);
  assert.match(source, /backup[\s\S]{0,240}fresh/i);
  assert.match(source, /object storage.*versioning/i);
  assert.match(source, /retention/i);
  assert.match(source, /stop/i);

  assert.match(source, /Approved 40-character git SHA/);
  assert.match(source, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(source, /node deploy\/production\/preflight\.mjs/);
  assert.match(source, /node deploy\/production\/deploy\.mjs/);
  assert.match(source, /node deploy\/production\/smoke\.mjs/);
  assert.match(source, /ghcr\.io\/thevladbog\/markiro-api@sha256:/);
  assert.match(source, /ghcr\.io\/thevladbog\/markiro-edge@sha256:/);

  assert.match(source, /cabinet root/i);
  assert.match(source, /auth boundary/i);
  assert.match(source, /device route/i);
  assert.match(source, /first-owner/i);
  assert.match(source, /docs\/runbooks\/cabinet-rbac-rollout\.md/);
  assert.match(source, /read -r -p 'Owner email: ' OWNER_EMAIL/);
  assert.match(source, /node dist\/cli\/provision-tenant-owner\.js/);
  assert.match(source, /--email "\$OWNER_EMAIL"/);
  assert.match(source, /--tenant-name "\$TENANT_NAME"/);
  assert.match(source, /--tenant-slug "\$TENANT_SLUG"/);
  assert.match(source, /unset OWNER_EMAIL TENANT_NAME TENANT_SLUG/);
  assert.match(source, /tenantId.*userId.*memberId.*deliveryId/is);

  for (const phase of ["Pull", "Migration", "API readiness", "Edge start", "Post-switch smoke"])
    assert.match(source, new RegExp(`\\|\\s*${phase}\\s*\\|`, "i"), `missing ${phase} failure row`);
  assert.match(source, /migration.*readiness.*smoke.*reject/is);
  assert.match(source, /backward-compatible/i);
  assert.match(source, /PREVIOUS_RELEASE_RECORD/);
  assert.match(source, /MARKIRO_IMAGE_TAG="\$PREVIOUS_TAG"/);
  assert.match(source, /docker image inspect --format '\{\{index \.RepoDigests 0\}\}'/);
  assert.match(
    source,
    /node deploy\/production\/preflight\.mjs[\s\S]*docker compose[^\n]*run --rm migrate[\s\S]*docker compose[^\n]*up -d --no-deps api[\s\S]*docker compose[^\n]*up -d --no-deps edge/,
  );
  assert.match(source, /never reverse migrations/i);
  assert.match(source, /do not hand-edit containers/i);
  assert.match(source, /do not hand-edit production rows/i);
  assert.match(source, /never.*docker compose config(?! --quiet)/i);
  assert.match(source, /secret values.*tickets.*chat/i);
  assert.match(source, /previous tag.*release record.*observation window/is);

  assert.match(source, /provider\/WAF/i);
  assert.match(source, /per-source/i);
  assert.match(source, /global anonymous-route/i);
  assert.match(source, /separately reviewed.*custom Caddy/i);
  assert.match(source, /standard Caddy.*cannot satisfy/i);
  assert.match(source, /do not.*public DNS/i);
});
