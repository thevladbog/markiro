import type {
  BadgeCreate,
  CategoryPalletSheetDefault,
  CategoryTemplateDefault,
  CounterpartyCreate,
  CounterpartyUpdate,
  DeviceRecord,
  DeviceShiftCreate,
  DeviceUpdate,
  EmployeeCreate,
  EmployeeRecord,
  EmployeeUpdate,
  LabelTemplate,
  LineCreate,
  LineUpdate,
  OfficeLine,
  OfficeOperator,
  OfficeShift,
  OperatorCreate,
  OperatorUpdate,
  PairingCodeRequest,
  ProductCreate,
  ProductUpdate,
  ShiftClose,
  ShiftCreate,
  ShiftExportRecord,
  ShiftUpdate,
  TemplateCreate,
  TemplateDefaultsUpdate,
  TemplatePurpose,
  TemplateSpec,
  TemplateUpdate,
  UpdateStarted,
} from "./protocol.js";

// The office's request bodies, each built field by field and never spread
// from form values: a field reaches the host only when its builder names it,
// so nothing else a form holds is sent by accident. `test/protocol.test.ts`
// pins every builder's output against its fixture in `proto/fixtures`.

/** A company's fields, trimmed and normalized from a form (`toCompanyInput`). */
export interface CompanyInput {
  name: string;
  inn: string | null;
  gln: string;
  gs1Prefixes: readonly string[];
}

/** `POST /v1/office/counterparties` (`counterparty-create.json`). */
export function counterpartyCreate(company: CompanyInput): CounterpartyCreate {
  return {
    name: company.name,
    inn: company.inn,
    gln: company.gln,
    gs1Prefixes: [...company.gs1Prefixes],
  };
}

/**
 * `PUT /v1/office/counterparties/{id}` (`counterparty-update.json`): the
 * whole record with the loaded revision; `inn: null` clears the INN.
 */
export function counterpartyUpdate(
  company: CompanyInput,
  archived: boolean,
  expectedRev: number,
): CounterpartyUpdate {
  return {
    name: company.name,
    inn: company.inn,
    gln: company.gln,
    gs1Prefixes: [...company.gs1Prefixes],
    archived,
    expectedRev,
  };
}

/**
 * An employee's fields, trimmed from a form: `role: null` for none,
 * `operatorId: null` for no operator.
 */
export interface EmployeeInput {
  name: string;
  role: string | null;
  operatorId: string | null;
}

/** `POST /v1/office/employees` (`employee-create.json`). */
export function employeeCreate(employee: EmployeeInput): EmployeeCreate {
  return { name: employee.name, role: employee.role, operatorId: employee.operatorId };
}

/**
 * `PUT /v1/office/employees/{id}` (`employee-update.json`): the whole
 * record with the loaded revision. Archiving sends `operatorId: null`
 * itself: an archived employee is linked to no operator.
 */
export function employeeUpdate(
  employee: Pick<EmployeeRecord, "rev">,
  next: EmployeeInput & { archived: boolean },
): EmployeeUpdate {
  return {
    name: next.name,
    role: next.role,
    operatorId: next.archived ? null : next.operatorId,
    archived: next.archived,
    expectedRev: employee.rev,
  };
}

/**
 * `POST /v1/office/lines` (`line-create.json`). `name` is the trimmed value
 * `lineNameRule` accepted: the builder sends it as it is.
 */
export function lineCreate(name: string): LineCreate {
  return { name };
}

/**
 * What a line is to become; `lineUpdate` sends what differs from the loaded
 * line. `name` is the trimmed value `lineNameRule` accepted.
 */
export interface LineChange {
  name: string;
  archived: boolean;
}

/**
 * `PUT /v1/office/lines/{id}` (`line-update.json`): only the fields that
 * change, with the loaded revision.
 */
export function lineUpdate(
  line: Pick<OfficeLine, "name" | "archived" | "rev">,
  next: LineChange,
): LineUpdate {
  const update: LineUpdate = { expectedRev: line.rev };
  if (next.name !== line.name) update.name = next.name;
  if (next.archived !== line.archived) update.archived = next.archived;
  return update;
}

/**
 * What a device is to become: its name, the trimmed value `deviceNameRule`
 * accepted, and, for a station, its line (`null` for none).
 */
export interface DeviceChange {
  name: string;
  lineId: string | null;
}

/**
 * `PUT /v1/office/devices/{id}` (`device-update.json`): only the fields that
 * change. Only a station has a line, so a line goes only with a station's
 * update; `lineId: null` clears it.
 */
