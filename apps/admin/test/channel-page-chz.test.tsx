/**
 * The `chestny_znak` channel page's own settings form -- the СУЗ pair
 * (`omsId` + `omsConnection`) and the default contact person that go out
 * with every code order.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `integrations-channel.test.tsx`: that
 * file is about the page shell shared by every channel (journal, credentials,
 * deletion, capability gating) and covers `chestny_znak` only through its
 * МЧД ИНН field. The rules asserted here are specific to one server contract
 * and deserve to fail by name:
 *
 *  - `chzSignerSettingsSchema` (apps/api/src/modules/integrations/
 *    channel-registry.ts) refines `omsId`/`omsConnection` to be present
 *    together or absent together, and `updateChannel` validates THE PATCH
 *    BODY, not the result of merging that body into the stored settings. A
 *    form that posts only the field the operator touched gets a 400 for a
 *    pair that is perfectly consistent in the database -- so every save must
 *    carry both values.
 *  - Those identifiers are NOT RFC 4122 UUIDs. СУЗ documents them as plain
 *    hex (`11b1abc1-f1ee-11db-1a11-f11ac11111e1`, whose variant nibble `1`
 *    no strict UUID validator accepts), which is exactly why the server uses
 *    `z.guid()` and not `z.uuid()`. The client-side check must not be
 *    stricter than the server's.
 *
 * Own `renderChannel` + fetch stub, following this repository's convention
 * that every admin test declares its own (see the same note in
 * `integrations-channel.test.tsx`).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { ChannelPage } from "../src/pages/integrations/ChannelPage.js";
import { jsonResponse } from "./helpers/http.js";

/** СУЗ's own documented example -- hex-shaped, not a valid RFC 4122 UUID. */
const OMS_ID = "11b1abc1-f1ee-11db-1a11-f11ac11111e1";
const OMS_CONNECTION = "22c2bcd2-a2ff-22ec-2b22-a22bd22222f2";
const MCHD_INN = "7707083893";

const patchSpy = vi.fn();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  patchSpy.mockClear();
});

const ADMIN_ACCESS: AccessDocument = {
  roles: ["admin"],
  capabilities: [
    CABINET_CAPABILITY.INTEGRATIONS_READ,
    CABINET_CAPABILITY.INTEGRATIONS_WRITE,
    CABINET_CAPABILITY.CREDENTIALS_MANAGE,
  ],
};

const NO_TOKEN = {
  status: "none",
  tokenType: null,
  obtainedAt: null,
  expiresAt: null,
  certThumbprint: null,
};

function renderChannel(settings: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^\/api/, "");
    const method = init?.method ?? "GET";

    if (method === "PATCH") {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      patchSpy(path, body);
      return jsonResponse(200, { ...detail(settings), settings: { ...settings, ...body } });
    }
    if (method === "GET" && /\/journal(?:\?|$)/.test(path)) {
      return jsonResponse(200, {
        timeZone: "Europe/Moscow",
        sessions: [],
        pageInfo: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      });
    }
    if (method === "GET" && path === "/signer-agents") {
      return jsonResponse(200, {
        agents: [],
        token: NO_TOKEN,
        omsToken: NO_TOKEN,
        refreshTask: null,
      });
    }
    if (method === "GET" && path === "/integrations/chestny_znak/code-statuses") {
      return jsonResponse(200, {
        total: 0,
        refreshedLastDay: 0,
        withoutProductGroup: 0,
        lastCheckedAt: null,
      });
    }
    return jsonResponse(200, detail(settings));
  });
  vi.stubGlobal("fetch", fetchMock);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider value={ADMIN_ACCESS}>
        <MemoryRouter initialEntries={["/integrations/chestny_znak"]}>
          <Routes>
            <Route path="/integrations/:type" element={<ChannelPage />} />
          </Routes>
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
}

function detail(settings: Record<string, unknown>) {
  return {
    type: "chestny_znak",
    labelKey: "integrations.channel.chestnyZnak",
    state: "working",
    lastEventAt: null,
    settings,
    silentAfterHours: 48,
    credentialLogin: null,
  };
}

const CONFIGURED = {
  environment: "sandbox",
  mchdInn: MCHD_INN,
  omsId: OMS_ID,
  omsConnection: OMS_CONNECTION,
};

