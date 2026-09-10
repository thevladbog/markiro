import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import type { PrintDocumentModel } from "../../../apps/api/src/modules/billing/print-document-model.js";
import {
  commercialDocumentListItemSchema,
  offerPreviewSchema,
  offerRegistryQuerySchema,
  offerRegistrySchema,
  offerWorkspaceSchema,
  platformCapabilitiesForRole,
  platformCommercialContracts,
  tenantListItemSchema,
} from "../../../packages/platform-contracts/src/index.js";

// A separate Node process avoids Playwright's transform hook rewriting the API's
// compiled CommonJS -> domain ESM dependency boundary.
function renderPrintHtml(
  model: PrintDocumentModel,
  options?: { printVariant: "clean" | "signed" },
) {
  return execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./render-document.mjs", import.meta.url))],
    {
      input: JSON.stringify({ model, options }),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}
export const ID = "91111111-1111-4111-8111-111111111111";
export const NOW = "2026-09-10T10:00:00.000Z";
export const fingerprint = "a".repeat(64);
export const tenant = tenantListItemSchema.parse({
  id: "offers-fixture",
  name: "Молочная мастерская (тест)",
  slug: "dairy-fixture",
  createdAt: NOW,
  subscriptionStatus: "trial",
});
const names = [
  "Настройка производственной линии",
  "Обучение операторов и подключение оборудования",
  "Сопровождение запуска производства",
];
const model: PrintDocumentModel = {
  kind: "offer",
  number: "КП-ТЕСТ-0042",
  status: "published",
  issuedOrPublishedAt: new Date(NOW),
  dueOrExpiresAt: new Date("2026-10-10T20:59:59Z"),
  seller: {
    legalName: "Тестовый поставщик печатных форм",
    taxId: "234106228141",
    address: "Тестовый адрес поставщика, дом 1",
    bankName: "Тестовый банк",
    bankAccount: "40802810000000000000",
    bic: "044525000",
    correspondentAccount: "30101810000000000000",
  },
  buyer: {
    legalName: "ООО «Молочная мастерская» (синтетические данные)",
    taxId: "7700000000",
    address: "Тестовый адрес покупателя, производственный корпус 2",
  },
  lines: names.map((name, index) => ({
    position: index + 1,
    name,
    description:
      "Синтетическая строка для браузерной проверки. Условия и стоимость сохранены в предложении.",
    unit: "усл",
    quantity: 1,
    unitPrice: "6250.25",
    vatIncluded: true,
    vatRate: "20.00",
    lineTotal: "6250.25",
  })),
  subtotal: "15625.62",
  vatTotal: "3125.13",
  total: "18750.75",
  termsHtml:
    "<h2>Условия тестового предложения</h2><p>Поставка в течение четырнадцати рабочих дней после согласования. Все сведения в этом документе синтетические.</p><ul><li>Настройка и проверка каждой производственной линии.</li><li>Обучение операторов по согласованному графику.</li><li>Сопровождение запуска и передача документации.</li></ul>",
};
export const signedHtml = renderPrintHtml(model, { printVariant: "signed" });
const cleanHtml = renderPrintHtml(model, { printVariant: "clean" });
export const previewHtml = renderPrintHtml({
  ...model,
  number: "",
  status: "draft",
  issuedOrPublishedAt: null,
});
const caddy = readFileSync(
  new URL("../../../deploy/production/Caddyfile", import.meta.url),
  "utf8",
);
const policy = caddy.match(
  /\(application_csp\)\s*\{[\s\S]*?Content-Security-Policy "([^"]+)"/,
)?.[1];
if (!policy) throw new Error("Production application CSP not found");
export const productionCsp = policy;

