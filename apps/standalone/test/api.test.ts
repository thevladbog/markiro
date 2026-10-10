import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createHostApi, type HostApi } from "../src/host/api.js";
import {
  createTauriHostClient,
  HostError,
  type HostClient,
  type HttpMethod,
} from "../src/host/client.js";
import {
  badgeCreateSchema,
  bootstrapRequestSchema,
  counterpartyCreateSchema,
  counterpartyUpdateSchema,
  deviceShiftCreateSchema,
  deviceUpdateSchema,
  labelTemplateSchema,
  lineUpdateSchema,
  officeOperatorSchema,
  officeProductSchema,
  operatorCreateSchema,
  operatorUpdateSchema,
  orgProfileUpdateSchema,
  pairingCodeRequestSchema,
  productCreateSchema,
  productUpdateSchema,
  shiftCloseSchema,
  shiftCreateSchema,
  shiftExportRecordSchema,
  shiftUpdateSchema,
  templateCreateSchema,
  templateDefaultsUpdateSchema,
  templateUpdateSchema,
} from "../src/host/protocol.js";
import { fakeHostApi } from "./support/office.js";

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
const PRODUCT = officeProductSchema.parse(fixture("office-product.json"));
const PRODUCT_CREATE = productCreateSchema.parse(fixture("product-create.json"));
const PRODUCT_UPDATE = productUpdateSchema.parse(fixture("product-update.json"));
const TEMPLATE = labelTemplateSchema.parse(fixture("label-template.json"));
const TEMPLATE_CREATE = templateCreateSchema.parse(fixture("template-create.json"));
const TEMPLATE_UPDATE = templateUpdateSchema.parse(fixture("template-update.json"));
const DEFAULTS_UPDATE = templateDefaultsUpdateSchema.parse(
  fixture("template-defaults-update.json"),
);
const SHIFT_ID = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b";
const SHIFT_CREATE = shiftCreateSchema.parse(fixture("shift-create.json"));
const SHIFT_UPDATE = shiftUpdateSchema.parse(fixture("shift-update.json"));
const SHIFT_CLOSE = shiftCloseSchema.parse(fixture("shift-close.json"));
const EXPORT_RECORD = shiftExportRecordSchema.parse(fixture("shift-export-record.json"));

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
    "listProductGroups",
    [fixture("product-group.json")],
    (api) => api.listProductGroups(TOKEN),
    { method: "GET", path: "/v1/office/product-groups", body: undefined },
  ],
  [
    "listProducts",
    [fixture("office-product.json")],
    (api) => api.listProducts(TOKEN),
    { method: "GET", path: "/v1/office/products", body: undefined },
  ],
  [
    "createProduct",
    fixture("office-product.json"),
    (api) => api.createProduct(TOKEN, PRODUCT_CREATE),
    { method: "POST", path: "/v1/office/products", body: PRODUCT_CREATE },
  ],
  [
    "updateProduct",
    fixture("office-product.json"),
    (api) => api.updateProduct(TOKEN, PRODUCT.id, PRODUCT_UPDATE),
    { method: "PUT", path: `/v1/office/products/${PRODUCT.id}`, body: PRODUCT_UPDATE },
  ],
  [
    "listTemplates",
    [fixture("template-summary.json")],
    (api) => api.listTemplates(TOKEN),
    { method: "GET", path: "/v1/office/templates", body: undefined },
  ],
  [
    "getTemplate",
    fixture("label-template.json"),
    (api) => api.getTemplate(TOKEN, TEMPLATE.id),
    { method: "GET", path: `/v1/office/templates/${TEMPLATE.id}`, body: undefined },
  ],
  [
    "createTemplate",
    fixture("label-template.json"),
    (api) => api.createTemplate(TOKEN, TEMPLATE_CREATE),
    { method: "POST", path: "/v1/office/templates", body: TEMPLATE_CREATE },
  ],
  [
    "updateTemplate",
    fixture("label-template.json"),
    (api) => api.updateTemplate(TOKEN, TEMPLATE.id, TEMPLATE_UPDATE),
    { method: "PUT", path: `/v1/office/templates/${TEMPLATE.id}`, body: TEMPLATE_UPDATE },
  ],
  [
    "deleteTemplate",
    null,
    (api) => api.deleteTemplate(TOKEN, TEMPLATE.id),
    { method: "DELETE", path: `/v1/office/templates/${TEMPLATE.id}`, body: undefined },
  ],
  [
    "getTemplateDefaults",
    fixture("template-defaults.json"),
    (api) => api.getTemplateDefaults(TOKEN),
    { method: "GET", path: "/v1/office/template-defaults", body: undefined },
  ],
  [
    "updateTemplateDefaults",
    fixture("template-defaults.json"),
    (api) => api.updateTemplateDefaults(TOKEN, DEFAULTS_UPDATE),
    { method: "PUT", path: "/v1/office/template-defaults", body: DEFAULTS_UPDATE },
  ],
  [
    "listShifts",
    [fixture("office-shift.json")],
    (api) => api.listShifts(TOKEN),
    { method: "GET", path: "/v1/office/shifts", body: undefined },
  ],
  [
    "listShifts for a period",
    [fixture("office-shift.json")],
    (api) => api.listShifts(TOKEN, { from: "2026-09-01", to: "2026-10-08" }),
    { method: "GET", path: "/v1/office/shifts?from=2026-09-01&to=2026-10-08", body: undefined },
  ],
  [
    "getShift",
    fixture("office-shift.json"),
    (api) => api.getShift(TOKEN, SHIFT_ID),
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}`, body: undefined },
  ],
  [
    "createShift",
    fixture("office-shift.json"),
    (api) => api.createShift(TOKEN, SHIFT_CREATE),
    { method: "POST", path: "/v1/office/shifts", body: SHIFT_CREATE },
  ],
  [
    "updateShift",
    fixture("office-shift.json"),
    (api) => api.updateShift(TOKEN, SHIFT_ID, SHIFT_UPDATE),
    { method: "PUT", path: `/v1/office/shifts/${SHIFT_ID}`, body: SHIFT_UPDATE },
  ],
  [
    "deleteShift",
    null,
    (api) => api.deleteShift(TOKEN, SHIFT_ID),
    { method: "DELETE", path: `/v1/office/shifts/${SHIFT_ID}`, body: undefined },
  ],
  [
    "closeShift",
    fixture("office-shift.json"),
    (api) => api.closeShift(TOKEN, SHIFT_ID, SHIFT_CLOSE),
    { method: "POST", path: `/v1/office/shifts/${SHIFT_ID}/close`, body: SHIFT_CLOSE },
  ],
  [
    "getShiftExportSource",
    fixture("shift-export-rows.json"),
    (api) => api.getShiftExportSource(TOKEN, SHIFT_ID),
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}/export-source`, body: undefined },
  ],
  [
    "listShiftBoxes",
    fixture("office-boxes.json"),
    (api) => api.listShiftBoxes(TOKEN, SHIFT_ID),
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}/boxes`, body: undefined },
  ],
  [
    "listShiftPallets",
    fixture("office-pallets.json"),
    (api) => api.listShiftPallets(TOKEN, SHIFT_ID),
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}/pallets`, body: undefined },
  ],
  [
    "recordShiftExport",
    null,
    (api) => api.recordShiftExport(TOKEN, SHIFT_ID, EXPORT_RECORD),
    { method: "POST", path: `/v1/office/shifts/${SHIFT_ID}/exports`, body: EXPORT_RECORD },
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

describe("HostApi shifts", () => {
  const shift = fixture("office-shift.json");
  const notAShift = { ...(shift as object), status: "open" };

  it("returns the shifts of the list and the shift of a write as the host sent them", async () => {
    await expect(recording([shift]).api.listShifts(TOKEN)).resolves.toMatchObject([
      { number: "OCT26-004", status: "active", rev: 71 },
    ]);
    await expect(recording([]).api.listShifts(TOKEN)).resolves.toEqual([]);
    const answer = recording(shift).api;
    await expect(answer.createShift(TOKEN, SHIFT_CREATE)).resolves.toMatchObject({ rev: 71 });
    await expect(answer.updateShift(TOKEN, SHIFT_ID, SHIFT_UPDATE)).resolves.toMatchObject({
      number: "OCT26-004",
    });
    await expect(answer.closeShift(TOKEN, SHIFT_ID, SHIFT_CLOSE)).resolves.toMatchObject({
      productionDate: "2026-10-08",
    });
  });

  it("rejects a list that is no list of shifts and a write whose answer is no shift", async () => {
    await expect(recording([notAShift]).api.listShifts(TOKEN)).rejects.toThrow();
    await expect(recording(shift).api.listShifts(TOKEN)).rejects.toThrow();
    const bad = recording(notAShift).api;
    await expect(bad.createShift(TOKEN, SHIFT_CREATE)).rejects.toThrow();
    await expect(bad.updateShift(TOKEN, SHIFT_ID, SHIFT_UPDATE)).rejects.toThrow();
    await expect(bad.closeShift(TOKEN, SHIFT_ID, SHIFT_CLOSE)).rejects.toThrow();
    const list = recording([shift]).api;
    await expect(list.createShift(TOKEN, SHIFT_CREATE)).rejects.toThrow();
    await expect(list.updateShift(TOKEN, SHIFT_ID, SHIFT_UPDATE)).rejects.toThrow();
    await expect(list.closeShift(TOKEN, SHIFT_ID, SHIFT_CLOSE)).rejects.toThrow();
  });

  it("returns one shift with its figures, and rejects an answer that is a list or no shift", async () => {
    await expect(recording(shift).api.getShift(TOKEN, SHIFT_ID)).resolves.toMatchObject({
      number: "OCT26-004",
      totals: { acceptedUnits: 547, unitsInClosedBoxes: 540, closedBoxes: 45, openBoxes: 1 },
    });
    await expect(recording([shift]).api.getShift(TOKEN, SHIFT_ID)).rejects.toThrow();
    await expect(recording(notAShift).api.getShift(TOKEN, SHIFT_ID)).rejects.toThrow();
    const withoutTotals = Object.fromEntries(
      Object.entries(shift as object).filter(([key]) => key !== "totals"),
    );
    await expect(recording(withoutTotals).api.getShift(TOKEN, SHIFT_ID)).rejects.toThrow();
  });

  it("resolves a recorded export with nothing, and rejects an answer that carries a body", async () => {
    await expect(
      recording(null).api.recordShiftExport(TOKEN, SHIFT_ID, EXPORT_RECORD),
    ).resolves.toBeUndefined();
    await expect(
      recording(shift).api.recordShiftExport(TOKEN, SHIFT_ID, EXPORT_RECORD),
    ).rejects.toThrow();
  });

  it("resolves a delete with nothing, and rejects an answer that carries a body", async () => {
    await expect(recording(null).api.deleteShift(TOKEN, SHIFT_ID)).resolves.toBeUndefined();
    await expect(recording(shift).api.deleteShift(TOKEN, SHIFT_ID)).rejects.toThrow();
  });

  it("encodes both ends of a period in the query", async () => {
    const { api, sent } = recording([]);
    await api.listShifts(TOKEN, { from: "2026-09-01&to=x", to: "a b" });
    expect(sent.map((request) => request.path)).toEqual([
      "/v1/office/shifts?from=2026-09-01%26to%3Dx&to=a%20b",
    ]);
  });
});

describe("HostApi bootstrap", () => {
  it("forwards the stock templates of the request to the host unchanged", async () => {
    const request = bootstrapRequestSchema.parse(fixture("bootstrap-request-templates.json"));
    expect(request.templates?.length).toBeGreaterThan(0);
    const { api, sent } = recording(fixture("bootstrap-response.json"));
    await api.bootstrap(request);
    expect(sent).toEqual([
      { method: "POST", path: "/v1/bootstrap", body: request, officeToken: undefined },
    ]);
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

describe("HostApi device shifts", () => {
  const list = fixture("device-shifts.json");
  const entered = fixture("device-shift-entered.json");
  const CREATE = deviceShiftCreateSchema.parse(fixture("device-shift-create.json"));

  it("reads, creates and enters shifts with the device key only, no office session", async () => {
    const reading = recording(list);
    await expect(reading.api.getDeviceShifts()).resolves.toMatchObject([
      { number: "OCT26-004", status: "active" },
      { number: "OCT26-005/S", status: "planned" },
    ]);
    const creating = recording((list as { shifts: unknown[] }).shifts[1]);
    await expect(creating.api.createDeviceShift(CREATE)).resolves.toMatchObject({
      number: "OCT26-005/S",
    });
    const entering = recording(entered);
    await expect(entering.api.enterShift(SHIFT_ID)).resolves.toMatchObject({
      status: "active",
      snapshot: { issuerPrefix: "460068200" },
    });
    expect([...reading.sent, ...creating.sent, ...entering.sent]).toEqual([
      { method: "GET", path: "/v1/device/shifts", body: undefined, officeToken: undefined },
      { method: "POST", path: "/v1/device/shifts", body: CREATE, officeToken: undefined },
      {
        method: "POST",
        path: `/v1/device/shifts/${SHIFT_ID}/enter`,
        body: undefined,
        officeToken: undefined,
      },
    ]);
  });

  it("rejects a list without its shifts and an entry without its snapshot", async () => {
    await expect(
      recording({ shifts: [entered, { id: 1 }] }).api.getDeviceShifts(),
    ).rejects.toThrow();
    await expect(
      recording((list as { shifts: unknown[] }).shifts).api.getDeviceShifts(),
    ).rejects.toThrow();
    const withoutSnapshot = { ...(entered as Record<string, unknown>) };
    delete withoutSnapshot["snapshot"];
    await expect(recording(withoutSnapshot).api.enterShift(SHIFT_ID)).rejects.toThrow();
    await expect(recording(withoutSnapshot).api.createDeviceShift(CREATE)).resolves.toMatchObject({
      id: SHIFT_ID,
    });
  });

  it("reads the list as the shifts alone, in the host's order, and keeps nothing else of the answer", async () => {
    const shifts = await recording(list).api.getDeviceShifts();
    expect(shifts.map((shift) => shift.id)).toEqual(
      (list as { shifts: { id: string }[] }).shifts.map((shift) => shift.id),
    );
    await expect(recording({ shifts: [] }).api.getDeviceShifts()).resolves.toEqual([]);
  });

  /** The real client over a shell that answers `status` and `body`, with the call it made. */
  function overShell(status: number, body: unknown) {
    const call = vi.fn().mockResolvedValue({ status, body });
    return { api: createHostApi(createTauriHostClient(call)), call };
  }

  it("asks the shell for the device routes with no office token and the body the host takes", async () => {
    const reading = overShell(200, list);
    await reading.api.getDeviceShifts();
    expect(reading.call).toHaveBeenCalledWith("host_request", {
      method: "GET",
      path: "/v1/device/shifts",
      body: null,
      officeToken: null,
    });
    const creating = overShell(200, (list as { shifts: unknown[] }).shifts[1]);
    await creating.api.createDeviceShift(CREATE);
    expect(creating.call).toHaveBeenCalledWith("host_request", {
      method: "POST",
      path: "/v1/device/shifts",
      body: CREATE,
      officeToken: null,
    });
    const entering = overShell(200, entered);
    await entering.api.enterShift(SHIFT_ID);
    expect(entering.call).toHaveBeenCalledWith("host_request", {
      method: "POST",
      path: `/v1/device/shifts/${SHIFT_ID}/enter`,
      body: null,
      officeToken: null,
    });
  });

  it.each([
    ["shift_busy", 409, "entering", "error-shift-busy.json"],
    ["shift_line", 409, "entering", undefined],
    ["shift_status", 409, "entering", undefined],
    ["product_inactive", 409, "creating", undefined],
    ["template_not_fit", 409, "creating", undefined],
  ] as const)(
    "lets the refusal %s through as it came, with its status and constraint",
    async (constraint, status, what, file) => {
      const body =
        file === undefined
          ? { error: { code: "conflict", message: "refused", details: { constraint } } }
          : fixture(file);
      const { api } = overShell(status, body);
      const error: unknown = await (
        what === "entering" ? api.enterShift(SHIFT_ID) : api.createDeviceShift(CREATE)
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(HostError);
      expect(error).toMatchObject({
        kind: "api",
        code: "conflict",
        status,
        details: { constraint },
      });
    },
  );

  it("lets a refusal of the list through, and a transport failure of the shell", async () => {
    const forbidden = overShell(403, {
      error: { code: "forbidden", message: "stations only" },
    });
    await expect(forbidden.api.getDeviceShifts()).rejects.toMatchObject({
      kind: "api",
      code: "forbidden",
      status: 403,
    });
    const lost = createHostApi(createTauriHostClient(vi.fn().mockRejectedValue("unreachable")));
    await expect(lost.getDeviceShifts()).rejects.toMatchObject({
      kind: "transport",
      code: "unreachable",
    });
    await expect(lost.enterShift(SHIFT_ID)).rejects.toMatchObject({ code: "unreachable" });
    await expect(lost.createDeviceShift(CREATE)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("is stood in for by a fake that answers no shifts and refuses the writes loudly", async () => {
    const fake = fakeHostApi();
    await expect(fake.getDeviceShifts()).resolves.toEqual([]);
    await expect(fake.createDeviceShift(CREATE)).rejects.toThrow(
      "unexpected HostApi.createDeviceShift call",
    );
    await expect(fake.enterShift(SHIFT_ID)).rejects.toThrow("unexpected HostApi.enterShift call");
    // A test that stubs the list gets its own answer, not the empty one.
    const shifts = await recording(list).api.getDeviceShifts();
    const stubbed = fakeHostApi({ getDeviceShifts: vi.fn(async () => shifts) });
    await expect(stubbed.getDeviceShifts()).resolves.toBe(shifts);
    expect(stubbed.getDeviceShifts).toHaveBeenCalledTimes(1);
  });

  it("reads a host answer that fails the schema as an invalid response, not as a shift", async () => {
    const { api } = overShell(200, { shifts: [{ id: 1 }] });
    await expect(api.getDeviceShifts()).rejects.toMatchObject({
      kind: "transport",
      code: "invalid_response",
    });
  });
});
