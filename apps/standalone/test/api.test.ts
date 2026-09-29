import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createHostApi, type HostApi } from "../src/host/api.js";
import type { HostClient, HttpMethod } from "../src/host/client.js";
import {
  badgeCreateSchema,
  counterpartyCreateSchema,
  counterpartyUpdateSchema,
  deviceUpdateSchema,
  lineUpdateSchema,
  officeOperatorSchema,
  operatorCreateSchema,
  operatorUpdateSchema,
  orgProfileUpdateSchema,
  pairingCodeRequestSchema,
} from "../src/host/protocol.js";

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
}

/** A client that records the request and answers `answer`, parsed by the caller's schema. */
function recording(answer: unknown) {
  const sent: Sent[] = [];
  const client: HostClient = {
    request: async (method, path, options) => {
      sent.push({ method, path, body: options.body, officeToken: options.officeToken });
      return options.schema.parse(answer);
    },
  };
  return { api: createHostApi(client), sent };
}

const TOKEN = "office-session-token";
const USER_ID = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const ORG_UPDATE = orgProfileUpdateSchema.parse(fixture("org-profile-update.json"));
const COUNTERPARTY_ID = "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e";
const LINE_ID = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const DEVICE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const COUNTERPARTY_CREATE = counterpartyCreateSchema.parse(fixture("counterparty-create.json"));
const COUNTERPARTY_UPDATE = counterpartyUpdateSchema.parse(fixture("counterparty-update.json"));
const LINE_UPDATE = lineUpdateSchema.parse(fixture("line-update.json"));
const DEVICE_UPDATE = deviceUpdateSchema.parse(fixture("device-update.json"));
const PAIRING_CODE_REQUEST = pairingCodeRequestSchema.parse(fixture("pairing-code-request.json"));
const OPERATOR = officeOperatorSchema.parse(fixture("office-operator.json"));
const OPERATOR_CREATE = operatorCreateSchema.parse(fixture("operator-create.json"));
const OPERATOR_UPDATE = operatorUpdateSchema.parse(fixture("operator-update.json"));
const BADGE_CREATE = badgeCreateSchema.parse(fixture("badge-create.json"));
const BADGE_ID = "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d";

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
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
    {
      method: "PUT",
      path: `/v1/office/users/${USER_ID}/password`,
      body: { password: "a new long password" },
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

  it("rejects a users answer that is not a list", async () => {
    const { api } = recording(fixture("office-user-record.json"));
    await expect(api.listUsers(TOKEN)).rejects.toThrow();
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
