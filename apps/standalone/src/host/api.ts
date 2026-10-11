import { z } from "zod";

import {
  backupStateSchema,
  knownBlocksResponseSchema,
  type BackupSettingsUpdate,
  type BackupState,
  type KnownBlocksRequest,
  type KnownBlocksResponse,
} from "./backups.js";
import type { HostClient } from "./client.js";
import {
  badgeInfoSchema,
  badgeSaltSchema,
  bootstrapResponseSchema,
  changesResponseSchema,
  codeCheckSchema,
  counterpartyRecordSchema,
  deviceRecordSchema,
  deviceShiftSchema,
  deviceShiftsSchema,
  enteredShiftSchema,
  factReceiptsSchema,
  labelTemplateSchema,
  labelTemplateSummarySchema,
  officeBoxSchema,
  officeLineSchema,
  officeOperatorSchema,
  officePalletSchema,
  officeProductSchema,
  officeSessionSchema,
  officeUserRecordSchema,
  officeUserSchema,
  orgLogoStateSchema,
  orgProfileSchema,
  pairingCodeSchema,
  productGroupSchema,
  officeShiftSchema,
  ssccBlockSchema,
  shiftExportRowsSchema,
  boxReportRowsSchema,
  palletReportRowsSchema,
  ssccCounterSchema,
  ssccStateSchema,
  templateDefaultsSchema,
  type BadgeCreate,
  type BadgeInfo,
  type BadgeSalt,
  type BlockSizesUpdate,
  type BootstrapRequest,
  type BootstrapResponse,
  type ChangesResponse,
  type CodeCheck,
  type CounterpartyCreate,
  type CounterpartyRecord,
  type CounterpartyUpdate,
  type DeviceRecord,
  type DeviceShift,
  type DeviceShiftCreate,
  type DeviceUpdate,
  type EnteredShift,
  type FactReceipt,
  type LabelTemplate,
  type LabelTemplateSummary,
  type LineCreate,
  type LineUpdate,
  type OfficeBox,
  type OfficeLine,
  type OfficeLoginRequest,
  type OfficeOperator,
  type OfficePallet,
  type OfficeProduct,
  type OfficeSession,
  type OfficeShift,
  type OfficeUser,
  type OfficeUserCreate,
  type OfficeUserRecord,
  type OfficeUserUpdate,
  type OperatorCreate,
  type OperatorUpdate,
  type OrgLogoPut,
  type OrgLogoState,
  type OrgProfile,
  type OrgProfileUpdate,
  type PairingCode,
  type PairingCodeRequest,
  type PasswordChange,
  type PasswordSet,
  type ProductCreate,
  type ProductGroup,
  type ProductUpdate,
  type ShiftClose,
  type ShiftCreate,
  type ShiftExportRecord,
  type ShiftExportRows,
  type BoxReportRows,
  type PalletReportRows,
  type ShiftUpdate,
  type SsccBlock,
  type SsccBlockRequest,
  type SsccCounter,
  type SsccCounterUpdate,
  type SsccState,
  type TemplateCreate,
  type TemplateDefaults,
  type TemplateDefaultsUpdate,
  type TemplateUpdate,
} from "./protocol.js";

/** An SSCC counter's address: its issuer prefix and extension digit (0 box, 1 pallet). */
export interface SsccCounterKey {
  issuerPrefix: string;
  extension: number;
}

/** A period of production dates, both ends included, `YYYY-MM-DD`. */
export interface ShiftPeriod {
  from: string;
  to: string;
}

/**
 * Host endpoints over `host_request`. Office screens reach them only through
 * `OfficeSessionValue.call`, so an ended session or a rejected device is
 * routed to the shell. Members are function-typed properties, not methods,
 * so they can be passed around unbound (`@typescript-eslint/unbound-method`).
 */