export function deviceUpdate(
  device: Pick<DeviceRecord, "kind" | "name" | "lineId">,
  next: DeviceChange,
): DeviceUpdate {
  const update: DeviceUpdate = {};
  if (next.name !== device.name) update.name = next.name;
  if (device.kind === "station" && next.lineId !== device.lineId) update.lineId = next.lineId;
  return update;
}

/**
 * The body of «Новый код» (`pairing-code-request.json`): the code on screen,
 * which the host ends at once when the same administrator created it.
 */
export function pairingCodeRequest(replaces: string): PairingCodeRequest {
  return { replaces };
}

/**
 * A new operator: the trimmed values the form accepted, `role: null` for
 * none (`toOptionalText`), and the PIN's hash (`hashPin`), never the PIN.
 */
export interface OperatorInput {
  login: string;
  name: string;
  role: string | null;
  pinPhc: string;
}

/** `POST /v1/office/operators` (`operator-create.json`). */
export function operatorCreate(operator: OperatorInput): OperatorCreate {
  return {
    login: operator.login,
    name: operator.name,
    role: operator.role,
    pinPhc: operator.pinPhc,
  };
}

/**
 * What an operator is to become; a field left out stays as it is. `name` and
 * `role` are the trimmed values the form accepted (`role: null` for none);
 * `pinPhc` is a new PIN's hash.
 */
export interface OperatorChange {
  name?: string;
  role?: string | null;
  active?: boolean;
  pinPhc?: string;
}

/**
 * `PUT /v1/office/operators/{id}` (`operator-update.json`): only the fields
 * that differ from the loaded operator, with its revision; `role: null`
 * clears the role. A new PIN's hash always goes: its fresh salt makes every
 * hash differ, and the host keeps no PIN to compare with.
 */
export function operatorUpdate(
  operator: Pick<OfficeOperator, "name" | "role" | "active" | "rev">,
  next: OperatorChange,
): OperatorUpdate {
  const update: OperatorUpdate = { expectedRev: operator.rev };
  if (next.name !== undefined && next.name !== operator.name) update.name = next.name;
  if (next.role !== undefined && next.role !== operator.role) update.role = next.role;
  if (next.active !== undefined && next.active !== operator.active) update.active = next.active;
  if (next.pinPhc !== undefined) update.pinPhc = next.pinPhc;
  return update;
}

/**
 * A new badge: the code's hash under the site's salt (`hashBadge`), never the
 * code, and the trimmed label, `null` for none.
 */
export interface BadgeInput {
  badgePhc: string;
  label: string | null;
}

/** `POST /v1/office/operators/{id}/badges` (`badge-create.json`). */
export function badgeCreate(badge: BadgeInput): BadgeCreate {
  return { badgePhc: badge.badgePhc, label: badge.label };
}

/**
 * A product's fields: the trimmed values the form accepted, the GTIN as its
 * 14 digits (`toGtin14`), `null` for a field left blank.
 */
export interface ProductInput {
  gtin14: string;
  name: string;
  printName: string | null;
  chzProductGroupCode: number | null;
  boxCapacity: number | null;
  palletBoxCapacity: number | null;
  shelfLifeDays: number | null;
  defaultBoxTemplateId: string | null;
  defaultPalletTemplateId: string | null;
  /** The A4 sheet the pallets print on: a sheet's id, never a label template's. */
  defaultPalletSheetId: string | null;
  /** The EGAIS code (plan ТОВ): only for ЧЗ group 15, `null` otherwise. */
  egaisCode: string | null;
  /** The counterparty the shift dialog offers (plan ТОВ). */
  defaultCounterpartyId: string | null;
}

/** `POST /v1/office/products` (`product-create.json`): every field, `null` for none. */
export function productCreate(product: ProductInput): ProductCreate {
  return {
    gtin14: product.gtin14,
    name: product.name,
    printName: product.printName,
    chzProductGroupCode: product.chzProductGroupCode,
    boxCapacity: product.boxCapacity,
    palletBoxCapacity: product.palletBoxCapacity,
    shelfLifeDays: product.shelfLifeDays,
    defaultBoxTemplateId: product.defaultBoxTemplateId,
    defaultPalletTemplateId: product.defaultPalletTemplateId,
    defaultPalletSheetId: product.defaultPalletSheetId,
    egaisCode: product.egaisCode,
    defaultCounterpartyId: product.defaultCounterpartyId,
  };
}

