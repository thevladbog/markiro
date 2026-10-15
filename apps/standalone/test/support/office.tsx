import { readFileSync } from "node:fs";

import { render, type RenderResult } from "@testing-library/react";
import { vi, type Mock } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { HostApi } from "../../src/host/api.js";
import { officeLicenseSchema } from "../../src/host/protocol.js";
import type {
  OfficeUser,
  OfficeUserRecord,
  OrgProfile,
  SsccState,
} from "../../src/host/protocol.js";
import { RasterUnavailableError } from "../../src/labels/rasterizer.js";
import { Office, type OfficeProps } from "../../src/office/Office.js";
import type { OfficeSessionValue } from "../../src/office/office-session.js";
import type { LabelRendering } from "../../src/office/templates/label-rendering.js";
import { HEALTHY_BACKUPS } from "./backups.js";
import { SESSION } from "./fixtures.js";

const supportModuleUrl = import.meta.url;

/**
 * The license every office session reads unless a test stubs it: the shared
 * fixture's, with every feature on (custom branding included), as the
 * built-in trial has them. Custom branding reads it (`office/branding.ts`).
 */
const TRIAL_LICENSE = officeLicenseSchema.parse(
  JSON.parse(
    readFileSync(new URL("../../proto/fixtures/office-license.json", supportModuleUrl), "utf8"),
  ),
);

/** A `HostApi` of mocks. */
export type FakeHostApi = { [K in keyof HostApi]: Mock<HostApi[K]> };

function unexpected(name: keyof HostApi): Promise<never> {
  return Promise.reject(new Error(`unexpected HostApi.${name} call`));
}

/**
 * Every method a test did not stub fails loudly; `officeLogout` succeeds,
 * `getOrgLogo` answers no logo (a label preview reads it, #703),
 * `getProductPhoto` no photo (a shift task form reads it, plan ТОВ),
 * `getDeviceShifts` answers no shifts, `conflictStatus` and `listDisplacements`
 * tell of nothing (the station's link reads them, plan КНФ), and `listConflicts`,
 * `listShiftExceptions` and `listShiftRejections` answer none (the shift card
 * and the export dialog read them in passing, plan КНФ).
 */