export interface HostApi {
  bootstrap: (request: BootstrapRequest) => Promise<BootstrapResponse>;
  officeLogin: (request: OfficeLoginRequest) => Promise<OfficeSession>;
  officeLogout: (token: string) => Promise<void>;
  officeMe: (token: string) => Promise<OfficeUser>;
  officeChangePassword: (token: string, request: PasswordChange) => Promise<void>;
  getOrg: (token: string) => Promise<OrgProfile>;
  updateOrg: (token: string, update: OrgProfileUpdate) => Promise<OrgProfile>;
  getOrgLogo: (token: string) => Promise<OrgLogoState>;
  putOrgLogo: (token: string, put: OrgLogoPut) => Promise<OrgLogoState>;
  deleteOrgLogo: (token: string) => Promise<OrgLogoState>;
  getSscc: (token: string) => Promise<SsccState>;
  updateSsccCounter: (
    token: string,
    counter: SsccCounterKey,
    update: SsccCounterUpdate,
  ) => Promise<SsccCounter>;
  updateBlockSizes: (token: string, update: BlockSizesUpdate) => Promise<SsccState>;
  listUsers: (token: string) => Promise<OfficeUserRecord[]>;
  createUser: (token: string, create: OfficeUserCreate) => Promise<OfficeUserRecord>;
  updateUser: (token: string, id: string, update: OfficeUserUpdate) => Promise<OfficeUserRecord>;
  setUserPassword: (token: string, id: string, request: PasswordSet) => Promise<void>;
  /** Reference records changed after revision `since`; the device key only, no office session. */
  getChanges: (since: number) => Promise<ChangesResponse>;
  listDevices: (token: string) => Promise<DeviceRecord[]>;
  updateDevice: (token: string, id: string, update: DeviceUpdate) => Promise<DeviceRecord>;
  revokeDevice: (token: string, id: string) => Promise<DeviceRecord>;
  /**
   * Without `request` no body is sent. With it, the host ends the code it names
   * at once only if that code is live and this office user created it, and
   * ignores any other; the new code is issued either way (`PairingCodeRequest`
   * in `proto/src/lib.rs`, `create_code` in `host/src/routes/pairing.rs`).
   */
  createPairingCode: (token: string, request?: PairingCodeRequest) => Promise<PairingCode>;
  listCounterparties: (token: string) => Promise<CounterpartyRecord[]>;
  createCounterparty: (token: string, create: CounterpartyCreate) => Promise<CounterpartyRecord>;
  updateCounterparty: (
    token: string,
    id: string,
    update: CounterpartyUpdate,
  ) => Promise<CounterpartyRecord>;
  listLines: (token: string) => Promise<OfficeLine[]>;
  createLine: (token: string, create: LineCreate) => Promise<OfficeLine>;
  updateLine: (token: string, id: string, update: LineUpdate) => Promise<OfficeLine>;
  listOperators: (token: string) => Promise<OfficeOperator[]>;
  createOperator: (token: string, create: OperatorCreate) => Promise<OfficeOperator>;
  updateOperator: (token: string, id: string, update: OperatorUpdate) => Promise<OfficeOperator>;
  /** Answers the new badge, not its operator: a badge is a record of its own. */
  createBadge: (token: string, operatorId: string, create: BadgeCreate) => Promise<BadgeInfo>;
  /** `204`; revoking a badge that is already revoked changes nothing. */
  revokeBadge: (token: string, operatorId: string, badgeId: string) => Promise<void>;
  /** The site's badge salt; `not_found` before the wizard created it. */
  getBadgeSalt: (token: string) => Promise<BadgeSalt>;
  /** The ЧЗ product groups, by code: a static lookup. */
  listProductGroups: (token: string) => Promise<ProductGroup[]>;
  /** Every product, archived ones included. */
  listProducts: (token: string) => Promise<OfficeProduct[]>;
  createProduct: (token: string, create: ProductCreate) => Promise<OfficeProduct>;
  updateProduct: (token: string, id: string, update: ProductUpdate) => Promise<OfficeProduct>;
  /** Every template, without its layout. */
  listTemplates: (token: string) => Promise<LabelTemplateSummary[]>;
  /** One template with its layout. */
  getTemplate: (token: string, id: string) => Promise<LabelTemplate>;
  createTemplate: (token: string, create: TemplateCreate) => Promise<LabelTemplate>;
  updateTemplate: (token: string, id: string, update: TemplateUpdate) => Promise<LabelTemplate>;
  /** `204`; deleting it again after a lost answer answers `204` too. */
  deleteTemplate: (token: string, id: string) => Promise<void>;
  getTemplateDefaults: (token: string) => Promise<TemplateDefaults>;
  updateTemplateDefaults: (
    token: string,
    update: TemplateDefaultsUpdate,
  ) => Promise<TemplateDefaults>;
  /**
   * Without a period every planned and active shift and the closed ones
   * produced in the last 31 days of the host's clock; with one, every shift
   * produced in it. Newest production date first.
   */
  listShifts: (token: string, period?: ShiftPeriod) => Promise<OfficeShift[]>;
  /** One shift, its figures read afresh; `not_found` once it was deleted. */
  getShift: (token: string, id: string) => Promise<OfficeShift>;
  createShift: (token: string, create: ShiftCreate) => Promise<OfficeShift>;
  updateShift: (token: string, id: string, update: ShiftUpdate) => Promise<OfficeShift>;
  /** `204`, only a planned shift; a delete repeated after a lost answer is `not_found`. */
  deleteShift: (token: string, id: string) => Promise<void>;
  closeShift: (token: string, id: string, close: ShiftClose) => Promise<OfficeShift>;
  /**
   * What the shift's exports are built from, in one snapshot of the host
   * (plan ЧЗ); every office role. A planned shift answers with empty lists.
   */
  getShiftExportSource: (token: string, id: string) => Promise<ShiftExportRows>;
  /** Every box of the shift, opened first first, with its live units (plan ЧЗ, for plan О-Ф). */
  listShiftBoxes: (token: string, id: string) => Promise<OfficeBox[]>;
  /** Every pallet of the shift, opened first first, with what stands on it (plan ЧЗ). */
  listShiftPallets: (token: string, id: string) => Promise<OfficePallet[]>;
  /** `204`: the export's files are saved; the host writes its `shift.export` audit row (plan ЧЗ). */
  recordShiftExport: (token: string, id: string, record: ShiftExportRecord) => Promise<void>;
  /** What «Состав короба» prints of the box, in one snapshot (plan О-Ф); every office role. */
  getBoxReportRows: (token: string, id: string) => Promise<BoxReportRows>;
  /**
   * What «Состав паллеты» and «Ярлык паллеты» print of the shift's pallets, in
   * one snapshot (plan О-Ф); every office role. A shift without pallets has none.
   */
  getPalletReportRows: (token: string, id: string) => Promise<PalletReportRows>;
  /**
   * The station's shifts, with the device key only: the planned and active
   * shifts of its line and those it entered, active or closed within 30
   * days. Stations only (`forbidden` for another kind).
   */
  getDeviceShifts: () => Promise<DeviceShift[]>;
  /** A planned shift on the station's own line; the same `requestId` answers the same shift. */
  createDeviceShift: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  /**
   * Opens a planned shift or enters again the active one this station opened;
   * the answer carries the frozen snapshot.
   */
  enterShift: (id: string) => Promise<EnteredShift>;
  /**
   * A block of SSCC serials for this station; the same `requestId` answers the
   * same block, and the same id with another prefix is `validation_failed` on
   * `requestId`. Stations only.
   */
  requestSsccBlock: (request: SsccBlockRequest) => Promise<SsccBlock>;
  /**
   * Whether an accepted scan on the host owns the code (`kmHash`), within
   * `CODE_CHECK_TIMEOUT_MS`: past it the call fails with the transport code
   * `timeout`, and the station decides on its own copy.
   */
  checkCode: (codeHash: string) => Promise<CodeCheck>;
  /**
   * The outbox's records as kept (1-100, `FactRecord` each); a receipt per
   * record, in their order. A failed call is no receipt: the batch is sent
   * again.
   */
  sendFacts: (records: readonly unknown[]) => Promise<FactReceipt[]>;
  /**
   * After the host's restore epoch changed (plan РК-С): blocks this station
   * holds, 1-64 a request, as the host issued them; a result for each, in
   * their order. Stations only; `conflict` on `no_restore` from a host that
   * was never restored.
   */
  registerKnownBlocks: (request: KnownBlocksRequest) => Promise<KnownBlocksResponse>;
  /** The copies in both folders (plan РК); every office role reads them. */
  getBackups: (token: string) => Promise<BackupState>;
  /**
   * «Сделать копию сейчас»: `202` with the copy running; the host makes it on
   * its own, and the office reads the state again until nothing runs.
   */
  startBackup: (token: string) => Promise<BackupState>;
  updateBackupSettings: (token: string, update: BackupSettingsUpdate) => Promise<BackupState>;
  /** End the hold of the stations' facts a restore set; without a hold it changes nothing. */
  resumeFacts: (token: string) => Promise<BackupState>;
}