/**
 * `PUT /v1/office/products/{id}` (`product-update.json`): the whole record
 * with `archived` and the loaded revision; `null` clears a field.
 */
export function productUpdate(
  product: ProductInput,
  archived: boolean,
  expectedRev: number,
): ProductUpdate {
  return {
    gtin14: product.gtin14,
    name: product.name,
    printName: product.printName,
    chzProductGroupCode: product.chzProductGroupCode,
    boxCapacity: product.boxCapacity,
    palletBoxCapacity: product.palletBoxCapacity,
    shelfLifeDays: product.shelfLifeDays,
    defaultBoxTemplateId: product.defaultBoxTemplateId,
    defaultPalletTemplateId: product.defaultPalletTemplateId,
    defaultPalletSheetId: product.defaultPalletSheetId,
    egaisCode: product.egaisCode,
    defaultCounterpartyId: product.defaultCounterpartyId,
    archived,
    expectedRev,
  };
}

/**
 * A new template: the trimmed name, the purpose, the categories (`null` for
 * every category) and the layout the editor checked.
 */
export interface TemplateInput {
  name: string;
  purpose: TemplatePurpose;
  enabled: boolean;
  chzProductGroupCodes: readonly number[] | null;
  spec: TemplateSpec;
}

/** `POST /v1/office/templates` (`template-create.json`). */
export function templateCreate(template: TemplateInput): TemplateCreate {
  return {
    name: template.name,
    purpose: template.purpose,
    enabled: template.enabled,
    chzProductGroupCodes:
      template.chzProductGroupCodes === null ? null : [...template.chzProductGroupCodes],
    spec: template.spec,
  };
}

/**
 * What a template is to become; a field left out stays as it is. `null`
 * categories widen the template to every category; no other field takes
 * `null`.
 */
export interface TemplateChange {
  name?: string;
  enabled?: boolean;
  chzProductGroupCodes?: readonly number[] | null;
  spec?: TemplateSpec;
}

/** Whether two category lists are the same, in the same order (`null` is every category). */
function sameCodes(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((code, index) => code === b[index]);
}

/**
 * `PUT /v1/office/templates/{id}` (`template-update.json`): the name, the
 * enabled flag and the categories that differ from the loaded template, with
 * its revision. Categories go in the order given, so a reordered list is a
 * change. A layout goes whenever one is given: comparing layouts of up to
 * 256 KB is the host's work, and an unchanged one writes nothing there.
 */
export function templateUpdate(
  template: Pick<LabelTemplate, "name" | "enabled" | "chzProductGroupCodes" | "rev">,
  next: TemplateChange,
): TemplateUpdate {
  const update: TemplateUpdate = { expectedRev: template.rev };
  if (next.name !== undefined && next.name !== template.name) update.name = next.name;
  if (next.enabled !== undefined && next.enabled !== template.enabled) {
    update.enabled = next.enabled;
  }
  if (
    next.chzProductGroupCodes !== undefined &&
    !sameCodes(next.chzProductGroupCodes, template.chzProductGroupCodes)
  ) {
    update.chzProductGroupCodes =
      next.chzProductGroupCodes === null ? null : [...next.chzProductGroupCodes];
  }
  if (next.spec !== undefined) update.spec = next.spec;
  return update;
}

/**
 * The template defaults as they are to become: each organization default
 * (`null` for none) and every category default, labels and A4 sheets.
 */
export interface TemplateDefaultsInput {
  defaultBoxTemplateId: string | null;
  defaultPalletTemplateId: string | null;
  defaultDuplicateTemplateId: string | null;
  categories: readonly CategoryTemplateDefault[];
  defaultPalletSheetId: string | null;
  palletSheetCategories: readonly CategoryPalletSheetDefault[];
}

/**
 * `PUT /v1/office/template-defaults` (`template-defaults-update.json`): the
 * whole document with the loaded revision; a category default left out is
 * cleared.
 */
export function templateDefaultsUpdate(
  defaults: TemplateDefaultsInput,
  expectedRev: number,
): TemplateDefaultsUpdate {
  return {
    defaultBoxTemplateId: defaults.defaultBoxTemplateId,
    defaultPalletTemplateId: defaults.defaultPalletTemplateId,
    defaultDuplicateTemplateId: defaults.defaultDuplicateTemplateId,
    categories: defaults.categories.map((entry) => ({
      chzProductGroupCode: entry.chzProductGroupCode,
      purpose: entry.purpose,
      templateId: entry.templateId,
    })),
    defaultPalletSheetId: defaults.defaultPalletSheetId,
    palletSheetCategories: defaults.palletSheetCategories.map((entry) => ({
      chzProductGroupCode: entry.chzProductGroupCode,
      sheetId: entry.sheetId,
    })),
    expectedRev,
  };
}

