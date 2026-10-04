import type {
  BadgeCreate,
  CategoryTemplateDefault,
  CounterpartyCreate,
  CounterpartyUpdate,
  DeviceRecord,
  DeviceUpdate,
  LabelTemplate,
  LineCreate,
  LineUpdate,
  OfficeLine,
  OfficeOperator,
  OperatorCreate,
  OperatorUpdate,
  PairingCodeRequest,
  ProductCreate,
  ProductUpdate,
  TemplateCreate,
  TemplateDefaultsUpdate,
  TemplatePurpose,
  TemplateSpec,
  TemplateUpdate,
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

/** The template defaults as they are to become: each organization default (`null` for none) and every category default. */
export interface TemplateDefaultsInput {
  defaultBoxTemplateId: string | null;
  defaultPalletTemplateId: string | null;
  defaultDuplicateTemplateId: string | null;
  categories: readonly CategoryTemplateDefault[];
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
    expectedRev,
  };
}