/** How long the scan pipeline waits for the host's code check (stage 2a spec, decision 16). */
export const CODE_CHECK_TIMEOUT_MS = 300;

/** A 204 answer parses as `null`. */
const NO_CONTENT = z.null();

export function createHostApi(client: HostClient): HostApi {
  return {
    bootstrap: (request) =>
      client.request("POST", "/v1/bootstrap", { body: request, schema: bootstrapResponseSchema }),
    officeLogin: (request) =>
      client.request("POST", "/v1/office/login", { body: request, schema: officeSessionSchema }),
    officeLogout: async (token) => {
      await client.request("POST", "/v1/office/logout", {
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    officeMe: (token) =>
      client.request("GET", "/v1/office/me", { officeToken: token, schema: officeUserSchema }),
    officeChangePassword: async (token, request) => {
      await client.request("PUT", "/v1/office/me/password", {
        body: request,
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    getOrg: (token) =>
      client.request("GET", "/v1/office/org", { officeToken: token, schema: orgProfileSchema }),
    updateOrg: (token, update) =>
      client.request("PUT", "/v1/office/org", {
        body: update,
        officeToken: token,
        schema: orgProfileSchema,
      }),
    getOrgLogo: (token) =>
      client.request("GET", "/v1/office/org/logo", {
        officeToken: token,
        schema: orgLogoStateSchema,
      }),
    putOrgLogo: (token, put) =>
      client.request("PUT", "/v1/office/org/logo", {
        body: put,
        officeToken: token,
        schema: orgLogoStateSchema,
      }),
    deleteOrgLogo: (token) =>
      client.request("DELETE", "/v1/office/org/logo", {
        officeToken: token,
        schema: orgLogoStateSchema,
      }),
    getSscc: (token) =>
      client.request("GET", "/v1/office/sscc", { officeToken: token, schema: ssccStateSchema }),
    updateSsccCounter: (token, { issuerPrefix, extension }, update) =>
      client.request("PUT", `/v1/office/sscc/counters/${issuerPrefix}/${extension}`, {
        body: update,
        officeToken: token,
        schema: ssccCounterSchema,
      }),
    updateBlockSizes: (token, update) =>
      client.request("PUT", "/v1/office/sscc/block-sizes", {
        body: update,
        officeToken: token,
        schema: ssccStateSchema,
      }),
    listUsers: (token) =>
      client.request("GET", "/v1/office/users", {
        officeToken: token,
        schema: z.array(officeUserRecordSchema),
      }),
    createUser: (token, create) =>
      client.request("POST", "/v1/office/users", {
        body: create,
        officeToken: token,
        schema: officeUserRecordSchema,
      }),
    updateUser: (token, id, update) =>
      client.request("PUT", `/v1/office/users/${id}`, {
        body: update,
        officeToken: token,
        schema: officeUserRecordSchema,
      }),
    setUserPassword: async (token, id, request) => {
      await client.request("PUT", `/v1/office/users/${id}/password`, {
        body: request,
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    getChanges: (since) =>
      client.request("GET", `/v1/changes?since=${since}`, { schema: changesResponseSchema }),
    listDevices: (token) =>
      client.request("GET", "/v1/office/devices", {
        officeToken: token,
        schema: z.array(deviceRecordSchema),
      }),
    updateDevice: (token, id, update) =>
      client.request("PUT", `/v1/office/devices/${id}`, {
        body: update,
        officeToken: token,
        schema: deviceRecordSchema,
      }),
    revokeDevice: (token, id) =>
      client.request("POST", `/v1/office/devices/${id}/revoke`, {
        officeToken: token,
        schema: deviceRecordSchema,
      }),
    createPairingCode: (token, request) =>
      client.request("POST", "/v1/office/pairing-codes", {
        body: request,
        officeToken: token,
        schema: pairingCodeSchema,
      }),
    listCounterparties: (token) =>
      client.request("GET", "/v1/office/counterparties", {
        officeToken: token,
        schema: z.array(counterpartyRecordSchema),
      }),
    createCounterparty: (token, create) =>
      client.request("POST", "/v1/office/counterparties", {
        body: create,
        officeToken: token,
        schema: counterpartyRecordSchema,
      }),
    updateCounterparty: (token, id, update) =>
      client.request("PUT", `/v1/office/counterparties/${id}`, {
        body: update,
        officeToken: token,
        schema: counterpartyRecordSchema,
      }),
    listLines: (token) =>
      client.request("GET", "/v1/office/lines", {
        officeToken: token,
        schema: z.array(officeLineSchema),
      }),
    createLine: (token, create) =>
      client.request("POST", "/v1/office/lines", {
        body: create,
        officeToken: token,
        schema: officeLineSchema,
      }),
    updateLine: (token, id, update) =>
      client.request("PUT", `/v1/office/lines/${id}`, {
        body: update,
        officeToken: token,
        schema: officeLineSchema,
      }),
    listOperators: (token) =>
      client.request("GET", "/v1/office/operators", {
        officeToken: token,
        schema: z.array(officeOperatorSchema),
      }),
    createOperator: (token, create) =>
      client.request("POST", "/v1/office/operators", {
        body: create,
        officeToken: token,
        schema: officeOperatorSchema,
      }),
    updateOperator: (token, id, update) =>
      client.request("PUT", `/v1/office/operators/${id}`, {
        body: update,
        officeToken: token,
        schema: officeOperatorSchema,
      }),
    createBadge: (token, operatorId, create) =>
      client.request("POST", `/v1/office/operators/${operatorId}/badges`, {
        body: create,
        officeToken: token,
        schema: badgeInfoSchema,
      }),
    revokeBadge: async (token, operatorId, badgeId) => {
      await client.request("DELETE", `/v1/office/operators/${operatorId}/badges/${badgeId}`, {
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    getBadgeSalt: (token) =>
      client.request("GET", "/v1/office/badge-salt", {
        officeToken: token,
        schema: badgeSaltSchema,
      }),
    listProductGroups: (token) =>
      client.request("GET", "/v1/office/product-groups", {
        officeToken: token,
        schema: z.array(productGroupSchema),
      }),
    listProducts: (token) =>
      client.request("GET", "/v1/office/products", {
        officeToken: token,
        schema: z.array(officeProductSchema),
      }),
    createProduct: (token, create) =>
      client.request("POST", "/v1/office/products", {
        body: create,
        officeToken: token,
        schema: officeProductSchema,
      }),
    updateProduct: (token, id, update) =>
      client.request("PUT", `/v1/office/products/${id}`, {
        body: update,
        officeToken: token,
        schema: officeProductSchema,
      }),
    listTemplates: (token) =>
      client.request("GET", "/v1/office/templates", {
        officeToken: token,
        schema: z.array(labelTemplateSummarySchema),
      }),
    getTemplate: (token, id) =>
      client.request("GET", `/v1/office/templates/${id}`, {
        officeToken: token,
        schema: labelTemplateSchema,
      }),
    createTemplate: (token, create) =>
      client.request("POST", "/v1/office/templates", {
        body: create,
        officeToken: token,
        schema: labelTemplateSchema,
      }),
    updateTemplate: (token, id, update) =>
      client.request("PUT", `/v1/office/templates/${id}`, {
        body: update,
        officeToken: token,
        schema: labelTemplateSchema,
      }),
    deleteTemplate: async (token, id) => {
      await client.request("DELETE", `/v1/office/templates/${id}`, {
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    getTemplateDefaults: (token) =>
      client.request("GET", "/v1/office/template-defaults", {
        officeToken: token,
        schema: templateDefaultsSchema,
      }),
    updateTemplateDefaults: (token, update) =>
      client.request("PUT", "/v1/office/template-defaults", {
        body: update,
        officeToken: token,
        schema: templateDefaultsSchema,
      }),
    listShifts: (token, period) =>
      client.request(
        "GET",
        period === undefined
          ? "/v1/office/shifts"
          : `/v1/office/shifts?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`,
        { officeToken: token, schema: z.array(officeShiftSchema) },
      ),
    getShift: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}`, {
        officeToken: token,
        schema: officeShiftSchema,
      }),
    createShift: (token, create) =>
      client.request("POST", "/v1/office/shifts", {
        body: create,
        officeToken: token,
        schema: officeShiftSchema,
      }),
    updateShift: (token, id, update) =>
      client.request("PUT", `/v1/office/shifts/${id}`, {
        body: update,
        officeToken: token,
        schema: officeShiftSchema,
      }),
    deleteShift: async (token, id) => {
      await client.request("DELETE", `/v1/office/shifts/${id}`, {
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    getDeviceShifts: async () =>
      (await client.request("GET", "/v1/device/shifts", { schema: deviceShiftsSchema })).shifts,
    createDeviceShift: (create) =>
      client.request("POST", "/v1/device/shifts", { body: create, schema: deviceShiftSchema }),
    enterShift: (id) =>
      client.request("POST", `/v1/device/shifts/${id}/enter`, { schema: enteredShiftSchema }),
    requestSsccBlock: (request) =>
      client.request("POST", "/v1/device/sscc/blocks", { body: request, schema: ssccBlockSchema }),
    checkCode: (codeHash) =>
      client.request("GET", `/v1/device/codes/${encodeURIComponent(codeHash)}`, {
        timeoutMs: CODE_CHECK_TIMEOUT_MS,
        schema: codeCheckSchema,
      }),
    sendFacts: async (records) =>
      (
        await client.request("POST", "/v1/device/facts", {
          body: { records },
          schema: factReceiptsSchema,
        })
      ).receipts,
    registerKnownBlocks: (request) =>
      client.request("POST", "/v1/device/sscc/blocks/known", {
        body: request,
        schema: knownBlocksResponseSchema,
      }),
    closeShift: (token, id, close) =>
      client.request("POST", `/v1/office/shifts/${id}/close`, {
        body: close,
        officeToken: token,
        schema: officeShiftSchema,
      }),
    getShiftExportSource: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}/export-source`, {
        officeToken: token,
        schema: shiftExportRowsSchema,
      }),
    listShiftBoxes: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}/boxes`, {
        officeToken: token,
        schema: z.array(officeBoxSchema),
      }),
    listShiftPallets: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}/pallets`, {
        officeToken: token,
        schema: z.array(officePalletSchema),
      }),
    recordShiftExport: async (token, id, record) => {
      await client.request("POST", `/v1/office/shifts/${id}/exports`, {
        body: record,
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    getBoxReportRows: (token, id) =>
      client.request("GET", `/v1/office/boxes/${id}/report-data`, {
        officeToken: token,
        schema: boxReportRowsSchema,
      }),
    getPalletReportRows: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}/pallet-report-data`, {
        officeToken: token,
        schema: palletReportRowsSchema,
      }),
    getBackups: (token) =>
      client.request("GET", "/v1/office/backups", {
        officeToken: token,
        schema: backupStateSchema,
      }),
    startBackup: (token) =>
      client.request("POST", "/v1/office/backups", {
        officeToken: token,
        schema: backupStateSchema,
      }),
    updateBackupSettings: (token, update) =>
      client.request("PUT", "/v1/office/backups/settings", {
        body: update,
        officeToken: token,
        schema: backupStateSchema,
      }),
    resumeFacts: (token) =>
      client.request("POST", "/v1/office/backups/resume", {
        officeToken: token,
        schema: backupStateSchema,
      }),
  };
}
