import {
  standaloneActivationRequestSchema,
  type StandaloneActivationRequest,
} from "@markiro/domain";
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
  deviceUpdateOfferSchema,
  officeUpdateStatusSchema,
  type DeviceUpdateOffer,
  type OfficeUpdateStatus,
} from "./distribution.js";
import { usageStatsSchema, type UsageStats } from "./usage-stats.js";
import {
  codeSearchPath,
  officeCodeCardSchema,
  officeCodePageSchema,
  type CodeSearchQuery,
  type OfficeCodeCard,
  type OfficeCodePage,
} from "./code-search.js";
import {
  cloudImportSummarySchema,
  type CloudImportRequest,
  type CloudImportSummary,
} from "./cloud-import.js";
import {
  disaggregationDetailSchema,
  disaggregationDocumentSchema,
  disaggregationQuery,
  disaggregationReasonSchema,
  disaggregationReportRowsSchema,
  type DisaggregationCreate,
  type DisaggregationDetail,
  type DisaggregationDocument,
  type DisaggregationExportRecord,
  type DisaggregationFilter,
  type DisaggregationLinesAdd,
  type DisaggregationReason,
  type DisaggregationReasonCreate,
  type DisaggregationReasonUpdate,
  type DisaggregationReportRows,
  type DisaggregationReportVariant,
  type DisaggregationTransition,
  type DisaggregationUpdate,
} from "./disaggregation.js";
import {
  exportFileChunkSchema,
  exportFileListSchema,
  exportFileOpenedSchema,
  exportFileProgressSchema,
  exportFilesPath,
  exportSettingsSchema,
  type ExportFileBegin,
  type ExportFileChunk,
  type ExportFileList,
  type ExportFileOpened,
  type ExportFileProgress,
  type ExportFileQuery,
  type ExportSettings,
  type ExportSettingsUpdate,
} from "./export-files.js";
import {
  isPackId,
  officeBoxCardSchema,
  officePalletCardSchema,
  officePalletPageSchema,
  palletListPath,
  type OfficeBoxCard,
  type OfficePalletCard,
  type OfficePalletPage,
  type PalletListQuery,
} from "./pack-cards.js";
import {
  badgeInfoSchema,
  badgeSaltSchema,
  bootstrapResponseSchema,
  changesResponseSchema,
  codeCheckSchema,
  counterpartyRecordSchema,
  employeeRecordSchema,
  deviceInfoSchema,
  deviceRecordSchema,
  deviceShiftSchema,
  deviceShiftsSchema,
  enteredShiftSchema,
  factReceiptsSchema,
  labelTemplateSchema,
  labelTemplateSummarySchema,
  licensePreviewSchema,
  officeBoxSchema,
  officeLicenseSchema,
  officeLineSchema,
  officeOperatorSchema,
  officePalletSchema,
  officeProductSchema,
  officeSessionSchema,
  officeUserRecordSchema,
  officeUserSchema,
  orgLogoStateSchema,
  productPhotoStateSchema,
  userAvatarStateSchema,
  hostNetworkSchema,
  orgProfileSchema,
  palletSheetSchema,
  palletSheetsSchema,
  pairingCodeSchema,
  productGroupSchema,
  officeShiftSchema,
  officeWarehousePalletsSchema,
  ssccBlockSchema,
  shiftExportRowsSchema,
  boxReportRowsSchema,
  palletReportRowsSchema,
  ssccCounterSchema,
  ssccStateSchema,
  templateDefaultsSchema,
  warehouseLookupResultSchema,
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
  type EmployeeCreate,
  type EmployeeRecord,
  type EmployeeUpdate,
  type DeviceInfo,
  type DeviceRecord,
  type DeviceShift,
  type DeviceShiftCreate,
  type DeviceUpdate,
  type EnteredShift,
  type FactReceipt,
  type LabelTemplate,
  type LabelTemplateSummary,
  type LicenseLoadRequest,
  type LicensePreview,
  type LineCreate,
  type LineUpdate,
  type OfficeBox,
  type OfficeLicense,
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
  type HostNetwork,
  type HostNetworkConfirm,
  type OrgLogoState,
  type ProductPhotoPut,
  type ProductPhotoState,
  type UserAvatarPut,
  type UserAvatarState,
  type OrgProfile,
  type OrgProfileUpdate,
  type PalletSheet,
  type PalletSheetCreate,
  type PalletSheetDefaultUpdate,
  type PalletSheetUpdate,
  type PalletSheets,
  type PairingCode,
  type PairingCodeRequest,
  type PasswordChange,
  type PasswordSet,
  type ProductCreate,
  type ProductGroup,
  type ProductUpdate,
  type ShiftClose,
  type ShiftCreate,
  type ShiftEnter,
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
  type UpdateStarted,
  type OfficeWarehousePallets,
  type WarehouseLookup,
  type WarehouseLookupResult,
} from "./protocol.js";
import {
  conflictStatusResponseSchema,
  conflictsPath,
  deviceDisplacementsSchema,
  displacementsPath,
  officeConflictPageSchema,
  officeConflictSchema,
  officeShiftExceptionsSchema,
  officeShiftExportsSchema,
  officeScanHistoryPageSchema,
  officeShiftRejectionsSchema,
  shiftScansPath,
  type ConflictQuery,
  type OfficeScanHistoryPage,
  type ScanHistoryQuery,
  type ConflictStatusRequest,
  type ConflictStatusResponse,
  type DeviceDisplacements,
  type OfficeConflict,
  type OfficeConflictPage,
  type OfficeShiftExceptions,
  type OfficeShiftExports,
  type OfficeShiftRejections,
} from "./review.js";