/** A shift's pallets as the office plans them (plan О-Ф): boxes on a pallet and the label template. */
export interface ShiftPallets {
  boxCapacity: number;
  templateId: string;
  /**
   * The A4 sheet (plan А4): an id names it; `null` is «the organization's
   * main sheet», which a new shift takes by leaving the field out and a
   * planned one that holds a sheet goes back to with `null` (the host
   * resolves the main sheet when it takes the edit); left out — unchanged.
   */
  sheetId?: string | null;
}

/**
 * A planned shift's fields: ids the form chose, the production date
 * `YYYY-MM-DD`, the counts the form accepted, `null` for no plan, no
 * counterparty or no pallets.
 */
export interface ShiftInput {
  productId: string;
  lineId: string;
  productionDate: string;
  boxTemplateId: string;
  boxCapacity: number;
  plannedQty: number | null;
  counterpartyId: string | null;
  pallets: ShiftPallets | null;
}

/**
 * `POST /v1/office/shifts` (`shift-create.json`, `shift-create-pallets.json`):
 * every field, `null` for none, the mode and whether pallets are collected,
 * so the host's defaults never decide what was planned; a shift with pallets
 * names their capacity and template, one without names neither.
 */
export function shiftCreate(shift: ShiftInput): ShiftCreate {
  return {
    productId: shift.productId,
    lineId: shift.lineId,
    productionDate: shift.productionDate,
    boxTemplateId: shift.boxTemplateId,
    boxCapacity: shift.boxCapacity,
    plannedQty: shift.plannedQty,
    counterpartyId: shift.counterpartyId,
    mode: "aggregation",
    ...(shift.pallets === null
      ? { palletsEnabled: false }
      : {
          palletsEnabled: true,
          palletBoxCapacity: shift.pallets.boxCapacity,
          palletTemplateId: shift.pallets.templateId,
          ...(shift.pallets.sheetId === undefined || shift.pallets.sheetId === null
            ? {}
            : { palletSheetTemplateId: shift.pallets.sheetId }),
        }),
  };
}

/**
 * What a shift is to become; a field left out stays as it is. `plannedQty`,
 * `counterpartyId` and `pallets` take `null` for none.
 */
export interface ShiftChange {
  lineId?: string;
  productionDate?: string;
  boxTemplateId?: string;
  boxCapacity?: number;
  plannedQty?: number | null;
  counterpartyId?: string | null;
  pallets?: ShiftPallets | null;
}

/**
 * `PUT /v1/office/shifts/{id}` (`shift-update.json`): only the fields that
 * differ from the loaded shift, with its revision; `null` clears the plan or
 * the counterparty. An active shift takes only its plan, which the caller
 * alone changes.
 */
export function shiftUpdate(
  shift: Pick<
    OfficeShift,
    | "lineId"
    | "productionDate"
    | "boxTemplateId"
    | "boxCapacity"
    | "plannedQty"
    | "counterpartyId"
    | "palletsEnabled"
    | "palletBoxCapacity"
    | "palletTemplateId"
    | "palletSheetTemplateId"
    | "rev"
  >,
  next: ShiftChange,
): ShiftUpdate {
  const update: ShiftUpdate = { expectedRev: shift.rev };
  if (next.lineId !== undefined && next.lineId !== shift.lineId) update.lineId = next.lineId;
  if (next.productionDate !== undefined && next.productionDate !== shift.productionDate) {
    update.productionDate = next.productionDate;
  }
  if (next.boxTemplateId !== undefined && next.boxTemplateId !== shift.boxTemplateId) {
    update.boxTemplateId = next.boxTemplateId;
  }
  if (next.boxCapacity !== undefined && next.boxCapacity !== shift.boxCapacity) {
    update.boxCapacity = next.boxCapacity;
  }
  if (next.plannedQty !== undefined && next.plannedQty !== shift.plannedQty) {
    update.plannedQty = next.plannedQty;
  }
  if (next.counterpartyId !== undefined && next.counterpartyId !== shift.counterpartyId) {
    update.counterpartyId = next.counterpartyId;
  }
  // Pallets turned off are only that: the host clears their capacity and template itself.
  if (next.pallets === null && shift.palletsEnabled) update.palletsEnabled = false;
  if (next.pallets !== undefined && next.pallets !== null) {
    if (!shift.palletsEnabled) update.palletsEnabled = true;
    if (next.pallets.boxCapacity !== shift.palletBoxCapacity) {
      update.palletBoxCapacity = next.pallets.boxCapacity;
    }
    if (next.pallets.templateId !== shift.palletTemplateId) {
      update.palletTemplateId = next.pallets.templateId;
    }
    // The main sheet (`null`) goes only from a shift that holds a sheet of
    // its own: one without keeps none, and pallets just turned on take the
    // main sheet with the field left out.
    const sheetId = next.pallets.sheetId;
    if (sheetId === null) {
      if (shift.palletSheetTemplateId !== null) update.palletSheetTemplateId = null;
    } else if (sheetId !== undefined && sheetId !== shift.palletSheetTemplateId) {
      update.palletSheetTemplateId = sheetId;
    }
  }
  return update;
}