export function fakeHostApi(overrides: Partial<FakeHostApi> = {}): FakeHostApi {
  return {
    bootstrap: vi.fn<HostApi["bootstrap"]>(() => unexpected("bootstrap")),
    officeLogin: vi.fn<HostApi["officeLogin"]>(() => unexpected("officeLogin")),
    officeLogout: vi.fn<HostApi["officeLogout"]>(async () => undefined),
    officeMe: vi.fn<HostApi["officeMe"]>(() => unexpected("officeMe")),
    officeChangePassword: vi.fn<HostApi["officeChangePassword"]>(() =>
      unexpected("officeChangePassword"),
    ),
    getOrg: vi.fn<HostApi["getOrg"]>(() => unexpected("getOrg")),
    updateOrg: vi.fn<HostApi["updateOrg"]>(() => unexpected("updateOrg")),
    getOrgLogo: vi.fn<HostApi["getOrgLogo"]>(async () => ({ logo: null })),
    putOrgLogo: vi.fn<HostApi["putOrgLogo"]>(() => unexpected("putOrgLogo")),
    deleteOrgLogo: vi.fn<HostApi["deleteOrgLogo"]>(() => unexpected("deleteOrgLogo")),
    getProductPhoto: vi.fn<HostApi["getProductPhoto"]>(async () => ({ photo: null })),
    putProductPhoto: vi.fn<HostApi["putProductPhoto"]>(() => unexpected("putProductPhoto")),
    deleteProductPhoto: vi.fn<HostApi["deleteProductPhoto"]>(() =>
      unexpected("deleteProductPhoto"),
    ),
    listPalletSheets: vi.fn<HostApi["listPalletSheets"]>(() => unexpected("listPalletSheets")),
    createPalletSheet: vi.fn<HostApi["createPalletSheet"]>(() => unexpected("createPalletSheet")),
    updatePalletSheet: vi.fn<HostApi["updatePalletSheet"]>(() => unexpected("updatePalletSheet")),
    deletePalletSheet: vi.fn<HostApi["deletePalletSheet"]>(() => unexpected("deletePalletSheet")),
    setDefaultPalletSheet: vi.fn<HostApi["setDefaultPalletSheet"]>(() =>
      unexpected("setDefaultPalletSheet"),
    ),
    getSscc: vi.fn<HostApi["getSscc"]>(() => unexpected("getSscc")),
    updateSsccCounter: vi.fn<HostApi["updateSsccCounter"]>(() => unexpected("updateSsccCounter")),
    updateBlockSizes: vi.fn<HostApi["updateBlockSizes"]>(() => unexpected("updateBlockSizes")),
    listUsers: vi.fn<HostApi["listUsers"]>(() => unexpected("listUsers")),
    createUser: vi.fn<HostApi["createUser"]>(() => unexpected("createUser")),
    updateUser: vi.fn<HostApi["updateUser"]>(() => unexpected("updateUser")),
    setUserPassword: vi.fn<HostApi["setUserPassword"]>(() => unexpected("setUserPassword")),
    getChanges: vi.fn<HostApi["getChanges"]>(() => unexpected("getChanges")),
    listDevices: vi.fn<HostApi["listDevices"]>(() => unexpected("listDevices")),
    updateDevice: vi.fn<HostApi["updateDevice"]>(() => unexpected("updateDevice")),
    revokeDevice: vi.fn<HostApi["revokeDevice"]>(() => unexpected("revokeDevice")),
    createPairingCode: vi.fn<HostApi["createPairingCode"]>(() => unexpected("createPairingCode")),
    listCounterparties: vi.fn<HostApi["listCounterparties"]>(() =>
      unexpected("listCounterparties"),
    ),
    createCounterparty: vi.fn<HostApi["createCounterparty"]>(() =>
      unexpected("createCounterparty"),
    ),
    updateCounterparty: vi.fn<HostApi["updateCounterparty"]>(() =>
      unexpected("updateCounterparty"),
    ),
    // The office no longer has «Сотрудники»; the client keeps the host calls.
    listEmployees: vi.fn<HostApi["listEmployees"]>(async () => []),
    createEmployee: vi.fn<HostApi["createEmployee"]>(() => unexpected("createEmployee")),
    updateEmployee: vi.fn<HostApi["updateEmployee"]>(() => unexpected("updateEmployee")),
    listLines: vi.fn<HostApi["listLines"]>(() => unexpected("listLines")),
    createLine: vi.fn<HostApi["createLine"]>(() => unexpected("createLine")),
    updateLine: vi.fn<HostApi["updateLine"]>(() => unexpected("updateLine")),
    listOperators: vi.fn<HostApi["listOperators"]>(() => unexpected("listOperators")),
    createOperator: vi.fn<HostApi["createOperator"]>(() => unexpected("createOperator")),
    updateOperator: vi.fn<HostApi["updateOperator"]>(() => unexpected("updateOperator")),
    createBadge: vi.fn<HostApi["createBadge"]>(() => unexpected("createBadge")),
    revokeBadge: vi.fn<HostApi["revokeBadge"]>(() => unexpected("revokeBadge")),
    getBadgeSalt: vi.fn<HostApi["getBadgeSalt"]>(() => unexpected("getBadgeSalt")),
    listProductGroups: vi.fn<HostApi["listProductGroups"]>(() => unexpected("listProductGroups")),
    listProducts: vi.fn<HostApi["listProducts"]>(() => unexpected("listProducts")),
    createProduct: vi.fn<HostApi["createProduct"]>(() => unexpected("createProduct")),
    updateProduct: vi.fn<HostApi["updateProduct"]>(() => unexpected("updateProduct")),
    listTemplates: vi.fn<HostApi["listTemplates"]>(() => unexpected("listTemplates")),
    getTemplate: vi.fn<HostApi["getTemplate"]>(() => unexpected("getTemplate")),
    createTemplate: vi.fn<HostApi["createTemplate"]>(() => unexpected("createTemplate")),
    updateTemplate: vi.fn<HostApi["updateTemplate"]>(() => unexpected("updateTemplate")),
    deleteTemplate: vi.fn<HostApi["deleteTemplate"]>(() => unexpected("deleteTemplate")),
    getTemplateDefaults: vi.fn<HostApi["getTemplateDefaults"]>(() =>
      unexpected("getTemplateDefaults"),
    ),
    updateTemplateDefaults: vi.fn<HostApi["updateTemplateDefaults"]>(() =>
      unexpected("updateTemplateDefaults"),
    ),
    importFromCloud: vi.fn<HostApi["importFromCloud"]>(() => unexpected("importFromCloud")),
    listShifts: vi.fn<HostApi["listShifts"]>(() => unexpected("listShifts")),
    getShift: vi.fn<HostApi["getShift"]>(() => unexpected("getShift")),
    createShift: vi.fn<HostApi["createShift"]>(() => unexpected("createShift")),
    updateShift: vi.fn<HostApi["updateShift"]>(() => unexpected("updateShift")),
    deleteShift: vi.fn<HostApi["deleteShift"]>(() => unexpected("deleteShift")),
    closeShift: vi.fn<HostApi["closeShift"]>(() => unexpected("closeShift")),
    getShiftExportSource: vi.fn<HostApi["getShiftExportSource"]>(() =>
      unexpected("getShiftExportSource"),
    ),
    listShiftBoxes: vi.fn<HostApi["listShiftBoxes"]>(() => unexpected("listShiftBoxes")),
    listShiftPallets: vi.fn<HostApi["listShiftPallets"]>(() => unexpected("listShiftPallets")),
    recordShiftExport: vi.fn<HostApi["recordShiftExport"]>(() => unexpected("recordShiftExport")),
    // The floor reads its shifts whenever it reads its device record; a test
    // about something else gets none.
    getDeviceShifts: vi.fn<HostApi["getDeviceShifts"]>(async () => []),
    createDeviceShift: vi.fn<HostApi["createDeviceShift"]>(() => unexpected("createDeviceShift")),
    enterShift: vi.fn<HostApi["enterShift"]>(() => unexpected("enterShift")),
    requestSsccBlock: vi.fn<HostApi["requestSsccBlock"]>(() => unexpected("requestSsccBlock")),
    checkCode: vi.fn<HostApi["checkCode"]>(() => unexpected("checkCode")),
    getDeviceProductPhoto: vi.fn<HostApi["getDeviceProductPhoto"]>(async () => ({ photo: null })),
    getDevicePalletSheets: vi.fn<HostApi["getDevicePalletSheets"]>(async () => ({
      sheets: [],
      defaultId: null,
    })),
    sendFacts: vi.fn<HostApi["sendFacts"]>(() => unexpected("sendFacts")),
    warehouseLookup: vi.fn<HostApi["warehouseLookup"]>(() => unexpected("warehouseLookup")),
    sendWarehouseRecords: vi.fn<HostApi["sendWarehouseRecords"]>(() =>
      unexpected("sendWarehouseRecords"),
    ),
    registerKnownBlocks: vi.fn<HostApi["registerKnownBlocks"]>(() =>
      unexpected("registerKnownBlocks"),
    ),
    getBoxReportRows: vi.fn<HostApi["getBoxReportRows"]>(() => unexpected("getBoxReportRows")),
    getPalletReportRows: vi.fn<HostApi["getPalletReportRows"]>(() =>
      unexpected("getPalletReportRows"),
    ),
    listConflicts: vi.fn<HostApi["listConflicts"]>(async () => ({
      items: [],
      page: 1,
      pageCount: 1,
      total: 0,
    })),
    reviewConflict: vi.fn<HostApi["reviewConflict"]>(() => unexpected("reviewConflict")),
    listDisaggregationReasons: vi.fn<HostApi["listDisaggregationReasons"]>(() =>
      unexpected("listDisaggregationReasons"),
    ),
    createDisaggregationReason: vi.fn<HostApi["createDisaggregationReason"]>(() =>
      unexpected("createDisaggregationReason"),
    ),
    updateDisaggregationReason: vi.fn<HostApi["updateDisaggregationReason"]>(() =>
      unexpected("updateDisaggregationReason"),
    ),
    listDisaggregations: vi.fn<HostApi["listDisaggregations"]>(() =>
      unexpected("listDisaggregations"),
    ),
    getDisaggregation: vi.fn<HostApi["getDisaggregation"]>(() => unexpected("getDisaggregation")),
    createDisaggregation: vi.fn<HostApi["createDisaggregation"]>(() =>
      unexpected("createDisaggregation"),
    ),
    updateDisaggregation: vi.fn<HostApi["updateDisaggregation"]>(() =>
      unexpected("updateDisaggregation"),
    ),
    addDisaggregationLines: vi.fn<HostApi["addDisaggregationLines"]>(() =>
      unexpected("addDisaggregationLines"),
    ),
    deleteDisaggregationLine: vi.fn<HostApi["deleteDisaggregationLine"]>(() =>
      unexpected("deleteDisaggregationLine"),
    ),
    applyDisaggregation: vi.fn<HostApi["applyDisaggregation"]>(() =>
      unexpected("applyDisaggregation"),
    ),
    cancelDisaggregation: vi.fn<HostApi["cancelDisaggregation"]>(() =>
      unexpected("cancelDisaggregation"),
    ),
    getDisaggregationReportRows: vi.fn<HostApi["getDisaggregationReportRows"]>(() =>
      unexpected("getDisaggregationReportRows"),
    ),
    recordDisaggregationExport: vi.fn<HostApi["recordDisaggregationExport"]>(() =>
      unexpected("recordDisaggregationExport"),
    ),
    listShiftExceptions: vi.fn<HostApi["listShiftExceptions"]>(async () => ({
      items: [],
      total: 0,
    })),
    listShiftExports: vi.fn<HostApi["listShiftExports"]>(async () => ({ items: [] })),
    // The host's store of generated files (host migration 0029): by default it takes every
    // file whole and lists none, so a test about something else sees no warning.
    beginExportFile: vi.fn<HostApi["beginExportFile"]>(async (_token, begin) => ({
      id: begin.id,
      chunkCount: Math.max(1, Math.ceil(begin.sizeBytes / 1_048_576)),
      receivedChunks: begin.contentBase64 === undefined ? 0 : 1,
      ready: begin.contentBase64 !== undefined,
    })),
    putExportFileChunk: vi.fn<HostApi["putExportFileChunk"]>(async (_token, id, seq) => ({
      id,
      chunkCount: seq + 1,
      receivedChunks: seq + 1,
      ready: false,
    })),
    completeExportFile: vi.fn<HostApi["completeExportFile"]>(async (_token, id) => ({
      id,
      chunkCount: 1,
      receivedChunks: 1,
      ready: true,
    })),
    listExportFiles: vi.fn<HostApi["listExportFiles"]>(async () => ({ items: [] })),
    openExportFileDownload: vi.fn<HostApi["openExportFileDownload"]>(() =>
      unexpected("openExportFileDownload"),
    ),
    getExportFileChunk: vi.fn<HostApi["getExportFileChunk"]>(() =>
      unexpected("getExportFileChunk"),
    ),
    getExportSettings: vi.fn<HostApi["getExportSettings"]>(async () => ({
      retentionDays: null,
      fileCount: 0,
      storedBytes: 0,
      originalBytes: 0,
      maxStoredBytes: 2_147_483_648,
    })),
    putExportSettings: vi.fn<HostApi["putExportSettings"]>(() => unexpected("putExportSettings")),
    listShiftRejections: vi.fn<HostApi["listShiftRejections"]>(async () => ({
      items: [],
      total: 0,
    })),
    listShiftScans: vi.fn<HostApi["listShiftScans"]>(async () => ({
      items: [],
      nextCursor: null,
    })),
    // The station's link reads them at every revision (plan КНФ): nothing to tell by default.
    conflictStatus: vi.fn<HostApi["conflictStatus"]>(async () => ({ reviewed: [] })),
    listDisplacements: vi.fn<HostApi["listDisplacements"]>(async () => ({
      items: [],
      more: false,
    })),
    searchCodes: vi.fn<HostApi["searchCodes"]>(() => unexpected("searchCodes")),
    getCodeCard: vi.fn<HostApi["getCodeCard"]>(() => unexpected("getCodeCard")),
    getBoxCard: vi.fn<HostApi["getBoxCard"]>(() => unexpected("getBoxCard")),
    getPalletCard: vi.fn<HostApi["getPalletCard"]>(() => unexpected("getPalletCard")),
    listPallets: vi.fn<HostApi["listPallets"]>(() => unexpected("listPallets")),
    // «Обзор» reads the copies on every office test: healthy ones warn of nothing.
    getBackups: vi.fn<HostApi["getBackups"]>(async () => HEALTHY_BACKUPS),
    getUsageStats: vi.fn<HostApi["getUsageStats"]>(() => unexpected("getUsageStats")),
    startBackup: vi.fn<HostApi["startBackup"]>(() => unexpected("startBackup")),
    updateBackupSettings: vi.fn<HostApi["updateBackupSettings"]>(() =>
      unexpected("updateBackupSettings"),
    ),
    resumeFacts: vi.fn<HostApi["resumeFacts"]>(() => unexpected("resumeFacts")),
    getLicense: vi.fn<HostApi["getLicense"]>(async () => TRIAL_LICENSE),
    previewLicense: vi.fn<HostApi["previewLicense"]>(() => unexpected("previewLicense")),
    loadLicense: vi.fn<HostApi["loadLicense"]>(() => unexpected("loadLicense")),
    getActivationRequest: vi.fn<HostApi["getActivationRequest"]>(() =>
      unexpected("getActivationRequest"),
    ),
    enableLicenseEmergency: vi.fn<HostApi["enableLicenseEmergency"]>(() =>
      unexpected("enableLicenseEmergency"),
    ),
    recordUpdateStarted: vi.fn<HostApi["recordUpdateStarted"]>(() =>
      unexpected("recordUpdateStarted"),
    ),
    ...overrides,
  };
}

