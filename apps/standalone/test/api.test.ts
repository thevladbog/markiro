import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { CODE_CHECK_TIMEOUT_MS, createHostApi, type HostApi } from "../src/host/api.js";
import { knownBlocksRequestSchema } from "../src/host/backups.js";
import {
  exportFileBeginSchema,
  exportFileChunkPutSchema,
  exportSettingsUpdateSchema,
} from "../src/host/export-files.js";
import {
  disaggregationCreateSchema,
  disaggregationExportRecordSchema,
  disaggregationLinesAddSchema,
  disaggregationReasonCreateSchema,
  disaggregationReasonUpdateSchema,
  disaggregationUpdateSchema,
} from "../src/host/disaggregation.js";
import {
  createTauriHostClient,
  HostError,
  type HostClient,
  type HttpMethod,
} from "../src/host/client.js";
import {
  badgeCreateSchema,
  bootstrapRequestSchema,
  counterpartyCreateSchema,
  counterpartyUpdateSchema,
  employeeCreateSchema,
  employeeUpdateSchema,
  deviceShiftCreateSchema,
  deviceUpdateSchema,
  factBatchSchema,
  labelTemplateSchema,
  lineUpdateSchema,
  officeOperatorSchema,
  officeProductSchema,
  operatorCreateSchema,
  operatorUpdateSchema,
  orgLogoPutSchema,
  productPhotoPutSchema,
  palletSheetCreateSchema,
  palletSheetDefaultUpdateSchema,
  palletSheetUpdateSchema,
  orgProfileUpdateSchema,
  pairingCodeRequestSchema,
  productCreateSchema,
  productUpdateSchema,
  shiftCloseSchema,
  shiftCreateSchema,
  shiftEnterSchema,
  shiftExportRecordSchema,
  shiftUpdateSchema,
  ssccBlockRequestSchema,
  templateCreateSchema,
  templateDefaultsUpdateSchema,
  templateUpdateSchema,
  updateStartedSchema,
} from "../src/host/protocol.js";
import { licenseLoad } from "../src/host/requests.js";
import { fakeHostApi } from "./support/office.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

interface Sent {
  method: HttpMethod;
  path: string;
  body: unknown;
  officeToken: string | undefined;
  /** Only the code check limits its request. */
  timeoutMs?: number;
}