/**
 * `POST /v1/office/shifts/{id}/close` (`shift-close.json`): the trimmed
 * reason `closeReasonRule` accepted, with the loaded revision.
 */
export function shiftClose(reason: string, expectedRev: number): ShiftClose {
  return { reason, expectedRev };
}

/**
 * What an export wrote (plan ЧЗ): its format, its line limit, its pallet
 * (`null` for a shift's export), the base `document_id` of its files, each
 * part's counts and the boxes written on no pallet because their pallet had
 * not closed.
 */
export interface ExportWritten {
  formatId: string;
  formatVersion: number;
  maxLines: number | null;
  palletId: string | null;
  documentId: string;
  parts: readonly { codeCount: number; boxCount: number; palletCount: number }[];
  openPalletSuppressedBoxCount: number;
}

/**
 * `POST /v1/office/shifts/{id}/exports` (`shift-export-record.json`): every
 * field named, the counts summed over the parts as the cloud's export
 * totals them.
 */
export function shiftExportRecord(written: ExportWritten): ShiftExportRecord {
  const total = (count: (part: ExportWritten["parts"][number]) => number) =>
    written.parts.reduce((sum, part) => sum + count(part), 0);
  return {
    formatId: written.formatId,
    formatVersion: written.formatVersion,
    maxLines: written.maxLines,
    palletId: written.palletId,
    documentId: written.documentId,
    partCount: written.parts.length,
    codeCount: total((part) => part.codeCount),
    boxCount: total((part) => part.boxCount),
    palletCount: total((part) => part.palletCount),
    openPalletSuppressedBoxCount: written.openPalletSuppressedBoxCount,
  };
}

/** What a station's new shift carries: the operator's choices and the request's id. */
export interface DeviceShiftInput {
  requestId: string;
  productId: string;
  boxTemplateId: string;
  productionDate: string;
  boxCapacity: number;
  plannedQty: number | null;
  /** «С паллетами» (plan ПЛ-Ц): boxes per pallet and the pallet template; absent — none. */
  pallets?: { boxCapacity: number; templateId: string };
}

/**
 * `POST /v1/device/shifts` (`device-shift-create.json`): every field, `null`
 * for no plan, and no counterparty, of which the station keeps no copy. The
 * line is the station's own and no field. A shift with pallets adds their
 * three fields (`device-shift-create-pallets.json`); one without sends none.
 */
export function deviceShiftCreate(shift: DeviceShiftInput): DeviceShiftCreate {
  return {
    requestId: shift.requestId,
    productId: shift.productId,
    boxTemplateId: shift.boxTemplateId,
    productionDate: shift.productionDate,
    boxCapacity: shift.boxCapacity,
    plannedQty: shift.plannedQty,
    counterpartyId: null,
    ...(shift.pallets === undefined
      ? {}
      : {
          palletsEnabled: true,
          palletBoxCapacity: shift.pallets.boxCapacity,
          palletTemplateId: shift.pallets.templateId,
        }),
  };
}

/** What a started update reports: this PC's version, the new one and the installer's SHA-256. */
export interface UpdateStartedInput {
  from: string;
  to: string;
  installerSha256: string;
}

/**
 * `POST /v1/office/updates/started` (`update-started.json`, plan ОБН-2):
 * every field named, the source given. The device is never a field: the host
 * takes the office session's.
 */
export function updateStarted(
  input: UpdateStartedInput,
  source: UpdateStarted["source"],
): UpdateStarted {
  return {
    from: input.from,
    to: input.to,
    installerSha256: input.installerSha256,
    source,
  };
}