export type FakeOfficeSession = OfficeSessionValue & {
  api: FakeHostApi;
  logout: Mock<OfficeSessionValue["logout"]>;
  signOut: Mock<NonNullable<OfficeSessionValue["signOut"]>>;
  refreshUser: Mock<OfficeSessionValue["refreshUser"]>;
};

/** The session value the shell gives the office; `call` passes the fixture token through. */
export function fakeOfficeSession(
  options: { user?: OfficeUser; api?: FakeHostApi } = {},
): FakeOfficeSession {
  return {
    user: options.user ?? SESSION.user,
    api: options.api ?? fakeHostApi(),
    call: <T,>(operation: (token: string) => Promise<T>) => operation(SESSION.token),
    logout: vi.fn<OfficeSessionValue["logout"]>(),
    signOut: vi.fn<NonNullable<OfficeSessionValue["signOut"]>>(),
    refreshUser: vi.fn<OfficeSessionValue["refreshUser"]>(async () => undefined),
  };
}

/**
 * Label drawing that stays still in jsdom: no canvas, a rasterizer that
 * refuses as the webview does without one, a font check that never answers,
 * so no warning arrives after a test has looked, and no thumbnail ever on
 * screen, so «Шаблоны» reads no layout.
 */
export function quietLabelRendering(): LabelRendering {
  return {
    context: () => null,
    rasterizeText: () => Promise.reject(new RasterUnavailableError()),
    checkFamilyCoverage: () => new Promise<boolean>(() => undefined),
    whenVisible: () => () => undefined,
  };
}