/** A client that records the request and answers `answer`, parsed by the caller's schema. */
function recording(answer: unknown) {
  const sent: Sent[] = [];
  const client: HostClient = {
    request: async (method, path, options) => {
      sent.push({
        method,
        path,
        body: options.body,
        officeToken: options.officeToken,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      return options.schema.parse(answer);
    },
  };
  return { api: createHostApi(client), sent };
}

const TOKEN = "office-session-token";
const USER_ID = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const ORG_UPDATE = orgProfileUpdateSchema.parse(fixture("org-profile-update.json"));
const LOGO_PUT = orgLogoPutSchema.parse(fixture("org-logo-put.json"));
const PHOTO_PUT = productPhotoPutSchema.parse(fixture("product-photo-put.json"));
const SHEET_ID = "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b";
const SHEET_CREATE = palletSheetCreateSchema.parse(fixture("pallet-sheet-create.json"));
const SHEET_UPDATE = palletSheetUpdateSchema.parse(fixture("pallet-sheet-update.json"));
const SHEET_DEFAULT = palletSheetDefaultUpdateSchema.parse(
  fixture("pallet-sheet-default-update.json"),
);
const COUNTERPARTY_ID = "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e";
const LINE_ID = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const DEVICE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const COUNTERPARTY_CREATE = counterpartyCreateSchema.parse(fixture("counterparty-create.json"));
const COUNTERPARTY_UPDATE = counterpartyUpdateSchema.parse(fixture("counterparty-update.json"));
const EMPLOYEE_ID = "4f6a8c2e-1b3d-4e5f-8a7b-9c0d1e2f3a4b";
const EMPLOYEE_CREATE = employeeCreateSchema.parse(fixture("employee-create.json"));
const EMPLOYEE_UPDATE = employeeUpdateSchema.parse(fixture("employee-update.json"));
const LINE_UPDATE = lineUpdateSchema.parse(fixture("line-update.json"));
const DEVICE_UPDATE = deviceUpdateSchema.parse(fixture("device-update.json"));
const PAIRING_CODE_REQUEST = pairingCodeRequestSchema.parse(fixture("pairing-code-request.json"));
const OPERATOR = officeOperatorSchema.parse(fixture("office-operator.json"));
const OPERATOR_CREATE = operatorCreateSchema.parse(fixture("operator-create.json"));
const OPERATOR_UPDATE = operatorUpdateSchema.parse(fixture("operator-update.json"));
const BADGE_CREATE = badgeCreateSchema.parse(fixture("badge-create.json"));
const BADGE_ID = "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
const PRODUCT = officeProductSchema.parse(fixture("office-product.json"));
const PRODUCT_CREATE = productCreateSchema.parse(fixture("product-create.json"));
const PRODUCT_UPDATE = productUpdateSchema.parse(fixture("product-update.json"));
const TEMPLATE = labelTemplateSchema.parse(fixture("label-template.json"));
const TEMPLATE_CREATE = templateCreateSchema.parse(fixture("template-create.json"));
const TEMPLATE_UPDATE = templateUpdateSchema.parse(fixture("template-update.json"));
const DEFAULTS_UPDATE = templateDefaultsUpdateSchema.parse(
  fixture("template-defaults-update.json"),
);
const SHIFT_ID = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b";
const BOX_ID = "b0000000-0000-4000-8000-000000000001";
const SHIFT_CREATE = shiftCreateSchema.parse(fixture("shift-create.json"));
const SHIFT_UPDATE = shiftUpdateSchema.parse(fixture("shift-update.json"));
const SHIFT_CLOSE = shiftCloseSchema.parse(fixture("shift-close.json"));
const EXPORT_RECORD = shiftExportRecordSchema.parse(fixture("shift-export-record.json"));
const UPDATE_STARTED = updateStartedSchema.parse(fixture("update-started.json"));
const DOCUMENT_ID = "6a1f3c5e-7b9d-4e2f-8a4c-1d3e5f7a9b0c";
const DISAGGREGATION_EXPORT_RECORD = disaggregationExportRecordSchema.parse(
  fixture("disaggregation-export-record.json"),
);
const EXPORT_FILE_BEGIN = exportFileBeginSchema.parse(fixture("export-file-begin.json"));
const EXPORT_FILE_CHUNK_PUT = exportFileChunkPutSchema.parse(fixture("export-file-chunk-put.json"));
const EXPORT_SETTINGS_UPDATE = exportSettingsUpdateSchema.parse(
  fixture("export-settings-update.json"),
);
const EXPORT_FILE_ID = "7a1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8";
const REASON_ID = "d15a0000-0000-4000-8000-000000000003";
const DOCUMENT_LINE_ID = "c0000000-0000-4000-8000-000000000004";
const REASON_CREATE = disaggregationReasonCreateSchema.parse(
  fixture("disaggregation-reason-create.json"),
);
const REASON_UPDATE = disaggregationReasonUpdateSchema.parse(
  fixture("disaggregation-reason-update.json"),
);
const DOCUMENT_CREATE = disaggregationCreateSchema.parse(fixture("disaggregation-create.json"));
const DOCUMENT_UPDATE = disaggregationUpdateSchema.parse(fixture("disaggregation-update.json"));
const LINES_ADD = disaggregationLinesAddSchema.parse(fixture("disaggregation-lines-add.json"));

type Case = [
  name: string,
  answer: unknown,
  run: (api: HostApi) => Promise<unknown>,
  expected: Omit<Sent, "officeToken">,
];

const CASES: Case[] = [
  [
    "officeMe",
    fixture("office-user.json"),
    (api) => api.officeMe(TOKEN),
    { method: "GET", path: "/v1/office/me", body: undefined },
  ],
  [
    "getOrg",
    fixture("org-profile.json"),
    (api) => api.getOrg(TOKEN),
    { method: "GET", path: "/v1/office/org", body: undefined },
  ],
  [
    "updateOrg",
    fixture("org-profile.json"),
    (api) => api.updateOrg(TOKEN, ORG_UPDATE),
    { method: "PUT", path: "/v1/office/org", body: ORG_UPDATE },
  ],
  [
    "getOrgLogo",
    fixture("org-logo.json"),
    (api) => api.getOrgLogo(TOKEN),
    { method: "GET", path: "/v1/office/org/logo", body: undefined },
  ],
  [
    "putOrgLogo",
    fixture("org-logo.json"),
    (api) => api.putOrgLogo(TOKEN, LOGO_PUT),
    { method: "PUT", path: "/v1/office/org/logo", body: LOGO_PUT },
  ],
  [
    "deleteOrgLogo",
    { logo: null },
    (api) => api.deleteOrgLogo(TOKEN),
    { method: "DELETE", path: "/v1/office/org/logo", body: undefined },
  ],
  [
    "getProductPhoto",
    fixture("product-photo-state.json"),
    (api) => api.getProductPhoto(TOKEN, PRODUCT.id),
    { method: "GET", path: `/v1/office/products/${PRODUCT.id}/photo`, body: undefined },
  ],
  [
    "putProductPhoto",
    fixture("product-photo-state.json"),
    (api) => api.putProductPhoto(TOKEN, PRODUCT.id, PHOTO_PUT),
    { method: "PUT", path: `/v1/office/products/${PRODUCT.id}/photo`, body: PHOTO_PUT },
  ],
  [
    "deleteProductPhoto",
    { photo: null },
    (api) => api.deleteProductPhoto(TOKEN, PRODUCT.id),
    { method: "DELETE", path: `/v1/office/products/${PRODUCT.id}/photo`, body: undefined },
  ],
  [
    "listPalletSheets",
    fixture("pallet-sheets.json"),
    (api) => api.listPalletSheets(TOKEN),
    { method: "GET", path: "/v1/office/pallet-sheets", body: undefined },
  ],
  [
    "createPalletSheet",
    fixture("pallet-sheet.json"),
    (api) => api.createPalletSheet(TOKEN, SHEET_CREATE),
    { method: "POST", path: "/v1/office/pallet-sheets", body: SHEET_CREATE },
  ],
  [
    "updatePalletSheet",
    fixture("pallet-sheet.json"),
    (api) => api.updatePalletSheet(TOKEN, SHEET_ID, SHEET_UPDATE),
    { method: "PUT", path: `/v1/office/pallet-sheets/${SHEET_ID}`, body: SHEET_UPDATE },
  ],
  [
    "deletePalletSheet",
    null,
    (api) => api.deletePalletSheet(TOKEN, SHEET_ID),
    { method: "DELETE", path: `/v1/office/pallet-sheets/${SHEET_ID}`, body: undefined },
  ],
  [
    "setDefaultPalletSheet",
    fixture("pallet-sheets.json"),
    (api) => api.setDefaultPalletSheet(TOKEN, SHEET_DEFAULT),
    { method: "PUT", path: "/v1/office/pallet-sheet-default", body: SHEET_DEFAULT },
  ],
  [
    "getSscc",
    fixture("sscc-state.json"),
    (api) => api.getSscc(TOKEN),
    { method: "GET", path: "/v1/office/sscc", body: undefined },
  ],
  [
    "updateSsccCounter",
    { issuerPrefix: "460068200", extension: 1, nextSerial: 50, maxSerial: 9999999, rev: 7 },
    (api) =>
      api.updateSsccCounter(
        TOKEN,
        { issuerPrefix: "460068200", extension: 1 },
        { nextSerial: 50, expectedRev: 1 },
      ),
    {
      method: "PUT",
      path: "/v1/office/sscc/counters/460068200/1",
      body: { nextSerial: 50, expectedRev: 1 },
    },
  ],
  [
    "updateBlockSizes",
    fixture("sscc-state.json"),
    (api) =>
      api.updateBlockSizes(TOKEN, { boxBlockSize: 1000, palletBlockSize: 100, expectedRev: 1 }),
    {
      method: "PUT",
      path: "/v1/office/sscc/block-sizes",
      body: { boxBlockSize: 1000, palletBlockSize: 100, expectedRev: 1 },
    },
  ],
  [
    "listUsers",
    [fixture("office-user-record.json")],
    (api) => api.listUsers(TOKEN),
    { method: "GET", path: "/v1/office/users", body: undefined },
  ],
  [
    "createUser",
    fixture("office-user-record.json"),
    (api) =>
      api.createUser(TOKEN, {
        login: "tech",
        name: "Павел Орлов",
        role: "technologist",
        password: "technologist password",
      }),
    {
      method: "POST",
      path: "/v1/office/users",
      body: {
        login: "tech",
        name: "Павел Орлов",
        role: "technologist",
        password: "technologist password",
      },
    },
  ],
  [
    "updateUser",
    fixture("office-user-record.json"),
    (api) =>
      api.updateUser(TOKEN, USER_ID, {
        name: "Павел Орлов",
        role: "technologist",
        active: false,
        expectedRev: 3,
      }),
    {
      method: "PUT",
      path: `/v1/office/users/${USER_ID}`,
      body: { name: "Павел Орлов", role: "technologist", active: false, expectedRev: 3 },
    },
  ],
  [
    "listDevices",
    [fixture("device-record.json")],
    (api) => api.listDevices(TOKEN),
    { method: "GET", path: "/v1/office/devices", body: undefined },
  ],
  [
    "createPairingCode",
    fixture("pairing-code.json"),
    (api) => api.createPairingCode(TOKEN),
    { method: "POST", path: "/v1/office/pairing-codes", body: undefined },
  ],
  [
    "createPairingCode replacing the code on screen",
    fixture("pairing-code.json"),
    (api) => api.createPairingCode(TOKEN, PAIRING_CODE_REQUEST),
    { method: "POST", path: "/v1/office/pairing-codes", body: PAIRING_CODE_REQUEST },
  ],
  [
    "updateDevice",
    fixture("device-record.json"),
    (api) => api.updateDevice(TOKEN, DEVICE_ID, DEVICE_UPDATE),
    { method: "PUT", path: `/v1/office/devices/${DEVICE_ID}`, body: DEVICE_UPDATE },
  ],
  [
    "revokeDevice",
    fixture("device-record.json"),
    (api) => api.revokeDevice(TOKEN, DEVICE_ID),
    { method: "POST", path: `/v1/office/devices/${DEVICE_ID}/revoke`, body: undefined },
  ],
  [
    "listCounterparties",
    [fixture("counterparty-record.json")],
    (api) => api.listCounterparties(TOKEN),
    { method: "GET", path: "/v1/office/counterparties", body: undefined },
  ],
  [
    "createCounterparty",
    fixture("counterparty-record.json"),
    (api) => api.createCounterparty(TOKEN, COUNTERPARTY_CREATE),
    { method: "POST", path: "/v1/office/counterparties", body: COUNTERPARTY_CREATE },
  ],
  [
    "updateCounterparty",
    fixture("counterparty-record.json"),
    (api) => api.updateCounterparty(TOKEN, COUNTERPARTY_ID, COUNTERPARTY_UPDATE),
    {
      method: "PUT",
      path: `/v1/office/counterparties/${COUNTERPARTY_ID}`,
      body: COUNTERPARTY_UPDATE,
    },
  ],
  [
    "listEmployees",
    [fixture("employee-record.json")],
    (api) => api.listEmployees(TOKEN),
    { method: "GET", path: "/v1/office/employees", body: undefined },
  ],
  [
    "createEmployee",
    fixture("employee-record.json"),
    (api) => api.createEmployee(TOKEN, EMPLOYEE_CREATE),
    { method: "POST", path: "/v1/office/employees", body: EMPLOYEE_CREATE },
  ],
  [
    "updateEmployee",
    fixture("employee-record.json"),
    (api) => api.updateEmployee(TOKEN, EMPLOYEE_ID, EMPLOYEE_UPDATE),
    { method: "PUT", path: `/v1/office/employees/${EMPLOYEE_ID}`, body: EMPLOYEE_UPDATE },
  ],
  [
    "listLines",
    [fixture("office-line.json")],
    (api) => api.listLines(TOKEN),
    { method: "GET", path: "/v1/office/lines", body: undefined },
  ],
  [
    "createLine",
    fixture("office-line.json"),
    (api) => api.createLine(TOKEN, { name: "Линия 3" }),
    { method: "POST", path: "/v1/office/lines", body: { name: "Линия 3" } },
  ],
  [
    "updateLine",
    fixture("office-line.json"),
    (api) => api.updateLine(TOKEN, LINE_ID, LINE_UPDATE),
    { method: "PUT", path: `/v1/office/lines/${LINE_ID}`, body: LINE_UPDATE },
  ],
  [
    "listOperators",
    [fixture("office-operator.json")],
    (api) => api.listOperators(TOKEN),
    { method: "GET", path: "/v1/office/operators", body: undefined },
  ],
  [
    "createOperator",
    fixture("office-operator.json"),
    (api) => api.createOperator(TOKEN, OPERATOR_CREATE),
    { method: "POST", path: "/v1/office/operators", body: OPERATOR_CREATE },
  ],
  [
    "updateOperator",
    fixture("office-operator.json"),
    (api) => api.updateOperator(TOKEN, OPERATOR.id, OPERATOR_UPDATE),
    { method: "PUT", path: `/v1/office/operators/${OPERATOR.id}`, body: OPERATOR_UPDATE },
  ],
  [
    "createBadge",
    OPERATOR.badges[1],
    (api) => api.createBadge(TOKEN, OPERATOR.id, BADGE_CREATE),
    { method: "POST", path: `/v1/office/operators/${OPERATOR.id}/badges`, body: BADGE_CREATE },
  ],
  [
    "revokeBadge",
    null,
    (api) => api.revokeBadge(TOKEN, OPERATOR.id, BADGE_ID),
    {
      method: "DELETE",
      path: `/v1/office/operators/${OPERATOR.id}/badges/${BADGE_ID}`,
      body: undefined,
    },
  ],
  [
    "getBadgeSalt",
    fixture("badge-salt.json"),
    (api) => api.getBadgeSalt(TOKEN),
    { method: "GET", path: "/v1/office/badge-salt", body: undefined },
  ],
  [
    "listProductGroups",
    [fixture("product-group.json")],
    (api) => api.listProductGroups(TOKEN),
    { method: "GET", path: "/v1/office/product-groups", body: undefined },
  ],
  [
    "listProducts",
    [fixture("office-product.json")],
    (api) => api.listProducts(TOKEN),
    { method: "GET", path: "/v1/office/products", body: undefined },
  ],
  [
    "createProduct",
    fixture("office-product.json"),
    (api) => api.createProduct(TOKEN, PRODUCT_CREATE),
    { method: "POST", path: "/v1/office/products", body: PRODUCT_CREATE },
  ],
  [
    "updateProduct",
    fixture("office-product.json"),
    (api) => api.updateProduct(TOKEN, PRODUCT.id, PRODUCT_UPDATE),
    { method: "PUT", path: `/v1/office/products/${PRODUCT.id}`, body: PRODUCT_UPDATE },
  ],
  [
    "listTemplates",
    [fixture("template-summary.json")],
    (api) => api.listTemplates(TOKEN),
    { method: "GET", path: "/v1/office/templates", body: undefined },
  ],
  [
    "getTemplate",
    fixture("label-template.json"),
    (api) => api.getTemplate(TOKEN, TEMPLATE.id),
    { method: "GET", path: `/v1/office/templates/${TEMPLATE.id}`, body: undefined },
  ],
  [
    "createTemplate",
    fixture("label-template.json"),
    (api) => api.createTemplate(TOKEN, TEMPLATE_CREATE),
    { method: "POST", path: "/v1/office/templates", body: TEMPLATE_CREATE },
  ],
  [
    "updateTemplate",
    fixture("label-template.json"),
    (api) => api.updateTemplate(TOKEN, TEMPLATE.id, TEMPLATE_UPDATE),
    { method: "PUT", path: `/v1/office/templates/${TEMPLATE.id}`, body: TEMPLATE_UPDATE },
  ],
  [
    "deleteTemplate",
    null,
    (api) => api.deleteTemplate(TOKEN, TEMPLATE.id),
    { method: "DELETE", path: `/v1/office/templates/${TEMPLATE.id}`, body: undefined },
  ],
  [
    "getTemplateDefaults",
    fixture("template-defaults.json"),
    (api) => api.getTemplateDefaults(TOKEN),
    { method: "GET", path: "/v1/office/template-defaults", body: undefined },
  ],
  [
    "updateTemplateDefaults",
    fixture("template-defaults.json"),
    (api) => api.updateTemplateDefaults(TOKEN, DEFAULTS_UPDATE),
    { method: "PUT", path: "/v1/office/template-defaults", body: DEFAULTS_UPDATE },
  ],
  [
    "listShifts",
    [fixture("office-shift.json")],
    (api) => api.listShifts(TOKEN),
    { method: "GET", path: "/v1/office/shifts", body: undefined },
  ],
  [
    "listShifts for a period",
    [fixture("office-shift.json")],
    (api) => api.listShifts(TOKEN, { from: "2026-09-01", to: "2026-10-08" }),
    { method: "GET", path: "/v1/office/shifts?from=2026-09-01&to=2026-10-08", body: undefined },
  ],
  [
    "getShift",
    fixture("office-shift.json"),
    (api) => api.getShift(TOKEN, SHIFT_ID),
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}`, body: undefined },
  ],
  [
    "createShift",
    fixture("office-shift.json"),
    (api) => api.createShift(TOKEN, SHIFT_CREATE),
    { method: "POST", path: "/v1/office/shifts", body: SHIFT_CREATE },
  ],
  [
    "updateShift",
    fixture("office-shift.json"),
    (api) => api.updateShift(TOKEN, SHIFT_ID, SHIFT_UPDATE),
    { method: "PUT", path: `/v1/office/shifts/${SHIFT_ID}`, body: SHIFT_UPDATE },
  ],
  [
    "deleteShift",
    null,
    (api) => api.deleteShift(TOKEN, SHIFT_ID),
    { method: "DELETE", path: `/v1/office/shifts/${SHIFT_ID}`, body: undefined },
  ],
  [
    "closeShift",
    fixture("office-shift.json"),
    (api) => api.closeShift(TOKEN, SHIFT_ID, SHIFT_CLOSE),
    { method: "POST", path: `/v1/office/shifts/${SHIFT_ID}/close`, body: SHIFT_CLOSE },
  ],
  [
    "getShiftExportSource",
    fixture("shift-export-rows.json"),
    (api) => api.getShiftExportSource(TOKEN, SHIFT_ID),
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}/export-source`, body: undefined },
  ],
  [
    "listShiftBoxes",
    fixture("office-boxes.json"),
    (api) => api.listShiftBoxes(TOKEN, SHIFT_ID),
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}/boxes`, body: undefined },
  ],
  [
    "listShiftPallets",
    fixture("office-pallets.json"),
    (api) => api.listShiftPallets(TOKEN, SHIFT_ID),
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}/pallets`, body: undefined },
  ],
  [
    "recordShiftExport",
    null,
    (api) => api.recordShiftExport(TOKEN, SHIFT_ID, EXPORT_RECORD),
    { method: "POST", path: `/v1/office/shifts/${SHIFT_ID}/exports`, body: EXPORT_RECORD },
  ],
  [
    "beginExportFile",
    fixture("export-file-progress.json"),
    (api) => api.beginExportFile(TOKEN, EXPORT_FILE_BEGIN),
    { method: "POST", path: "/v1/office/export-files", body: EXPORT_FILE_BEGIN },
  ],
  [
    "putExportFileChunk",
    fixture("export-file-progress.json"),
    (api) => api.putExportFileChunk(TOKEN, EXPORT_FILE_ID, 2, EXPORT_FILE_CHUNK_PUT.contentBase64),
    {
      method: "PUT",
      path: `/v1/office/export-files/${EXPORT_FILE_ID}/chunks/2`,
      body: EXPORT_FILE_CHUNK_PUT,
    },
  ],
  [
    "completeExportFile",
    fixture("export-file-progress.json"),
    (api) => api.completeExportFile(TOKEN, EXPORT_FILE_ID),
    {
      method: "POST",
      path: `/v1/office/export-files/${EXPORT_FILE_ID}/complete`,
      body: undefined,
    },
  ],
  [
    "listExportFiles of a shift",
    fixture("export-file-list.json"),
    (api) => api.listExportFiles(TOKEN, { shiftId: SHIFT_ID, kind: "form" }),
    {
      method: "GET",
      path: `/v1/office/export-files?shiftId=${SHIFT_ID}&kind=form`,
      body: undefined,
    },
  ],
  [
    "listExportFiles of a card",
    fixture("export-file-list.json"),
    (api) => api.listExportFiles(TOKEN, { targetType: "box", targetId: BOX_ID }),
    {
      method: "GET",
      path: `/v1/office/export-files?targetType=box&targetId=${BOX_ID}`,
      body: undefined,
    },
  ],
  [
    "openExportFileDownload",
    fixture("export-file-opened.json"),
    (api) => api.openExportFileDownload(TOKEN, EXPORT_FILE_ID),
    {
      method: "POST",
      path: `/v1/office/export-files/${EXPORT_FILE_ID}/download`,
      body: undefined,
    },
  ],
  [
    "getExportFileChunk",
    fixture("export-file-chunk.json"),
    (api) => api.getExportFileChunk(TOKEN, EXPORT_FILE_ID, 0),
    {
      method: "GET",
      path: `/v1/office/export-files/${EXPORT_FILE_ID}/chunks/0`,
      body: undefined,
    },
  ],
  [
    "getExportSettings",
    fixture("export-settings.json"),
    (api) => api.getExportSettings(TOKEN),
    { method: "GET", path: "/v1/office/export-files/settings", body: undefined },
  ],
  [
    "putExportSettings",
    fixture("export-settings.json"),
    (api) => api.putExportSettings(TOKEN, EXPORT_SETTINGS_UPDATE),
    { method: "PUT", path: "/v1/office/export-files/settings", body: EXPORT_SETTINGS_UPDATE },
  ],
  [
    "recordUpdateStarted",
    null,
    (api) => api.recordUpdateStarted(TOKEN, UPDATE_STARTED),
    { method: "POST", path: "/v1/office/updates/started", body: UPDATE_STARTED },
  ],
  [
    "getBoxReportRows",
    fixture("box-report-rows.json"),
    (api) => api.getBoxReportRows(TOKEN, BOX_ID),
    { method: "GET", path: `/v1/office/boxes/${BOX_ID}/report-data`, body: undefined },
  ],
  [
    "getPalletReportRows",
    fixture("pallet-report-rows.json"),
    (api) => api.getPalletReportRows(TOKEN, SHIFT_ID),
    {
      method: "GET",
      path: `/v1/office/shifts/${SHIFT_ID}/pallet-report-data`,
      body: undefined,
    },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
    {
      method: "PUT",
      path: `/v1/office/users/${USER_ID}/password`,
      body: { password: "a new long password" },
    },
  ],
  [
    "listDisaggregationReasons",
    [fixture("disaggregation-reason.json")],
    (api) => api.listDisaggregationReasons(TOKEN),
    { method: "GET", path: "/v1/office/disaggregation-reasons", body: undefined },
  ],
  [
    "createDisaggregationReason",
    fixture("disaggregation-reason.json"),
    (api) => api.createDisaggregationReason(TOKEN, REASON_CREATE),
    { method: "POST", path: "/v1/office/disaggregation-reasons", body: REASON_CREATE },
  ],
  [
    "updateDisaggregationReason",
    fixture("disaggregation-reason.json"),
    (api) => api.updateDisaggregationReason(TOKEN, REASON_ID, REASON_UPDATE),
    {
      method: "PUT",
      path: `/v1/office/disaggregation-reasons/${REASON_ID}`,
      body: REASON_UPDATE,
    },
  ],
  [
    "listDisaggregations",
    [fixture("disaggregation-document.json")],
    (api) => api.listDisaggregations(TOKEN),
    { method: "GET", path: "/v1/office/disaggregation", body: undefined },
  ],
  [
    "listDisaggregations with filters",
    [fixture("disaggregation-document.json")],
    (api) => api.listDisaggregations(TOKEN, { status: "applied", q: "DSG-26" }),
    { method: "GET", path: "/v1/office/disaggregation?status=applied&q=DSG-26", body: undefined },
  ],
  [
    "getDisaggregation",
    fixture("disaggregation-detail.json"),
    (api) => api.getDisaggregation(TOKEN, DOCUMENT_ID),
    { method: "GET", path: `/v1/office/disaggregation/${DOCUMENT_ID}`, body: undefined },
  ],
  [
    "createDisaggregation",
    fixture("disaggregation-detail.json"),
    (api) => api.createDisaggregation(TOKEN, DOCUMENT_CREATE),
    { method: "POST", path: "/v1/office/disaggregation", body: DOCUMENT_CREATE },
  ],
  [
    "updateDisaggregation",
    fixture("disaggregation-detail.json"),
    (api) => api.updateDisaggregation(TOKEN, DOCUMENT_ID, DOCUMENT_UPDATE),
    {
      method: "PUT",
      path: `/v1/office/disaggregation/${DOCUMENT_ID}`,
      body: DOCUMENT_UPDATE,
    },
  ],
  [
    "addDisaggregationLines",
    fixture("disaggregation-detail.json"),
    (api) => api.addDisaggregationLines(TOKEN, DOCUMENT_ID, LINES_ADD),
    {
      method: "POST",
      path: `/v1/office/disaggregation/${DOCUMENT_ID}/lines`,
      body: LINES_ADD,
    },
  ],
  [
    "deleteDisaggregationLine",
    fixture("disaggregation-detail.json"),
    (api) => api.deleteDisaggregationLine(TOKEN, DOCUMENT_ID, DOCUMENT_LINE_ID),
    {
      method: "DELETE",
      path: `/v1/office/disaggregation/${DOCUMENT_ID}/lines/${DOCUMENT_LINE_ID}`,
      body: undefined,
    },
  ],
  [
    "applyDisaggregation",
    fixture("disaggregation-detail.json"),
    (api) => api.applyDisaggregation(TOKEN, DOCUMENT_ID, { expectedRev: 41 }),
    {
      method: "POST",
      path: `/v1/office/disaggregation/${DOCUMENT_ID}/apply`,
      body: { expectedRev: 41 },
    },
  ],
  [
    "cancelDisaggregation",
    fixture("disaggregation-detail.json"),
    (api) => api.cancelDisaggregation(TOKEN, DOCUMENT_ID, { expectedRev: 41 }),
    {
      method: "POST",
      path: `/v1/office/disaggregation/${DOCUMENT_ID}/cancel`,
      body: { expectedRev: 41 },
    },
  ],
  [
    "getDisaggregationReportRows",
    fixture("disaggregation-report-rows-full.json"),
    (api) => api.getDisaggregationReportRows(TOKEN, DOCUMENT_ID, "full"),
    {
      method: "GET",
      path: `/v1/office/disaggregation/${DOCUMENT_ID}/report-data?variant=full`,
      body: undefined,
    },
  ],
  [
    "recordDisaggregationExport",
    null,
    (api) => api.recordDisaggregationExport(TOKEN, DOCUMENT_ID, DISAGGREGATION_EXPORT_RECORD),
    {
      method: "POST",
      path: `/v1/office/disaggregation/${DOCUMENT_ID}/exports`,
      body: DISAGGREGATION_EXPORT_RECORD,
    },
  ],
];

