import { z } from "zod";

import type { HostClient } from "./client.js";
import {
  bootstrapResponseSchema,
  changesResponseSchema,
  counterpartyRecordSchema,
  deviceRecordSchema,
  officeLineSchema,
  officeSessionSchema,
  officeUserRecordSchema,
  officeUserSchema,
  orgProfileSchema,
  pairingCodeSchema,
  ssccCounterSchema,
  ssccStateSchema,
  type BlockSizesUpdate,
  type BootstrapRequest,
  type BootstrapResponse,
  type ChangesResponse,
  type CounterpartyCreate,
  type CounterpartyRecord,
  type CounterpartyUpdate,
  type DeviceRecord,
  type DeviceUpdate,
  type LineCreate,
  type LineUpdate,
  type OfficeLine,
  type OfficeLoginRequest,
  type OfficeSession,
  type OfficeUser,
  type OfficeUserCreate,
  type OfficeUserRecord,
  type OfficeUserUpdate,
  type OrgProfile,
  type OrgProfileUpdate,
  type PairingCode,
  type PairingCodeRequest,
  type PasswordChange,
  type PasswordSet,
  type SsccCounter,
  type SsccCounterUpdate,
  type SsccState,
} from "./protocol.js";

/** An SSCC counter's address: its issuer prefix and extension digit (0 box, 1 pallet). */
export interface SsccCounterKey {
  issuerPrefix: string;
  extension: number;
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
}

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
  };
}