/**
 * The office as the shell renders it, in the dark theme; it draws labels
 * quietly (`quietLabelRendering`) unless `props.labels` says otherwise.
 */
export function renderOffice(
  session: OfficeSessionValue,
  props: Omit<OfficeProps, "session"> = {},
): RenderResult {
  return render(
    <ThemeProvider defaultTheme="dark">
      <Office session={session} labels={quietLabelRendering()} {...props} />
    </ThemeProvider>,
  );
}

export const TECHNOLOGIST: OfficeUser = {
  id: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21",
  login: "tech",
  name: "Павел Орлов",
  role: "technologist",
};

/** The signed-in administrator (the `SESSION` user) and the technologist. */
export const OFFICE_USERS: OfficeUserRecord[] = [
  {
    id: SESSION.user.id,
    login: "admin",
    name: "Ирина Смирнова",
    role: "admin",
    active: true,
    createdAt: "2026-09-26T09:15:00Z",
    rev: 1,
  },
  {
    id: TECHNOLOGIST.id,
    login: "tech",
    name: "Павел Орлов",
    role: "technologist",
    active: true,
    createdAt: "2026-09-26T09:20:00Z",
    rev: 3,
  },
];

export const ORG_PROFILE: OrgProfile = {
  name: "ООО «Атолл»",
  inn: "7701234567",
  gln: "4600682000013",
  gs1Prefixes: ["4600682"],
  timeZone: "Europe/Moscow",
  rev: 4,
};

/** Two prefixes: the current GLN's (460709100) and an earlier one's. */
export const SSCC_STATE: SsccState = {
  counters: [
    { issuerPrefix: "460068200", extension: 0, nextSerial: 1500, maxSerial: 9999999, rev: 1 },
    { issuerPrefix: "460068200", extension: 1, nextSerial: 40, maxSerial: 9999999, rev: 1 },
    { issuerPrefix: "460709100", extension: 0, nextSerial: 1, maxSerial: 9999999, rev: 2 },
    { issuerPrefix: "460709100", extension: 1, nextSerial: 0, maxSerial: 9999999, rev: 2 },
  ],
  boxBlockSize: 2000,
  palletBlockSize: 200,
  currentIssuerPrefix: "460709100",
  blockSizesRev: 3,
};