describe("HostApi office endpoints", () => {
  it.each(CASES)(
    "%s sends the office token to the right route",
    async (_name, answer, run, expected) => {
      const { api, sent } = recording(answer);
      await run(api);
      expect(sent).toEqual([{ ...expected, officeToken: TOKEN }]);
    },
  );

  it("returns the parsed answer", async () => {
    const { api } = recording(fixture("sscc-state.json"));
    await expect(api.getSscc(TOKEN)).resolves.toMatchObject({
      currentIssuerPrefix: "460068200",
      blockSizesRev: 1,
    });
  });

  it("reads the logo as the host sent it, and none as null", async () => {
    await expect(recording(fixture("org-logo.json")).api.getOrgLogo(TOKEN)).resolves.toEqual(
      fixture("org-logo.json"),
    );
    await expect(recording({ logo: null }).api.getOrgLogo(TOKEN)).resolves.toEqual({ logo: null });
  });

  it("rejects a logo answer that is not a logo or none", async () => {
    await expect(recording({}).api.getOrgLogo(TOKEN)).rejects.toThrow();
    await expect(recording({ logo: { width: 10 } }).api.getOrgLogo(TOKEN)).rejects.toThrow();
    const logo = fixture("org-logo.json") as { logo: Record<string, unknown> };
    const stale = { logo: { ...logo.logo, updatedAt: "yesterday" } };
    await expect(recording(stale).api.putOrgLogo(TOKEN, LOGO_PUT)).rejects.toThrow();
  });

  it("reads a product's photo as the host sent it, none as null, and refuses anything else (plan ТОВ)", async () => {
    await expect(
      recording(fixture("product-photo-state.json")).api.getProductPhoto(TOKEN, PRODUCT.id),
    ).resolves.toEqual(fixture("product-photo-state.json"));
    await expect(
      recording({ photo: null }).api.getProductPhoto(TOKEN, PRODUCT.id),
    ).resolves.toEqual({ photo: null });
    await expect(recording({}).api.getProductPhoto(TOKEN, PRODUCT.id)).rejects.toThrow();
    const state = fixture("product-photo-state.json") as { photo: Record<string, unknown> };
    const wrong = { photo: { ...state.photo, checksum: "ABC" } };
    await expect(
      recording(wrong).api.putProductPhoto(TOKEN, PRODUCT.id, PHOTO_PUT),
    ).rejects.toThrow();
  });

  it("rejects a sheet answer that is not a sheet, and a list without its default", async () => {
    await expect(recording({}).api.createPalletSheet(TOKEN, SHEET_CREATE)).rejects.toThrow();
    await expect(
      recording({ ...(fixture("pallet-sheet.json") as object), revision: 0 }).api.updatePalletSheet(
        TOKEN,
        SHEET_ID,
        SHEET_UPDATE,
      ),
    ).rejects.toThrow();
    await expect(recording({ sheets: [] }).api.listPalletSheets(TOKEN)).rejects.toThrow();
    await expect(
      recording({ sheets: [], defaultId: null }).api.listPalletSheets(TOKEN),
    ).resolves.toEqual({ sheets: [], defaultId: null });
  });

  it("rejects a users answer that is not a list", async () => {
    const { api } = recording(fixture("office-user-record.json"));
    await expect(api.listUsers(TOKEN)).rejects.toThrow();
  });
});