function party(fullName: string, inn: string) {
  return {
    kind: "legal_entity",
    fullName,
    displayName: fullName,
    inn,
    kpp: null,
    ogrn: null,
    ogrnip: null,
    legalAddressRaw: "Тестовый адрес, дом 1",
    legalAddress: null,
    actualSameAsLegal: true,
    actualAddressRaw: null,
    actualAddress: null,
    postalSameAsLegal: true,
    postalAddressRaw: null,
    postalAddress: null,
    contact: null,
    revision: 1,
    confirmedAt: NOW,
  };
}
export function makeWorkspace() {
  return offerWorkspaceSchema.parse({
    offer: {
      id: ID,
      tenantId: tenant.id,
      familyId: ID,
      revision: 2,
      previousRevisionId: null,
      number: null,
      status: "draft",
      total: model.total,
      expiresAt: "2026-10-10T20:59:59.000Z",
      termsMarkdown:
        "## Условия тестового предложения\n\nПоставка в течение четырнадцати рабочих дней после согласования. Все сведения синтетические.",
      publishedAt: null,
      publishedByPlatformUserId: null,
      paidAt: null,
      createdByPlatformUserId: "fixture-admin",
      createdAt: NOW,
      updatedAt: NOW,
      lines: names.map((nameRu, index) => ({
        id: `a111111${index}-1111-4111-8111-111111111111`,
        tenantId: tenant.id,
        offerId: ID,
        position: index + 1,
        kind: "service",
        catalogVersionId: null,
        nameRu,
        nameEn: [
          "Production line setup",
          "Operator training and equipment connection",
          "Production launch support",
        ][index],
        descriptionRu: "Синтетические данные для проверки",
        descriptionEn: "Synthetic browser verification data",
        quantity: 1,
        unit: "усл",
        catalogUnitPrice: null,
        agreedUnitPrice: "6250.25",
        vatRate: "20.00",
        vatIncluded: true,
        priceOverrideReason: null,
        lineTotal: "6250.25",
        activationPolicy: null,
        createdAt: NOW,
      })),
    },
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    parties: {
      seller: party("Тестовый поставщик", "234106228141"),
      buyer: party("ООО «Молочная мастерская» (тест)", "7700000000"),
      sellerBankAccount: null,
      buyerBankAccount: null,
    },
    revisions: [],
    decision: null,
    documents: [],
    request: null,
    actions: {
      publish: true,
      cancel: false,
      revise: false,
      pay: false,
      createInvoice: false,
      addSignedVariant: false,
    },
  });
}
function document(variant: "clean" | "signed", format: "html" | "pdf", ready: boolean) {
  const html = variant === "signed" ? signedHtml : cleanHtml;
  return commercialDocumentListItemSchema.parse({
    id: `${variant === "clean" ? "b" : "c"}${format === "html" ? "1" : "2"}111111-1111-4111-8111-111111111111`,
    revision: 2,
    format,
    printVariant: variant,
    status: ready ? "ready" : "failed",
    contentType: ready ? "text/html" : null,
    byteSize: ready ? Buffer.byteLength(html) : null,
    sha256: ready ? createHash("sha256").update(html).digest("hex") : null,
    errorCode: ready ? null : "synthetic_pdf_failure",
    createdAt: NOW,
    updatedAt: NOW,
  });
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export const test = base.extend<{ fixture: ReturnType<typeof makeFixture> }>({
  fixture: async ({ context, baseURL }, use) => {
    const fixture = makeFixture();
    const origin = new URL(baseURL!).origin;
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        fixture.unhandled.push(request.url());
        await route.abort();
        return;
      }
      if (url.pathname === "/synthetic-offer-signed.html") {
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          headers: { "Content-Security-Policy": productionCsp },
          body: signedHtml,
        });
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        if (request.isNavigationRequest()) {
          const response = await route.fetch();
          await route.fulfill({
            response,
            headers: { ...response.headers(), "Content-Security-Policy": productionCsp },
          });
        } else await route.continue();
        return;
      }
      const method = request.method();
      fixture.calls.push({ url, method, body: request.postDataJSON() as unknown });
      let json: unknown;
      if (url.pathname === "/api/platform-auth/get-session" && method === "GET")
        json = {
          session: { id: "fixture-session", expiresAt: "2027-01-01T00:00:00Z" },
          user: {
            id: "fixture-admin",
            email: "fixture@example.invalid",
            name: "Fixture",
            twoFactorEnabled: true,
          },
        };
      else if (url.pathname === "/api/platform/me" && method === "GET")
        json = {
          userId: "fixture-admin",
          role: "platform_admin",
          capabilities: platformCapabilitiesForRole.platform_admin,
          twoFactorReady: true,
        };
      else if (url.pathname === "/api/platform/tenants" && method === "GET")
        json = { items: [tenant], page: 1, limit: 100, total: 1 };
      else if (url.pathname === "/api/platform/offers/registry" && method === "GET") {
        const query = offerRegistryQuerySchema.parse(Object.fromEntries(url.searchParams));
        const { lines, ...offer } = fixture.workspace.offer;
        const draftRow = {
          ...offer,
          tenantName: tenant.name,
          tenantSlug: tenant.slug,
          buyerLegalName: model.buyer.legalName,
          buyerTaxId: model.buyer.taxId,
          lineSummary: names,
          lineCount: lines.length,
        };
        const gallery = !query.search && !query.status && !query.tenantId;
        const galleryRows = [
          draftRow,
          ...(["published", "paid", "expired"] as const).map((status, index) => ({
            ...draftRow,
            id: `d111111${index}-1111-4111-8111-111111111111`,
            status,
            number: `КП-ТЕСТ-00${41 - index}`,
            revision: index + 1,
            total: ["42080.00", "95750.40", "8600.00"][index],
            tenantName: [
              "Сыроварня «Луга» (тест)",
              "Пекарня «Ржаной край» (тест)",
              "Ферма «Лесная» (тест)",
            ][index],
            tenantSlug: ["luga-fixture", "bakery-fixture", "farm-fixture"][index],
            buyerLegalName:
              index === 2 ? null : ["ООО «Луга» (тест)", "ИП Тестовый покупатель"][index],
            buyerTaxId: index === 2 ? null : "7700000000",
            lineSummary: [
              ["Подписка на платформу", "Подключение станции"],
              ["Настройка прослеживаемости"],
              ["Техническое сопровождение"],
            ][index],
            lineCount: index === 0 ? 5 : 1,
            publishedAt: NOW,
            publishedByPlatformUserId: "fixture-admin",
            paidAt: status === "paid" ? NOW : null,
          })),
        ];
        json = offerRegistrySchema.parse({
          items: query.search === "missing" ? [] : gallery ? galleryRows : [draftRow],
          page: query.page,
          limit: query.limit,
          total: query.search === "missing" ? 0 : gallery ? galleryRows.length : 68,
        });
      } else if (url.pathname === `/api/platform/offers/${ID}/workspace` && method === "GET")
        json = offerWorkspaceSchema.parse(fixture.workspace);
      else if (url.pathname === `/api/platform/offers/${ID}/preview` && method === "GET") {
        await fixture.preview.promise;
        json = offerPreviewSchema.parse({ html: previewHtml, fingerprint });
      } else if (url.pathname === `/api/platform/offers/${ID}/publish` && method === "POST") {
        platformCommercialContracts.offers.publish.body.parse(request.postDataJSON());
        await fixture.publish.promise;
        fixture.workspace.offer = {
          ...fixture.workspace.offer,
          status: "published",
          number: model.number,
          publishedAt: NOW,
          publishedByPlatformUserId: "fixture-admin",
          paidAt: null,
        };
        fixture.workspace.actions = {
          ...fixture.workspace.actions,
          publish: false,
          addSignedVariant: true,
        };
        fixture.workspace.documents = [document("clean", "html", true)];
        json = platformCommercialContracts.offers.publish.response.parse({
          ...fixture.workspace.offer,
          documents: { revision: 2, documents: [] },
        });
      } else if (url.pathname === `/api/platform/offers/${ID}/documents` && method === "POST") {
        const body = platformCommercialContracts.offers.documents.render.body.parse(
          request.postDataJSON(),
        );
        expect(body).toEqual({ printVariant: "signed" });
        fixture.workspace.documents = [
          document("clean", "html", true),
          document("signed", "html", true),
          document("signed", "pdf", false),
        ];
        json = platformCommercialContracts.offers.documents.render.response.parse({
          revision: 2,
          documents: fixture.workspace.documents.map(
            ({ createdAt: _created, updatedAt: _updated, ...item }) => item,
          ),
        });
      } else if (url.pathname === `/api/platform/offers/${ID}/documents` && method === "GET")
        json = platformCommercialContracts.offers.documents.list.response.parse(
          fixture.workspace.documents,
        );
      else if (
        url.pathname ===
          `/api/platform/offers/${ID}/documents/c1111111-1111-4111-8111-111111111111/download` &&
        method === "GET"
      ) {
        await fixture.download.promise;
        json = platformCommercialContracts.offers.documents.download.response.parse({
          url: `${origin}/synthetic-offer-signed.html`,
        });
      } else {
        fixture.unhandled.push(`${method} ${url.pathname}`);
        await route.abort();
        return;
      }
      await route.fulfill({ json, headers: { "Cache-Control": "no-store" } });
    });
    await use(fixture);
    fixture.preview.release();
    fixture.publish.release();
    fixture.download.release();
    expect(fixture.unhandled, "Every API/external request must be explicitly intercepted").toEqual(
      [],
    );
  },
});
function makeFixture() {
  return {
    workspace: makeWorkspace(),
    calls: [] as Array<{ url: URL; method: string; body: unknown }>,
    unhandled: [] as string[],
    preview: gate(),
    publish: gate(),
    download: gate(),
  };
}
export { expect };
