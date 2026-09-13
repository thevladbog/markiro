import { buildDuplicateLabelTemplate, productLabelValueDigest } from "@markiro/domain";
import type { Plugin } from "vite";
import type { ShiftDto } from "../../src/pages/shifts/api.js";
import type { ProductDto } from "../../src/pages/catalog/api.js";

const productId = "11111111-1111-4111-8111-111111111111";
const currentId = "22222222-2222-4222-8222-222222222222";
const sourceId = "77777777-7777-4777-8777-777777777777";
const plannedId = "88888888-8888-4888-8888-888888888888";
const templateId = "33333333-3333-4333-8333-333333333333";
const template = { id: templateId, name: "Дубликат 58×40", spec: buildDuplicateLabelTemplate() };
const product: ProductDto = {
  id: productId,
  gtin14: "04600000000015",
  name: "Кега светлого пива, 30 л",
  productGroup: null,
  chzProductGroupCode: 15,
  boxCapacity: null,
  palletBoxCapacity: null,
  unitPrice: null,
  printName: null,
  egaisCode: null,
  shelfLifeDays: 30,
  externalRef: null,
  status: "active",
  archived: false,
  defaultCounterpartyId: null,
  createdAt: "2026-09-12T09:00:00.000Z",
};
const current: ShiftDto = {
  id: currentId,
  number: "SEP26-012",
  status: "active",
  mode: "validation",
  productId,
  productName: product.name,
  lineId: null,
  lineName: null,
  counterpartyId: null,
  counterpartyName: null,
  ssccIssuerCounterpartyId: null,
  boxLabelTemplateId: null,
  palletLabelTemplateId: null,
  plannedQty: 120,
  plannedDate: "2026-09-12",
  productionDate: "2026-09-12",
  boxCapacity: null,
  palletBoxCapacity: null,
  palletsEnabled: false,
  createdFrom: "admin",
  openedAt: "2026-09-12T10:00:00.000Z",
  closedAt: null,
  lateDataAt: null,
  closeReason: null,
  createdAt: "2026-09-12T09:00:00.000Z",
  validationPrint: {
    mode: "duplicate_dm",
    verification: "required",
    allowPreviouslyAcceptedCodes: true,
    templateId,
    snapshot: { ...template, digest: productLabelValueDigest(template) },
    policyRevision: "66666666-6666-4666-8666-666666666666",
  },
  output: { mode: "validation", acceptedUnits: 3, firstAcceptedUnits: 2, reprocessedUnits: 1 },
};
const source: ShiftDto = {
  ...current,
  id: sourceId,
  number: "SEP26-007",
  status: "closed",
  plannedDate: "2026-09-10",
  productionDate: "2026-09-10",
  closedAt: "2026-09-10T18:00:00.000Z",
  validationPrint: {
    mode: "none",
    verification: "none",
    templateId: null,
    snapshot: null,
    policyRevision: null,
  },
  output: { mode: "validation", acceptedUnits: 10 },
};
const planned: ShiftDto = {
  ...current,
  id: plannedId,
  number: "SEP26-013",
  status: "planned",
  openedAt: null,
  output: { mode: "validation", acceptedUnits: 0, firstAcceptedUnits: 0, reprocessedUnits: 0 },
};

/** Opt-in local evidence only. Requests without the harness fixture query retain normal behavior. */
export function validationReprocessingFixture(): Plugin {
  return {
    name: "validation-reprocessing-browser-fixture",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const referer = new URL(request.headers.referer ?? "/", "http://localhost");
        if (
          referer.pathname !== "/test/browser/product-labels.html" ||
          referer.searchParams.get("fixture") !== "validation-reprocessing" ||
          !request.url?.startsWith("/api/")
        ) {
          next();
          return;
        }
        const path = new URL(request.url, "http://localhost").pathname;
        let status = 200;
        let body: unknown;
        if ((request.method ?? "GET") !== "GET") {
          // A concrete save can be reviewed in the form; fixture never writes to an API/database.
          status = 409;
          body = { message: "Тестовый просмотр: сохранение отключено" };
        } else if (path === "/api/profile")
          body = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
        else if (path === "/api/access/me")
          body = { roles: ["manager"], capabilities: ["operations.read", "operations.write"] };
        else if (path === "/api/products") body = { items: [product] };
        else if (
          [
            "/api/pickup-orders",
            "/api/lines",
            "/api/counterparties",
            "/api/label-templates",
          ].includes(path)
        )
          body = { items: [] };
        else if (path === "/api/shifts/planning-config")
          body = {
            defaultBoxLabelTemplateId: null,
            defaultSource: null,
            validationPrintProtocol: "validation-dm-duplicate-v1",
            ...(referer.searchParams.get("api") === "legacy"
              ? {}
              : { validationReprocessingProtocol: "validation-reprocessing-v1" }),
          };
        else if (path === "/api/shifts/product-label-templates")
          body = {
            items: [{ id: templateId, name: template.name, widthMm: 58, heightMm: 40, dpi: 203 }],
          };
        else if (path === "/api/shifts") body = { items: [current, planned, source] };
        else if (path.endsWith("/summary"))
          body = {
            generatedAt: current.openedAt,
            output: path.includes(sourceId)
              ? source.output
              : path.includes(plannedId)
                ? planned.output
                : current.output,
            participants: [],
            unattributed: { eventCount: 0, acceptedScans: 0, closedBoxes: 0 },
          };
        else if (path === `/api/shifts/${currentId}/reprocessings`) {
          status = referer.searchParams.get("report") === "error" ? 503 : 200;
          body = {
            items: [
              {
                codeHash: "a".repeat(64),
                canonicalRaw:
                  "010460000000001521FULL-SERIAL-REPROCESSING-42\u001d91ABCD\u001d92ThisIsTheFullCryptographicTail/+==DoNotTruncate0123456789ABCDEFGHIJKLMN",
                sourceShift: {
                  id: sourceId,
                  number: source.number,
                  productName: product.name,
                  date: source.productionDate,
                },
                occurrence: {
                  shiftId: currentId,
                  deviceId: "44444444-4444-4444-8444-444444444444",
                  operatorId: null,
                  scannedAt: "2026-09-12T10:15:00.000Z",
                },
              },
            ],
            nextCursor: null,
          };
        } else if (path.endsWith("/product-labels"))
          body = {
            summary: {
              sentAttempts: 4,
              verifiedAttempts: 3,
              unresolvedJobs: 0,
              reprintAttempts: 1,
            },
            items: [1, 2, 3].map((n) => ({
              jobId: `55555555-5555-4555-8555-55555555555${n}`,
              deviceId: "44444444-4444-4444-8444-444444444444",
              codeSuffix: n === 3 ? "ING-42" : `FIRST${n}`,
              acceptedAt: "2026-09-12T10:15:00.000Z",
              status: "completed",
              verificationOutcome: "verified",
              attemptNo: n === 3 ? 2 : 1,
              ownershipConflict: false,
            })),
            nextCursor: null,
          };
        else if (path === "/api/shift-exports/formats" || path.endsWith("/exports")) body = [];
        else {
          status = 404;
          body = { message: `No local fixture for ${path}` };
        }
        response.statusCode = status;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(body));
      });
    },
  };
}