describe("HostApi shifts", () => {
  const shift = fixture("office-shift.json");
  const notAShift = { ...(shift as object), status: "open" };

  it("returns the shifts of the list and the shift of a write as the host sent them", async () => {
    await expect(recording([shift]).api.listShifts(TOKEN)).resolves.toMatchObject([
      { number: "OCT26-004", status: "active", rev: 71 },
    ]);
    await expect(recording([]).api.listShifts(TOKEN)).resolves.toEqual([]);
    const answer = recording(shift).api;
    await expect(answer.createShift(TOKEN, SHIFT_CREATE)).resolves.toMatchObject({ rev: 71 });
    await expect(answer.updateShift(TOKEN, SHIFT_ID, SHIFT_UPDATE)).resolves.toMatchObject({
      number: "OCT26-004",
    });
    await expect(answer.closeShift(TOKEN, SHIFT_ID, SHIFT_CLOSE)).resolves.toMatchObject({
      productionDate: "2026-10-08",
    });
  });

  it("rejects a list that is no list of shifts and a write whose answer is no shift", async () => {
    await expect(recording([notAShift]).api.listShifts(TOKEN)).rejects.toThrow();
    await expect(recording(shift).api.listShifts(TOKEN)).rejects.toThrow();
    const bad = recording(notAShift).api;
    await expect(bad.createShift(TOKEN, SHIFT_CREATE)).rejects.toThrow();
    await expect(bad.updateShift(TOKEN, SHIFT_ID, SHIFT_UPDATE)).rejects.toThrow();
    await expect(bad.closeShift(TOKEN, SHIFT_ID, SHIFT_CLOSE)).rejects.toThrow();
    const list = recording([shift]).api;
    await expect(list.createShift(TOKEN, SHIFT_CREATE)).rejects.toThrow();
    await expect(list.updateShift(TOKEN, SHIFT_ID, SHIFT_UPDATE)).rejects.toThrow();
    await expect(list.closeShift(TOKEN, SHIFT_ID, SHIFT_CLOSE)).rejects.toThrow();
  });

  it("returns one shift with its figures, and rejects an answer that is a list or no shift", async () => {
    await expect(recording(shift).api.getShift(TOKEN, SHIFT_ID)).resolves.toMatchObject({
      number: "OCT26-004",
      totals: { acceptedUnits: 547, unitsInClosedBoxes: 540, closedBoxes: 45, openBoxes: 1 },
    });
    await expect(recording([shift]).api.getShift(TOKEN, SHIFT_ID)).rejects.toThrow();
    await expect(recording(notAShift).api.getShift(TOKEN, SHIFT_ID)).rejects.toThrow();
    const withoutTotals = Object.fromEntries(
      Object.entries(shift as object).filter(([key]) => key !== "totals"),
    );
    await expect(recording(withoutTotals).api.getShift(TOKEN, SHIFT_ID)).rejects.toThrow();
  });

  it("resolves a recorded export with nothing, and rejects an answer that carries a body", async () => {
    await expect(
      recording(null).api.recordShiftExport(TOKEN, SHIFT_ID, EXPORT_RECORD),
    ).resolves.toBeUndefined();
    await expect(
      recording(shift).api.recordShiftExport(TOKEN, SHIFT_ID, EXPORT_RECORD),
    ).rejects.toThrow();
  });

  it("resolves a recorded update start with nothing, and rejects an answer that carries a body", async () => {
    await expect(
      recording(null).api.recordUpdateStarted(TOKEN, UPDATE_STARTED),
    ).resolves.toBeUndefined();
    await expect(recording(shift).api.recordUpdateStarted(TOKEN, UPDATE_STARTED)).rejects.toThrow();
  });

  it("resolves a delete with nothing, and rejects an answer that carries a body", async () => {
    await expect(recording(null).api.deleteShift(TOKEN, SHIFT_ID)).resolves.toBeUndefined();
    await expect(recording(shift).api.deleteShift(TOKEN, SHIFT_ID)).rejects.toThrow();
  });

  it("encodes both ends of a period in the query", async () => {
    const { api, sent } = recording([]);
    await api.listShifts(TOKEN, { from: "2026-09-01&to=x", to: "a b" });
    expect(sent.map((request) => request.path)).toEqual([
      "/v1/office/shifts?from=2026-09-01%26to%3Dx&to=a%20b",
    ]);
  });
});

