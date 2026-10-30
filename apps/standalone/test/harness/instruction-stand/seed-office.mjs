// The office instructions' part of the seed (MKR-INS-08, 09, 10): a license, so office frames
// carry no trial banner, a counterparty and a draft product. It runs after `seedOffice`.
import { createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { BROWSER_TIME, ORG } from "./site.mjs";
import { APP_DIR } from "./stand-lib.mjs";

/** The counterparty the office frames show: a distributor whose GS1 prefix it owns. */
export const COUNTERPARTY = {
  name: "ООО «Аква-Трейд»",
  inn: "7701234560",
  gln: "4607000000013",
  gs1Prefixes: ["4607000"],
};

/** A card that stays a draft: no product group and no capacities yet. */
export const DRAFT_PRODUCT = {
  gtin14: "04601234567046",
  name: "Вода питьевая «Родник» негазированная 5 л",
  printName: "Вода «Родник» негаз. 5 л",
};

async function api(shell, token, method, urlPath, body) {
  const answer = await shell.request(method, urlPath, body ?? null, token);
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`${method} ${urlPath}: ${answer.status} ${JSON.stringify(answer.body)}`);
  }
  return answer.body;
}

const DAY_MS = 86_400_000;
const LICENSE_FIXTURES = path.resolve(APP_DIR, "../../packages/domain/fixtures/standalone-license");
const base64url = (value) => Buffer.from(value).toString("base64url");

/**
 * A year's subscription for this host, signed by the domain's TEST key
 * (`test-private-keys.json`, kid `test-lic-1`). Only a host built with
 * `--features markiro-proto/test-keys` trusts it; a release build refuses it.
 */
function testLicense(hostId) {
  const keys = JSON.parse(
    readFileSync(path.join(LICENSE_FIXTURES, "test-private-keys.json"), "utf8"),
  );
  const { kid, privateJwk } = keys.license;
  const { origin } = JSON.parse(
    readFileSync(path.join(LICENSE_FIXTURES, "test-keyset.json"), "utf8"),
  ).license;
  const start = new Date(BROWSER_TIME).getTime() - DAY_MS;
  const payload = {
    version: 1,
    licenseId: "6d1f0a52-3c4b-4e8f-9a1d-000000000001",
    sequence: 1,
    issuer: origin,
    tenantId: "11111111-2222-4333-8444-555555555555",
    siteId: "66666666-7777-4888-9999-aaaaaaaaaaaa",
    hostId,
    customer: { name: ORG.name, inn: ORG.inn },
    plan: "subscription",
    planVersionId: "0b7c2d9e-1f3a-4b5c-8d6e-7f8091a2b3c4",
    entitlementRevision: "1",
    issuedAt: start,
    validFrom: start,
    validUntil: start + 365 * DAY_MS,
    graceDays: 14,
    quotas: { lines: null, stations: null, kiosks: null, cabinetUsers: null },
    features: {
      labelEditor: true,
      publicApi: true,
      pallets: true,
      chzIntegration: true,
      inventory: true,
      commerceMl: true,
      handheld: true,
      customLogo: true,
    },
    replaces: null,
  };
  const header = `{"typ":"markiro-standalone-license+jws","alg":"ES256","kid":"${kid}"}`;
  const input = `${base64url(header)}.${base64url(JSON.stringify(payload))}`;
  const key = createPrivateKey({ key: privateJwk, format: "jwk" });
  const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${signature.toString("base64url")}`;
}

/** Whether the stand's host binary trusts the test keys (`STAND_HOST_BINARY`). */
export const testKeysHost = () =>
  process.env.STAND_HOST_BINARY !== undefined && existsSync(process.env.STAND_HOST_BINARY);

export async function seedOfficeExtras({ shell, token }) {
  if (testKeysHost()) {
    const license = await api(shell, token, "GET", "/v1/office/license");
    await api(shell, token, "PUT", "/v1/office/license", {
      file: testLicense(license.binding.hostId),
    });
  }
  const counterparty = await api(shell, token, "POST", "/v1/office/counterparties", COUNTERPARTY);
  await api(shell, token, "POST", "/v1/office/products", DRAFT_PRODUCT);
  return { counterparty };
}
