import type {
  CounterpartyCreate,
  CounterpartyUpdate,
  DeviceRecord,
  DeviceUpdate,
  LineCreate,
  LineUpdate,
  OfficeLine,
  PairingCodeRequest,
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