describe("HostApi bootstrap", () => {
  it("forwards the stock templates of the request to the host unchanged", async () => {
    const request = bootstrapRequestSchema.parse(fixture("bootstrap-request-templates.json"));
    expect(request.templates?.length).toBeGreaterThan(0);
    const { api, sent } = recording(fixture("bootstrap-response.json"));
    await api.bootstrap(request);
    expect(sent).toEqual([
      { method: "POST", path: "/v1/bootstrap", body: request, officeToken: undefined },
    ]);
  });
});

describe("HostApi change feed", () => {
  it("reads the change feed with the device key only, no office session", async () => {
    const { api, sent } = recording(fixture("changes-response.json"));
    await expect(api.getChanges(41)).resolves.toMatchObject({ rev: 42, hasMore: false });
    expect(sent).toEqual([
      { method: "GET", path: "/v1/changes?since=41", body: undefined, officeToken: undefined },
    ]);
  });
});

describe("HostApi device shifts", () => {
  const list = fixture("device-shifts.json");
  const entered = fixture("device-shift-entered.json");
  const CREATE = deviceShiftCreateSchema.parse(fixture("device-shift-create.json"));
  const ENTER = shiftEnterSchema.parse(fixture("shift-enter.json"));

  it("reads, creates and enters shifts with the device key only, no office session", async () => {
    const reading = recording(list);
    await expect(reading.api.getDeviceShifts()).resolves.toMatchObject([
      { number: "OCT26-004", status: "active" },
      { number: "OCT26-005/S", status: "planned" },
    ]);
    const creating = recording((list as { shifts: unknown[] }).shifts[1]);
    await expect(creating.api.createDeviceShift(CREATE)).resolves.toMatchObject({
      number: "OCT26-005/S",
    });
    const entering = recording(entered);
    await expect(entering.api.enterShift(SHIFT_ID, ENTER)).resolves.toMatchObject({
      status: "active",
      snapshot: { issuerPrefix: "460068200" },
    });
    expect([...reading.sent, ...creating.sent, ...entering.sent]).toEqual([
      { method: "GET", path: "/v1/device/shifts", body: undefined, officeToken: undefined },
      { method: "POST", path: "/v1/device/shifts", body: CREATE, officeToken: undefined },
      {
        method: "POST",
        path: `/v1/device/shifts/${SHIFT_ID}/enter`,
        body: ENTER,
        officeToken: undefined,
      },
    ]);
  });

  it("rejects a list without its shifts and an entry without its snapshot", async () => {
    await expect(
      recording({ shifts: [entered, { id: 1 }] }).api.getDeviceShifts(),
    ).rejects.toThrow();
    await expect(
      recording((list as { shifts: unknown[] }).shifts).api.getDeviceShifts(),
    ).rejects.toThrow();
    const withoutSnapshot = { ...(entered as Record<string, unknown>) };
    delete withoutSnapshot["snapshot"];
    await expect(recording(withoutSnapshot).api.enterShift(SHIFT_ID, ENTER)).rejects.toThrow();
    await expect(recording(withoutSnapshot).api.createDeviceShift(CREATE)).resolves.toMatchObject({
      id: SHIFT_ID,
    });
  });

  it("reads the list as the shifts alone, in the host's order, and keeps nothing else of the answer", async () => {
    const shifts = await recording(list).api.getDeviceShifts();
    expect(shifts.map((shift) => shift.id)).toEqual(
      (list as { shifts: { id: string }[] }).shifts.map((shift) => shift.id),
    );
    await expect(recording({ shifts: [] }).api.getDeviceShifts()).resolves.toEqual([]);
  });

  /** The real client over a shell that answers `status` and `body`, with the call it made. */
  function overShell(status: number, body: unknown) {
    const call = vi.fn().mockResolvedValue({ status, body });
    return { api: createHostApi(createTauriHostClient(call)), call };
  }

  it("asks the shell for the device routes with no office token and the body the host takes", async () => {
    const reading = overShell(200, list);
    await reading.api.getDeviceShifts();
    expect(reading.call).toHaveBeenCalledWith("host_request", {
      method: "GET",
      path: "/v1/device/shifts",
      body: null,
      officeToken: null,
    });
    const creating = overShell(200, (list as { shifts: unknown[] }).shifts[1]);
    await creating.api.createDeviceShift(CREATE);
    expect(creating.call).toHaveBeenCalledWith("host_request", {
      method: "POST",
      path: "/v1/device/shifts",
      body: CREATE,
      officeToken: null,
    });
    const entering = overShell(200, entered);
    await entering.api.enterShift(SHIFT_ID, ENTER);
    expect(entering.call).toHaveBeenCalledWith("host_request", {
      method: "POST",
      path: `/v1/device/shifts/${SHIFT_ID}/enter`,
      body: ENTER,
      officeToken: null,
    });
    // The body goes as the caller names it: an entry naming nothing is `{ supports: [] }`.
    const naming = overShell(200, entered);
    await naming.api.enterShift(SHIFT_ID, { supports: [] });
    expect(naming.call).toHaveBeenCalledWith("host_request", {
      method: "POST",
      path: `/v1/device/shifts/${SHIFT_ID}/enter`,
      body: { supports: [] },
      officeToken: null,
    });
  });

  it.each([
    ["shift_busy", 409, "entering", "error-shift-busy.json"],
    ["shift_line", 409, "entering", undefined],
    ["shift_status", 409, "entering", undefined],
    ["product_inactive", 409, "creating", undefined],
    ["template_not_fit", 409, "creating", undefined],
  ] as const)(
    "lets the refusal %s through as it came, with its status and constraint",
    async (constraint, status, what, file) => {
      const body =
        file === undefined
          ? { error: { code: "conflict", message: "refused", details: { constraint } } }
          : fixture(file);
      const { api } = overShell(status, body);
      const error: unknown = await (
        what === "entering" ? api.enterShift(SHIFT_ID, ENTER) : api.createDeviceShift(CREATE)
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(HostError);
      expect(error).toMatchObject({
        kind: "api",
        code: "conflict",
        status,
        details: { constraint },
      });
    },
  );

  it("lets a refusal of the list through, and a transport failure of the shell", async () => {
    const forbidden = overShell(403, {
      error: { code: "forbidden", message: "stations only" },
    });
    await expect(forbidden.api.getDeviceShifts()).rejects.toMatchObject({
      kind: "api",
      code: "forbidden",
      status: 403,
    });
    const lost = createHostApi(createTauriHostClient(vi.fn().mockRejectedValue("unreachable")));
    await expect(lost.getDeviceShifts()).rejects.toMatchObject({
      kind: "transport",
      code: "unreachable",
    });
    await expect(lost.enterShift(SHIFT_ID, ENTER)).rejects.toMatchObject({ code: "unreachable" });
    await expect(lost.createDeviceShift(CREATE)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("is stood in for by a fake that answers no shifts and refuses the writes loudly", async () => {
    const fake = fakeHostApi();
    await expect(fake.getDeviceShifts()).resolves.toEqual([]);
    await expect(fake.createDeviceShift(CREATE)).rejects.toThrow(
      "unexpected HostApi.createDeviceShift call",
    );
    await expect(fake.enterShift(SHIFT_ID, ENTER)).rejects.toThrow(
      "unexpected HostApi.enterShift call",
    );
    // A test that stubs the list gets its own answer, not the empty one.
    const shifts = await recording(list).api.getDeviceShifts();
    const stubbed = fakeHostApi({ getDeviceShifts: vi.fn(async () => shifts) });
    await expect(stubbed.getDeviceShifts()).resolves.toBe(shifts);
    expect(stubbed.getDeviceShifts).toHaveBeenCalledTimes(1);
  });

  it("reads a host answer that fails the schema as an invalid response, not as a shift", async () => {
    const { api } = overShell(200, { shifts: [{ id: 1 }] });
    await expect(api.getDeviceShifts()).rejects.toMatchObject({
      kind: "transport",
      code: "invalid_response",
    });
  });
});

describe("HostApi floor work", () => {
  const BLOCK_REQUEST = ssccBlockRequestSchema.parse(fixture("sscc-block-request.json"));
  const RECORDS = factBatchSchema.parse(fixture("facts-request.json")).records;
  const CODE_HASH = "3f6c0f1e2d8b4a5c9e7f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f";

  it("asks for a block, checks a code within 300 ms and sends facts, with the device key only", async () => {
    const block = recording(fixture("sscc-block.json"));
    await expect(block.api.requestSsccBlock(BLOCK_REQUEST)).resolves.toEqual(
      fixture("sscc-block.json"),
    );
    const check = recording(fixture("code-check-taken.json"));
    await expect(check.api.checkCode(CODE_HASH)).resolves.toEqual(fixture("code-check-taken.json"));
    const facts = recording(fixture("facts-response.json"));
    await expect(facts.api.sendFacts(RECORDS)).resolves.toEqual(
      (fixture("facts-response.json") as { receipts: unknown[] }).receipts,
    );
    expect(CODE_CHECK_TIMEOUT_MS).toBe(300);
    expect([...block.sent, ...check.sent, ...facts.sent]).toEqual([
      {
        method: "POST",
        path: "/v1/device/sscc/blocks",
        body: BLOCK_REQUEST,
        officeToken: undefined,
      },
      {
        method: "GET",
        path: `/v1/device/codes/${CODE_HASH}`,
        body: undefined,
        officeToken: undefined,
        timeoutMs: 300,
      },
      {
        method: "POST",
        path: "/v1/device/facts",
        body: { records: RECORDS },
        officeToken: undefined,
      },
    ]);
  });

  it("looks a label up and sends the warehouse records in the body, with the device key only", async () => {
    const lookup = recording(fixture("warehouse-lookup-found-unit.json"));
    await expect(lookup.api.warehouseLookup({ sscc: "046006820000015000" })).resolves.toEqual(
      fixture("warehouse-lookup-found-unit.json"),
    );
    const records = (fixture("warehouse-records-request.json") as { records: unknown[] }).records;
    const sent = recording(fixture("warehouse-records-response.json"));
    await expect(sent.api.sendWarehouseRecords(records)).resolves.toEqual(
      (fixture("warehouse-records-response.json") as { receipts: unknown[] }).receipts,
    );
    expect([...lookup.sent, ...sent.sent]).toEqual([
      {
        method: "POST",
        path: "/v1/device/warehouse/lookup",
        body: { sscc: "046006820000015000" },
        officeToken: undefined,
      },
      {
        method: "POST",
        path: "/v1/device/warehouse/reprints",
        body: { records },
        officeToken: undefined,
      },
    ]);
  });

  it("lists the A4 sheets for a warehouse reprint, with the product named in the query and the device key only", async () => {
    const all = recording(fixture("pallet-sheets.json"));
    await expect(all.api.getDevicePalletSheets()).resolves.toEqual(fixture("pallet-sheets.json"));
    const product = "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b";
    const named = recording(fixture("pallet-sheets.json"));
    await named.api.getDevicePalletSheets(product);
    expect([...all.sent, ...named.sent]).toEqual([
      {
        method: "GET",
        path: "/v1/device/pallet-sheets",
        body: undefined,
        officeToken: undefined,
      },
      {
        method: "GET",
        path: `/v1/device/pallet-sheets?productId=${product}`,
        body: undefined,
        officeToken: undefined,
      },
    ]);
    await expect(recording({ sheets: "none" }).api.getDevicePalletSheets()).rejects.toThrow();
  });

  it("refuses a warehouse answer of another shape", async () => {
    await expect(
      recording({ status: "found" }).api.warehouseLookup({ sscc: "046006820000015000" }),
    ).rejects.toThrow();
    await expect(recording({ receipts: "none" }).api.sendWarehouseRecords([])).rejects.toThrow();
  });

  it("limits the code check's request and no other", async () => {
    const block = recording(fixture("sscc-block.json"));
    await block.api.requestSsccBlock(BLOCK_REQUEST);
    const facts = recording(fixture("facts-response.json"));
    await facts.api.sendFacts(RECORDS);
    for (const sent of [...block.sent, ...facts.sent]) {
      expect(Object.keys(sent)).not.toContain("timeoutMs");
    }
  });

  it("puts the hash into the path as one segment, whatever it holds", async () => {
    const check = recording(fixture("code-check-free.json"));
    await expect(check.api.checkCode("a/b?c")).resolves.toEqual({ status: "free" });
    expect(check.sent.map((sent) => sent.path)).toEqual(["/v1/device/codes/a%2Fb%3Fc"]);
  });

  it("sends the records exactly as the outbox kept them, unread", async () => {
    // The outbox's payloads are sent as stored: a record this build's schema
    // would reshape (a field a later build added) still goes out untouched.
    const kept = [{ id: "kept", kind: "scan", data: { later: true } }];
    const facts = recording({ receipts: [] });
    await expect(facts.api.sendFacts(kept)).resolves.toEqual([]);
    expect(facts.sent.map((sent) => sent.body)).toEqual([{ records: kept }]);
  });

  it("gives the host back the station's blocks after a restore, with the device key only", async () => {
    const request = knownBlocksRequestSchema.parse(fixture("known-blocks-request.json"));
    const known = recording(fixture("known-blocks-response.json"));
    await expect(known.api.registerKnownBlocks(request)).resolves.toEqual(
      fixture("known-blocks-response.json"),
    );
    expect(known.sent).toEqual([
      {
        method: "POST",
        path: "/v1/device/sscc/blocks/known",
        body: request,
        officeToken: undefined,
      },
    ]);
    await expect(
      recording({ results: [{ id: "x", outcome: "lost", code: null }] }).api.registerKnownBlocks(
        request,
      ),
    ).rejects.toThrow();
    await expect(fakeHostApi().registerKnownBlocks(request)).rejects.toThrow(
      "unexpected HostApi.registerKnownBlocks call",
    );
  });

  it("is stood in for by a fake that refuses the three calls loudly until a test stubs them", async () => {
    const fake = fakeHostApi();
    await expect(fake.requestSsccBlock(BLOCK_REQUEST)).rejects.toThrow(
      "unexpected HostApi.requestSsccBlock call",
    );
    await expect(fake.checkCode(CODE_HASH)).rejects.toThrow("unexpected HostApi.checkCode call");
    await expect(fake.sendFacts(RECORDS)).rejects.toThrow("unexpected HostApi.sendFacts call");
    const stubbed = fakeHostApi({ checkCode: vi.fn(async () => ({ status: "free" as const })) });
    await expect(stubbed.checkCode(CODE_HASH)).resolves.toEqual({ status: "free" });
  });

  it("rejects a block, a check or receipts in another shape", async () => {
    await expect(recording({ id: "x" }).api.requestSsccBlock(BLOCK_REQUEST)).rejects.toThrow();
    await expect(recording({ status: "maybe" }).api.checkCode(CODE_HASH)).rejects.toThrow();
    await expect(recording({ receipts: [{ id: null }] }).api.sendFacts(RECORDS)).rejects.toThrow();
  });
});

describe("the license (plan ЛЦ-2)", () => {
  it("reads, previews and loads a file, asks for the activation request and the emergency, with the session", async () => {
    const office = fixture("office-license.json");
    const load = licenseLoad("eyJ0eXAiOiJ4In0.e30.c2ln");
    const activation = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/domain/fixtures/standalone-license/activation-request.json",
          testModuleUrl,
        ),
        "utf8",
      ),
    ) as unknown;
    const read = recording(office);
    await expect(read.api.getLicense(TOKEN)).resolves.toEqual(office);
    const previewed = recording(fixture("office-license-preview.json"));
    await previewed.api.previewLicense(TOKEN, load);
    const loaded = recording(office);
    await loaded.api.loadLicense(TOKEN, load);
    const asked = recording(activation);
    await expect(asked.api.getActivationRequest(TOKEN)).resolves.toEqual(activation);
    const extended = recording(office);
    await extended.api.enableLicenseEmergency(TOKEN);
    expect([
      ...read.sent,
      ...previewed.sent,
      ...loaded.sent,
      ...asked.sent,
      ...extended.sent,
    ]).toEqual([
      { method: "GET", path: "/v1/office/license", body: undefined, officeToken: TOKEN },
      { method: "POST", path: "/v1/office/license/preview", body: load, officeToken: TOKEN },
      { method: "PUT", path: "/v1/office/license", body: load, officeToken: TOKEN },
      {
        method: "GET",
        path: "/v1/office/license/activation-request",
        body: undefined,
        officeToken: TOKEN,
      },
      { method: "POST", path: "/v1/office/license/emergency", body: undefined, officeToken: TOKEN },
    ]);
  });
});

describe("the station's own record (plan ЛЦ-3)", () => {
  it("reads GET /v1/device with the device key only, the site's license with it", async () => {
    const record = fixture("device-license.json") as { license: unknown };
    const reading = recording(record);
    await expect(reading.api.getDevice()).resolves.toMatchObject({ license: record.license });
    expect(reading.sent).toEqual([
      { method: "GET", path: "/v1/device", body: undefined, officeToken: undefined },
    ]);
    // A host before plan ЛЦ-2 sends no license: still a record.
    await expect(
      recording(fixture("device-info.json")).api.getDevice(),
    ).resolves.not.toHaveProperty("license");
  });
});

describe("update distribution (plan ОБН-3)", () => {
  it("reads the device's update offer and the office's update status", async () => {
    const offer = recording(fixture("device-update-offer.json"));
    expect((await offer.api.getDeviceUpdate()).package.state).toBe("ok");
    expect(offer.sent).toEqual([
      { method: "GET", path: "/v1/device/update", body: undefined, officeToken: undefined },
    ]);
    const status = recording(fixture("office-update-status.json"));
    expect((await status.api.getUpdateStatus(TOKEN)).devices).toHaveLength(5);
    expect(status.sent).toEqual([
      { method: "GET", path: "/v1/office/update-status", body: undefined, officeToken: TOKEN },
    ]);
  });
});
