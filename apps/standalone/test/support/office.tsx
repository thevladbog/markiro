import { render, type RenderResult } from "@testing-library/react";
import { vi, type Mock } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { HostApi } from "../../src/host/api.js";
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

/** A `HostApi` of mocks. */
export type FakeHostApi = { [K in keyof HostApi]: Mock<HostApi[K]> };

function unexpected(name: keyof HostApi): Promise<never> {
  return Promise.reject(new Error(`unexpected HostApi.${name} call`));
}

/**
 * Every method a test did not stub fails loudly; `officeLogout` succeeds,
 * `getOrgLogo` answers no logo (a label preview reads it, #703),
 * `getProductPhoto` no photo (a shift task form reads it, plan ТОВ),
 * `getDeviceShifts` answers no shifts, and `listConflicts`,
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
    // «Операторы» reads the employees for its «Сотрудник» column; a test
    // about something else gets none.
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
    listShiftExceptions: vi.fn<HostApi["listShiftExceptions"]>(async () => ({
      items: [],
      total: 0,
    })),
    listShiftRejections: vi.fn<HostApi["listShiftRejections"]>(async () => ({
      items: [],
      total: 0,
    })),
    searchCodes: vi.fn<HostApi["searchCodes"]>(() => unexpected("searchCodes")),
    getCodeCard: vi.fn<HostApi["getCodeCard"]>(() => unexpected("getCodeCard")),
    // «Обзор» reads the copies on every office test: healthy ones warn of nothing.
    getBackups: vi.fn<HostApi["getBackups"]>(async () => HEALTHY_BACKUPS),
    startBackup: vi.fn<HostApi["startBackup"]>(() => unexpected("startBackup")),
    updateBackupSettings: vi.fn<HostApi["updateBackupSettings"]>(() =>
      unexpected("updateBackupSettings"),
    ),
    resumeFacts: vi.fn<HostApi["resumeFacts"]>(() => unexpected("resumeFacts")),
    ...overrides,
  };
}

export type FakeOfficeSession = OfficeSessionValue & {
  api: FakeHostApi;
  logout: Mock<OfficeSessionValue["logout"]>;
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
