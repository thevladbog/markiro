import { z } from "zod";

import type { HostClient } from "./client.js";
import {
  bootstrapResponseSchema,
  officeSessionSchema,
  officeUserRecordSchema,
  officeUserSchema,
  orgProfileSchema,
  ssccCounterSchema,
  ssccStateSchema,
  type BlockSizesUpdate,
  type BootstrapRequest,
  type BootstrapResponse,
  type OfficeLoginRequest,
  type OfficeSession,
  type OfficeUser,
  type OfficeUserCreate,
  type OfficeUserRecord,
  type OfficeUserUpdate,
  type OrgProfile,
  type OrgProfileUpdate,
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
  };
}