function omsIdField(): HTMLElement {
  return screen.getByLabelText(/идентификатор СУЗ|SUZ identifier/i);
}

function omsConnectionField(): HTMLElement {
  return screen.getByLabelText(/подключение СУЗ|SUZ connection/i);
}

function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: /^сохранить$|^save$/i });
}

describe("Chestny ZNAK channel settings — СУЗ identifiers", () => {
  it("renders the СУЗ pair, the contact person and the registration hint", async () => {
    renderChannel(CONFIGURED);

    expect(await screen.findByLabelText(/идентификатор СУЗ|SUZ identifier/i)).toBeDefined();
    // `register` writes the stored value onto the element, not onto a `value`
    // attribute -- read the live property, the way an operator sees it.
    expect((omsIdField() as HTMLInputElement).value).toBe(OMS_ID);
    expect((omsConnectionField() as HTMLInputElement).value).toBe(OMS_CONNECTION);
    expect(screen.getByLabelText(/контактное лицо|contact person/i)).toBeDefined();
    expect(screen.getByText(/Настройки → Устройства|Settings → Devices/i).textContent).toMatch(
      /СУЗ|SUZ/,
    );
  });

  /**
   * The whole point: the operator edits ONE field, but the body still carries
   * both identifiers, because the server validates the patch in isolation.
   */
  it("resends both identifiers when only the contact person changed", async () => {
    renderChannel(CONFIGURED);

    await userEvent.type(
      await screen.findByLabelText(/контактное лицо|contact person/i),
      "Иванова Мария",
    );
    await userEvent.click(saveButton());

    expect(patchSpy).toHaveBeenCalledWith("/integrations/chestny_znak", {
      mchdInn: MCHD_INN,
      omsId: OMS_ID,
      omsConnection: OMS_CONNECTION,
      omsContactPerson: "Иванова Мария",
    });
  });

  it("accepts the hex-shaped identifier СУЗ documents", async () => {
    renderChannel({ mchdInn: MCHD_INN });

    await userEvent.type(await screen.findByLabelText(/идентификатор СУЗ|SUZ identifier/i), OMS_ID);
    await userEvent.type(omsConnectionField(), OMS_CONNECTION);
    await userEvent.click(saveButton());

    expect(patchSpy).toHaveBeenCalledWith("/integrations/chestny_znak", {
      mchdInn: MCHD_INN,
      omsId: OMS_ID,
      omsConnection: OMS_CONNECTION,
    });
  });

  it("refuses to send one identifier without the other", async () => {
    renderChannel({ mchdInn: MCHD_INN });

    await userEvent.type(await screen.findByLabelText(/идентификатор СУЗ|SUZ identifier/i), OMS_ID);
    await userEvent.click(saveButton());

    const connection = omsConnectionField();
    expect(connection.getAttribute("aria-invalid")).toBe("true");
    const describedBy = connection.getAttribute("aria-describedby") ?? "";
    expect(describedBy).not.toBe("");
    expect(document.getElementById(describedBy)?.textContent).toMatch(
      /только вместе|saved together/i,
    );
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("reports a malformed identifier on its own field and sends nothing", async () => {
    renderChannel({ mchdInn: MCHD_INN });

    await userEvent.type(
      await screen.findByLabelText(/идентификатор СУЗ|SUZ identifier/i),
      "not-a-guid",
    );
    await userEvent.type(omsConnectionField(), OMS_CONNECTION);
    await userEvent.click(saveButton());

    const identifier = omsIdField();
    expect(identifier.getAttribute("aria-invalid")).toBe("true");
    const describedBy = identifier.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toContain(OMS_ID);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  /**
   * Clearing both fields would post neither key, and `updateChannel` merges
   * (`settings || patch`), so the stored pair would survive untouched while
   * the operator watched a success toast. Report it instead of lying.
   */
  it("refuses to clear a saved pair", async () => {
    renderChannel(CONFIGURED);

    await userEvent.clear(await screen.findByLabelText(/идентификатор СУЗ|SUZ identifier/i));
    await userEvent.clear(omsConnectionField());
    await userEvent.click(saveButton());

    expect(omsIdField().getAttribute("aria-invalid")).toBe("true");
    expect(patchSpy).not.toHaveBeenCalled();
  });
});