/** An SSCC counter's address: its issuer prefix and extension digit (0 box, 1 pallet). */
export interface SsccCounterKey {
  issuerPrefix: string;
  extension: number;
}

/**
 * A period of production dates (`from`, `to`) and a period of shift dates
 * (`plannedFrom`, `plannedTo`), both ends included, `YYYY-MM-DD`; any end may
 * be left out and the two periods narrow each other.
 */
export interface ShiftPeriod {
  from?: string;
  to?: string;
  plannedFrom?: string;
  plannedTo?: string;
}

/** The query of `GET /v1/office/shifts` for a period; empty for none. */
export function shiftPeriodQuery(period: ShiftPeriod | undefined): string {
  if (period === undefined) return "";
  const parts = (
    [
      ["from", period.from],
      ["to", period.to],
      ["plannedFrom", period.plannedFrom],
      ["plannedTo", period.plannedTo],
    ] as const
  ).flatMap(([name, value]) =>
    value === undefined ? [] : [`${name}=${encodeURIComponent(value)}`],
  );
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
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
  getHostNetwork: (token: string) => Promise<HostNetwork>;
  confirmHostNetwork: (token: string, request: HostNetworkConfirm) => Promise<HostNetwork>;
  updateOrg: (token: string, update: OrgProfileUpdate) => Promise<OrgProfile>;
  getOrgLogo: (token: string) => Promise<OrgLogoState>;
  putOrgLogo: (token: string, put: OrgLogoPut) => Promise<OrgLogoState>;
  deleteOrgLogo: (token: string) => Promise<OrgLogoState>;
  /** A product's photo (plan ТОВ): administrators and technologists write it; no revision. */
  getProductPhoto: (token: string, id: string) => Promise<ProductPhotoState>;
  putProductPhoto: (token: string, id: string, put: ProductPhotoPut) => Promise<ProductPhotoState>;
  deleteProductPhoto: (token: string, id: string) => Promise<ProductPhotoState>;
  /**
   * An office user's photo (plan АВА). Every role reads any user's (`avatar: null`
   * without one, `not_found` for an unknown user); `userId` is the user's own id
   * for a write: another user's `putUserAvatar` is `forbidden_replace_other`, and
   * `deleteUserAvatar` of another's is an administrator's. The picture is the
   * square the office cropped; the host reads its type and sides from its bytes.
   */
  getUserAvatar: (token: string, userId: string) => Promise<UserAvatarState>;
  putUserAvatar: (token: string, userId: string, put: UserAvatarPut) => Promise<UserAvatarState>;
  deleteUserAvatar: (token: string, userId: string) => Promise<UserAvatarState>;
  listPalletSheets: (token: string) => Promise<PalletSheets>;
  createPalletSheet: (token: string, create: PalletSheetCreate) => Promise<PalletSheet>;
  updatePalletSheet: (token: string, id: string, update: PalletSheetUpdate) => Promise<PalletSheet>;
  deletePalletSheet: (token: string, id: string) => Promise<void>;
  setDefaultPalletSheet: (token: string, update: PalletSheetDefaultUpdate) => Promise<PalletSheets>;
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
  /** A code that pairs device `id` again with its own `deviceId` (plan ТСД-Х, task Х6). */
  createDevicePairingCode: (token: string, id: string) => Promise<PairingCode>;
  listCounterparties: (token: string) => Promise<CounterpartyRecord[]>;
  createCounterparty: (token: string, create: CounterpartyCreate) => Promise<CounterpartyRecord>;
  updateCounterparty: (
    token: string,
    id: string,
    update: CounterpartyUpdate,
  ) => Promise<CounterpartyRecord>;
  listEmployees: (token: string) => Promise<EmployeeRecord[]>;
  createEmployee: (token: string, create: EmployeeCreate) => Promise<EmployeeRecord>;
  updateEmployee: (token: string, id: string, update: EmployeeUpdate) => Promise<EmployeeRecord>;
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
  /** The cloud's data into a new site, or its trial (`dryRun`); administrators only. */
  importFromCloud: (token: string, request: CloudImportRequest) => Promise<CloudImportSummary>;
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
  /**
   * Starts the upload of a file the office generated to the host's store (host migration
   * `0029`); a file of one chunk that carries its bytes is stored by this call. Repeating a
   * call answers where the upload stands.
   */
  beginExportFile: (token: string, begin: ExportFileBegin) => Promise<ExportFileProgress>;
  /** Chunk `seq` (at most 1 MiB of the file, base64) of an upload, in order. */
  putExportFileChunk: (
    token: string,
    id: string,
    seq: number,
    contentBase64: string,
  ) => Promise<ExportFileProgress>;
  /** Seals an upload: the host checks the whole against the declared size and SHA-256. */
  completeExportFile: (token: string, id: string) => Promise<ExportFileProgress>;
  /** The stored files of a shift or of a card, newest first. */
  listExportFiles: (token: string, query: ExportFileQuery) => Promise<ExportFileList>;
  /**
   * Opens a download: the host checks the stored bytes against their SHA-256 (`export_file_corrupted`
   * otherwise) and writes the `shift.export.download` audit row; the chunks follow.
   */
  openExportFileDownload: (token: string, id: string) => Promise<ExportFileOpened>;
  getExportFileChunk: (token: string, id: string, seq: number) => Promise<ExportFileChunk>;
  /** The retention of stored files and what the store holds. */
  getExportSettings: (token: string) => Promise<ExportSettings>;
  /** Administrators only. */
  putExportSettings: (token: string, update: ExportSettingsUpdate) => Promise<ExportSettings>;
  /** What «Состав короба» prints of the box, in one snapshot (plan О-Ф); every office role. */
  getBoxReportRows: (token: string, id: string) => Promise<BoxReportRows>;
  /**
   * What «Состав паллеты» and «Ярлык паллеты» print of the shift's pallets, in
   * one snapshot (plan О-Ф); every office role. A shift without pallets has none.
   */
  getPalletReportRows: (token: string, id: string) => Promise<PalletReportRows>;
  /**
   * One page of the code conflicts the facts wrote, newest detection first,
   * narrowed to the losing shift and to reviewed or not (plan КНФ); every
   * office role. The code travels as its hash, GTIN and serial only.
   */
  listConflicts: (token: string, query: ConflictQuery) => Promise<OfficeConflictPage>;
  /**
   * Marks a conflict reviewed and answers it (plan КНФ); administrators and
   * technologists. A conflict reviewed already answers as it is.
   */
  reviewConflict: (token: string, id: string) => Promise<OfficeConflict>;
  /** A shift's box and pallet exceptions, newest first, up to 500 (plan КНФ); every office role. */
  listShiftExceptions: (token: string, id: string) => Promise<OfficeShiftExceptions>;
  /** The shift's records the host refused, newest first, up to 500 (plan КНФ); every office role. */
  /** The exports of the shift the office saved, newest first (the shift drawer's history). */
  listShiftExports: (token: string, id: string) => Promise<OfficeShiftExports>;
  listShiftRejections: (token: string, id: string) => Promise<OfficeShiftRejections>;
  /**
   * One page of a shift's scan history, newest first, narrowed by `query`, below the cursor the
   * page before named; the code only as its GTIN and serial tail. Every office role.
   */
  listShiftScans: (
    token: string,
    id: string,
    query: ScanHistoryQuery,
    cursor: string | null,
    /** The rows of a page (1-100, the host's own 50 when left out). */
    limit?: number,
  ) => Promise<OfficeScanHistoryPage>;
  /**
   * One page of the placements of codes the criteria find, newest scan
   * first («Поиск кодов»); every office role. At least one criterion.
   */
  searchCodes: (token: string, query: CodeSearchQuery) => Promise<OfficeCodePage>;
  /** One code's card with its history; `not_found` for a code the host never saw. */
  getCodeCard: (token: string, codeHash: string) => Promise<OfficeCodeCard>;
  /** A box's card (plan КРТ); `not_found` for a box the host never saw. Every office role. */
  getBoxCard: (token: string, id: string) => Promise<OfficeBoxCard>;
  /** A pallet's card (plan КРТ); `not_found` for a pallet the host never saw. Every office role. */
  getPalletCard: (token: string, id: string) => Promise<OfficePalletCard>;
  /** One page of every pallet of the site (plan КРТ); `cursor` from the previous page. */
  listPallets: (
    token: string,
    query: PalletListQuery,
    cursor: string | null,
  ) => Promise<OfficePalletPage>;
  /** The pallets handhelds built outside shifts (plan ТСД-Х, Х5): open first, the latest 200. */
  listWarehousePallets: (token: string) => Promise<OfficeWarehousePallets>;
  /**
   * Of the station's records it names (1–200), those whose conflict the office
   * marked reviewed (plan КНФ), with the device key only; a host before plan
   * КНФ answers `not_found`.
   */
  conflictStatus: (request: ConflictStatusRequest) => Promise<ConflictStatusResponse>;
  /** What «Акт дезагрегации» prints of the document, in one snapshot (plan ДЗГ-О); every office role. */
  getDisaggregationReportRows: (
    token: string,
    id: string,
    variant: DisaggregationReportVariant,
  ) => Promise<DisaggregationReportRows>;
  /** `204`: the document's ЧЗ file is saved; the host writes its `disaggregation.export` row (plan ДЗГ-О). */
  recordDisaggregationExport: (
    token: string,
    id: string,
    record: DisaggregationExportRecord,
  ) => Promise<void>;
  /** The disaggregation reasons, archived ones included (plan ДЗГ); administrators and technologists. */
  listDisaggregationReasons: (token: string) => Promise<DisaggregationReason[]>;
  createDisaggregationReason: (
    token: string,
    create: DisaggregationReasonCreate,
  ) => Promise<DisaggregationReason>;
  /** The whole reason over its `rev`; `archived: true` archives it. */
  updateDisaggregationReason: (
    token: string,
    id: string,
    update: DisaggregationReasonUpdate,
  ) => Promise<DisaggregationReason>;
  /** Disaggregation documents, newest first, up to 1 000 (plan ДЗГ). */
  listDisaggregations: (
    token: string,
    filter?: DisaggregationFilter,
  ) => Promise<DisaggregationDocument[]>;
  getDisaggregation: (token: string, id: string) => Promise<DisaggregationDetail>;
  /** A new draft numbered `DSG-YY-NNNN`. */
  createDisaggregation: (
    token: string,
    create: DisaggregationCreate,
  ) => Promise<DisaggregationDetail>;
  /** The whole header of a draft over its `rev`. */
  updateDisaggregation: (
    token: string,
    id: string,
    update: DisaggregationUpdate,
  ) => Promise<DisaggregationDetail>;
  /** 1–500 lines a request; each gets its status at once. */
  addDisaggregationLines: (
    token: string,
    id: string,
    add: DisaggregationLinesAdd,
  ) => Promise<DisaggregationDetail>;
  /** `DELETE …/lines/{lineId}`: the card without the line. */
  deleteDisaggregationLine: (
    token: string,
    id: string,
    lineId: string,
  ) => Promise<DisaggregationDetail>;
  /** `409 conflict` `invalid_lines`: the fresh statuses are saved, read the card again. */
  applyDisaggregation: (
    token: string,
    id: string,
    transition: DisaggregationTransition,
  ) => Promise<DisaggregationDetail>;
  cancelDisaggregation: (
    token: string,
    id: string,
    transition: DisaggregationTransition,
  ) => Promise<DisaggregationDetail>;
  /**
   * The station's scans an earlier scan elsewhere took the code from, oldest
   * first after `after` (plan КНФ), with the device key only.
   */
  listDisplacements: (after: { at: string; id: string } | null) => Promise<DeviceDisplacements>;
  /**
   * This device's record (`GET /v1/device`) with the site's license (field
   * `license`, plan ЛЦ-2), with the device key only (plan ЛЦ-3). The shell's
   * `device_refresh` keeps the line from the same route; this read carries
   * only what the floor shows.
   */
  getDevice: () => Promise<DeviceInfo>;
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
   * the answer carries the frozen snapshot. `enter` names what the station
   * can work (`STATION_SHIFT_ENTER`, protocol 4): the host refuses a
   * validation shift to a station that does not name `validation-v1`.
   */
  enterShift: (id: string, enter: ShiftEnter) => Promise<EnteredShift>;
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
   * A product's photo for the station's copy (beta 3): the device key only,
   * `photo: null` without one; `not_found` for an unknown product.
   */
  getDeviceProductPhoto: (productId: string) => Promise<ProductPhotoState>;
  /**
   * The enabled A4 pallet sheets with their layouts, for a warehouse reprint of a pallet's
   * sheet (beta 3.2): `defaultId` is the sheet the product gets by default (its own, its
   * category's, the organization's), or only the organization's without a product. The device
   * key only; `not_found` for an unknown product.
   */
  getDevicePalletSheets: (productId?: string) => Promise<PalletSheets>;
  /**
   * What a label is printed again from (plan СКЛ): a unit by its code's hash,
   * a box or a pallet by its SSCC, of any station and any shift of this site.
   * The full code comes only in the answer's body.
   */
  warehouseLookup: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>;
  /** The warehouse reprint records (1–100); a receipt per record, in their order. */
  sendWarehouseRecords: (records: readonly unknown[]) => Promise<FactReceipt[]>;
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
   * The counts by month for the support bundle (beta 3 feedback); administrators
   * only, `forbidden` for another role.
   */
  getUsageStats: (token: string) => Promise<UsageStats>;
  /**
   * «Сделать копию сейчас»: `202` with the copy running; the host makes it on
   * its own, and the office reads the state again until nothing runs.
   */
  startBackup: (token: string) => Promise<BackupState>;
  updateBackupSettings: (token: string, update: BackupSettingsUpdate) => Promise<BackupState>;
  /** End the hold of the stations' facts a restore set; without a hold it changes nothing. */
  resumeFacts: (token: string) => Promise<BackupState>;
  /** `GET /v1/device/update` (plan ОБН-3): the host's version and package; any protocol, the device key. */
  getDeviceUpdate: () => Promise<DeviceUpdateOffer>;
  /** `GET /v1/office/update-status` (plan ОБН-3): every office role. */
  getUpdateStatus: (token: string) => Promise<OfficeUpdateStatus>;
  /** The site's license (plan ЛЦ-2); every office role reads it. */
  getLicense: (token: string) => Promise<OfficeLicense>;
  /** «было → станет» of a file, checked as a load checks it; administrators, nothing written. */
  previewLicense: (token: string, request: LicenseLoadRequest) => Promise<LicensePreview>;
  /** Load a file (administrators); a refusal is `validation_failed` on `file` with `details.reason`. */
  loadLicense: (token: string, request: LicenseLoadRequest) => Promise<OfficeLicense>;
  /** The activation request the office saves for Маркиро (administrators). */
  getActivationRequest: (token: string) => Promise<StandaloneActivationRequest>;
  /** «Открывать новые смены ещё 3 дня» (administrators), once per file and once for the trial. */
  enableLicenseEmergency: (token: string) => Promise<OfficeLicense>;
  /**
   * Plan ОБН-2: the office starts an installer on this PC; the host writes one
   * `app.update.start` row with this session's device. Administrators only.
   */
  recordUpdateStarted: (token: string, record: UpdateStarted) => Promise<void>;
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
    getHostNetwork: (token) =>
      client.request("GET", "/v1/office/host-network", {
        officeToken: token,
        schema: hostNetworkSchema,
      }),
    confirmHostNetwork: (token, request) =>
      client.request("PUT", "/v1/office/host-network", {
        body: request,
        officeToken: token,
        schema: hostNetworkSchema,
      }),
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
    getProductPhoto: (token, id) =>
      client.request("GET", `/v1/office/products/${id}/photo`, {
        officeToken: token,
        schema: productPhotoStateSchema,
      }),
    putProductPhoto: (token, id, put) =>
      client.request("PUT", `/v1/office/products/${id}/photo`, {
        // Only the wire's three fields: the host derives the media type from the bytes.
        body: { width: put.width, height: put.height, dataBase64: put.dataBase64 },
        officeToken: token,
        schema: productPhotoStateSchema,
      }),
    deleteProductPhoto: (token, id) =>
      client.request("DELETE", `/v1/office/products/${id}/photo`, {
        officeToken: token,
        schema: productPhotoStateSchema,
      }),
    getUserAvatar: (token, userId) =>
      client.request("GET", `/v1/office/users/${encodeURIComponent(userId)}/avatar`, {
        officeToken: token,
        schema: userAvatarStateSchema,
      }),
    putUserAvatar: (token, userId, put) =>
      client.request("PUT", `/v1/office/users/${encodeURIComponent(userId)}/avatar`, {
        // Only the wire's one field: the host reads the type and the sides from the bytes.
        body: { dataBase64: put.dataBase64 },
        officeToken: token,
        schema: userAvatarStateSchema,
      }),
    deleteUserAvatar: (token, userId) =>
      client.request("DELETE", `/v1/office/users/${encodeURIComponent(userId)}/avatar`, {
        officeToken: token,
        schema: userAvatarStateSchema,
      }),
    listPalletSheets: (token) =>
      client.request("GET", "/v1/office/pallet-sheets", {
        officeToken: token,
        schema: palletSheetsSchema,
      }),
    createPalletSheet: (token, create) =>
      client.request("POST", "/v1/office/pallet-sheets", {
        body: create,
        officeToken: token,
        schema: palletSheetSchema,
      }),
    updatePalletSheet: (token, id, update) =>
      client.request("PUT", `/v1/office/pallet-sheets/${id}`, {
        body: update,
        officeToken: token,
        schema: palletSheetSchema,
      }),
    deletePalletSheet: async (token, id) => {
      await client.request("DELETE", `/v1/office/pallet-sheets/${id}`, {
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    setDefaultPalletSheet: (token, update) =>
      client.request("PUT", "/v1/office/pallet-sheet-default", {
        body: update,
        officeToken: token,
        schema: palletSheetsSchema,
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
    createDevicePairingCode: (token, id) =>
      client.request("POST", `/v1/office/devices/${id}/pairing-code`, {
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
    listEmployees: (token) =>
      client.request("GET", "/v1/office/employees", {
        officeToken: token,
        schema: z.array(employeeRecordSchema),
      }),
    createEmployee: (token, create) =>
      client.request("POST", "/v1/office/employees", {
        body: create,
        officeToken: token,
        schema: employeeRecordSchema,
      }),
    updateEmployee: (token, id, update) =>
      client.request("PUT", `/v1/office/employees/${id}`, {
        body: update,
        officeToken: token,
        schema: employeeRecordSchema,
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
    importFromCloud: (token, request) =>
      client.request("POST", "/v1/office/import", {
        body: request,
        officeToken: token,
        schema: cloudImportSummarySchema,
      }),
    listShifts: (token, period) =>
      client.request("GET", `/v1/office/shifts${shiftPeriodQuery(period)}`, {
        officeToken: token,
        schema: z.array(officeShiftSchema),
      }),
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
    getDevice: () => client.request("GET", "/v1/device", { schema: deviceInfoSchema }),
    getDeviceShifts: async () =>
      (await client.request("GET", "/v1/device/shifts", { schema: deviceShiftsSchema })).shifts,
    createDeviceShift: (create) =>
      client.request("POST", "/v1/device/shifts", { body: create, schema: deviceShiftSchema }),
    enterShift: (id, enter) =>
      client.request("POST", `/v1/device/shifts/${id}/enter`, {
        body: enter,
        schema: enteredShiftSchema,
      }),
    requestSsccBlock: (request) =>
      client.request("POST", "/v1/device/sscc/blocks", { body: request, schema: ssccBlockSchema }),
    checkCode: (codeHash) =>
      client.request("GET", `/v1/device/codes/${encodeURIComponent(codeHash)}`, {
        timeoutMs: CODE_CHECK_TIMEOUT_MS,
        schema: codeCheckSchema,
      }),
    getDeviceProductPhoto: (productId) =>
      client.request("GET", `/v1/device/products/${encodeURIComponent(productId)}/photo`, {
        schema: productPhotoStateSchema,
      }),
    getDevicePalletSheets: (productId) =>
      client.request(
        "GET",
        productId === undefined
          ? "/v1/device/pallet-sheets"
          : `/v1/device/pallet-sheets?productId=${encodeURIComponent(productId)}`,
        { schema: palletSheetsSchema },
      ),
    warehouseLookup: (lookup) =>
      client.request("POST", "/v1/device/warehouse/lookup", {
        body: lookup,
        schema: warehouseLookupResultSchema,
      }),
    sendWarehouseRecords: async (records) =>
      (
        await client.request("POST", "/v1/device/warehouse/reprints", {
          body: { records },
          schema: factReceiptsSchema,
        })
      ).receipts,
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
    beginExportFile: (token, begin) =>
      client.request("POST", "/v1/office/export-files", {
        body: begin,
        officeToken: token,
        schema: exportFileProgressSchema,
      }),
    putExportFileChunk: (token, id, seq, contentBase64) =>
      client.request("PUT", `/v1/office/export-files/${id}/chunks/${seq}`, {
        body: { contentBase64 },
        officeToken: token,
        schema: exportFileProgressSchema,
      }),
    completeExportFile: (token, id) =>
      client.request("POST", `/v1/office/export-files/${id}/complete`, {
        officeToken: token,
        schema: exportFileProgressSchema,
      }),
    listExportFiles: (token, query) =>
      client.request("GET", exportFilesPath(query), {
        officeToken: token,
        schema: exportFileListSchema,
      }),
    openExportFileDownload: (token, id) =>
      client.request("POST", `/v1/office/export-files/${id}/download`, {
        officeToken: token,
        schema: exportFileOpenedSchema,
      }),
    getExportFileChunk: (token, id, seq) =>
      client.request("GET", `/v1/office/export-files/${id}/chunks/${seq}`, {
        officeToken: token,
        schema: exportFileChunkSchema,
      }),
    getExportSettings: (token) =>
      client.request("GET", "/v1/office/export-files/settings", {
        officeToken: token,
        schema: exportSettingsSchema,
      }),
    putExportSettings: (token, update) =>
      client.request("PUT", "/v1/office/export-files/settings", {
        body: update,
        officeToken: token,
        schema: exportSettingsSchema,
      }),
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
    listConflicts: (token, query) =>
      client.request("GET", conflictsPath(query), {
        officeToken: token,
        schema: officeConflictPageSchema,
      }),
    reviewConflict: (token, id) =>
      client.request("POST", `/v1/office/conflicts/${id}/review`, {
        officeToken: token,
        schema: officeConflictSchema,
      }),
    listShiftExceptions: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}/exceptions`, {
        officeToken: token,
        schema: officeShiftExceptionsSchema,
      }),
    listShiftExports: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}/exports`, {
        officeToken: token,
        schema: officeShiftExportsSchema,
      }),
    listShiftRejections: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}/rejections`, {
        officeToken: token,
        schema: officeShiftRejectionsSchema,
      }),
    listShiftScans: (token, id, query, cursor, limit) =>
      client.request("GET", shiftScansPath(id, query, cursor, limit), {
        officeToken: token,
        schema: officeScanHistoryPageSchema,
      }),
    conflictStatus: (request) =>
      client.request("POST", "/v1/device/conflicts/status", {
        body: request,
        schema: conflictStatusResponseSchema,
      }),
    listDisplacements: (after) =>
      client.request("GET", displacementsPath(after), { schema: deviceDisplacementsSchema }),
    listDisaggregationReasons: (token) =>
      client.request("GET", "/v1/office/disaggregation-reasons", {
        officeToken: token,
        schema: z.array(disaggregationReasonSchema),
      }),
    createDisaggregationReason: (token, create) =>
      client.request("POST", "/v1/office/disaggregation-reasons", {
        body: create,
        officeToken: token,
        schema: disaggregationReasonSchema,
      }),
    updateDisaggregationReason: (token, id, update) =>
      client.request("PUT", `/v1/office/disaggregation-reasons/${id}`, {
        body: update,
        officeToken: token,
        schema: disaggregationReasonSchema,
      }),
    listDisaggregations: (token, filter) =>
      client.request("GET", `/v1/office/disaggregation${disaggregationQuery(filter)}`, {
        officeToken: token,
        schema: z.array(disaggregationDocumentSchema),
      }),
    getDisaggregation: (token, id) =>
      client.request("GET", `/v1/office/disaggregation/${id}`, {
        officeToken: token,
        schema: disaggregationDetailSchema,
      }),
    createDisaggregation: (token, create) =>
      client.request("POST", "/v1/office/disaggregation", {
        body: create,
        officeToken: token,
        schema: disaggregationDetailSchema,
      }),
    updateDisaggregation: (token, id, update) =>
      client.request("PUT", `/v1/office/disaggregation/${id}`, {
        body: update,
        officeToken: token,
        schema: disaggregationDetailSchema,
      }),
    addDisaggregationLines: (token, id, add) =>
      client.request("POST", `/v1/office/disaggregation/${id}/lines`, {
        body: add,
        officeToken: token,
        schema: disaggregationDetailSchema,
      }),
    deleteDisaggregationLine: (token, id, lineId) =>
      client.request("DELETE", `/v1/office/disaggregation/${id}/lines/${lineId}`, {
        officeToken: token,
        schema: disaggregationDetailSchema,
      }),
    applyDisaggregation: (token, id, transition) =>
      client.request("POST", `/v1/office/disaggregation/${id}/apply`, {
        body: transition,
        officeToken: token,
        schema: disaggregationDetailSchema,
      }),
    cancelDisaggregation: (token, id, transition) =>
      client.request("POST", `/v1/office/disaggregation/${id}/cancel`, {
        body: transition,
        officeToken: token,
        schema: disaggregationDetailSchema,
      }),
    getDisaggregationReportRows: (token, id, variant) =>
      client.request("GET", `/v1/office/disaggregation/${id}/report-data?variant=${variant}`, {
        officeToken: token,
        schema: disaggregationReportRowsSchema,
      }),
    recordDisaggregationExport: async (token, id, record) => {
      await client.request("POST", `/v1/office/disaggregation/${id}/exports`, {
        body: record,
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    searchCodes: (token, query) =>
      client.request("GET", codeSearchPath(query), {
        officeToken: token,
        schema: officeCodePageSchema,
      }),
    getCodeCard: (token, codeHash) => {
      if (!/^[0-9a-f]{64}$/.test(codeHash)) {
        return Promise.reject(new RangeError("not a code hash"));
      }
      return client.request("GET", `/v1/office/codes/${codeHash}`, {
        officeToken: token,
        schema: officeCodeCardSchema,
      });
    },
    getBoxCard: (token, id) => {
      if (!isPackId(id)) return Promise.reject(new RangeError("not a box id"));
      return client.request("GET", `/v1/office/boxes/${id}`, {
        officeToken: token,
        schema: officeBoxCardSchema,
      });
    },
    getPalletCard: (token, id) => {
      if (!isPackId(id)) return Promise.reject(new RangeError("not a pallet id"));
      return client.request("GET", `/v1/office/pallets/${id}`, {
        officeToken: token,
        schema: officePalletCardSchema,
      });
    },
    listPallets: (token, query, cursor) =>
      client.request("GET", palletListPath(query, cursor), {
        officeToken: token,
        schema: officePalletPageSchema,
      }),
    listWarehousePallets: (token) =>
      client.request("GET", "/v1/office/warehouse-pallets", {
        officeToken: token,
        schema: officeWarehousePalletsSchema,
      }),
    getBackups: (token) =>
      client.request("GET", "/v1/office/backups", {
        officeToken: token,
        schema: backupStateSchema,
      }),
    getUsageStats: (token) =>
      client.request("GET", "/v1/office/usage-stats", {
        officeToken: token,
        schema: usageStatsSchema,
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
    getDeviceUpdate: () =>
      client.request("GET", "/v1/device/update", { schema: deviceUpdateOfferSchema }),
    getUpdateStatus: (token) =>
      client.request("GET", "/v1/office/update-status", {
        officeToken: token,
        schema: officeUpdateStatusSchema,
      }),
    getLicense: (token) =>
      client.request("GET", "/v1/office/license", {
        officeToken: token,
        schema: officeLicenseSchema,
      }),
    previewLicense: (token, request) =>
      client.request("POST", "/v1/office/license/preview", {
        body: request,
        officeToken: token,
        schema: licensePreviewSchema,
      }),
    loadLicense: (token, request) =>
      client.request("PUT", "/v1/office/license", {
        body: request,
        officeToken: token,
        schema: officeLicenseSchema,
      }),
    // Parsed with the domain's strict schema on purpose: the office must not
    // save a request the cloud would refuse.
    getActivationRequest: (token) =>
      client.request("GET", "/v1/office/license/activation-request", {
        officeToken: token,
        schema: standaloneActivationRequestSchema,
      }),
    enableLicenseEmergency: (token) =>
      client.request("POST", "/v1/office/license/emergency", {
        officeToken: token,
        schema: officeLicenseSchema,
      }),
    recordUpdateStarted: async (token, record) => {
      await client.request("POST", "/v1/office/updates/started", {
        body: record,
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
  };
}
