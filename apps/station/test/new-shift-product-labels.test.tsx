import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { createStationClient } from "../src/lib/api-client.js";
import { DEFAULT_HARDWARE_CONFIG, type HardwareConfig } from "../src/lib/hardware-config.js";
import { NewShift, type NewShiftDraft } from "../src/pages/NewShift.js";
import { productLabelAcceptanceFixture } from "./support/product-labels.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const client = createStationClient({
  machineId: "station",
  apiKey: "test-key",
  serverUrl: "http://localhost:3000",
});
const source = { start: () => () => undefined };
const hardware: HardwareConfig = {
  ...DEFAULT_HARDWARE_CONFIG,
  printer: { kind: "usb", printer: "Existing printer" },
  printerDpi: 203,
};

async function setup(
  options: {
    hardware?: HardwareConfig;
    protocol?: boolean;
    reprocessing?: boolean;
    stale?: () => boolean;
    pendingTemplates?: Promise<Response>;
    empty?: boolean;
    failOpenOnce?: boolean;
    confirmPolicy?: boolean;
    returnNoPrint?: boolean;
  } = {},
) {
  const fixture = productLabelAcceptanceFixture({
    allowPreviouslyAcceptedCodes: options.reprocessing ?? false,
  });
  const requests: Array<{ path: string; body: unknown }> = [];
  const onStarted = vi.fn();
  const onSetup = vi.fn<(draft: NewShiftDraft) => void>();
  let verification = "required";
  let openCalls = 0;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/products/gtin-check")
      return Response.json({ gtin14: fixture.gtin14, owner: "own" });
    if (path === "/products")
      return Response.json({
        items: [{ id: fixture.shiftId, gtin14: fixture.gtin14, name: "Cola", boxCapacity: null }],
      });
    if (path === "/shifts/planning-config")
      return Response.json({
        validationPrintProtocol: options.protocol === false ? null : "validation-dm-duplicate-v1",
        ...(options.reprocessing
          ? { validationReprocessingProtocol: "validation-reprocessing-v1" }
          : {}),
      });
    if (path === "/shifts/product-label-templates")
      return (
        options.pendingTemplates ??
        Response.json({
          items: options.empty
            ? []
            : [
                {
                  id: fixture.policy.templateId,
                  name: "Product label",
                  widthMm: 58,
                  heightMm: 40,
                  dpi: 203,
                },
              ],
        })
      );
    if (path === "/shifts") {
      const body: unknown = JSON.parse(String(init?.body));
      requests.push({ path, body });
      if (typeof body === "object" && body !== null && "validationPrint" in body) {
        const print = body.validationPrint;
        if (
          typeof print === "object" &&
          print !== null &&
          "verification" in print &&
          print.verification === "none"
        )
          verification = "none";
      }
      return Response.json({
        id: fixture.shiftId,
        productionDate:
          typeof body === "object" && body !== null && "productionDate" in body
            ? body.productionDate
            : null,
      });
    }
    if (path.endsWith("/open")) {
      openCalls += 1;
      if (options.failOpenOnce && openCalls === 1) throw new TypeError("Test connection failed");
      return Response.json({
        id: fixture.shiftId,
        status: "active",
        mode: "validation",
        ...(options.confirmPolicy === false
          ? {}
          : {
              validationPrint: options.returnNoPrint
                ? {
                    mode: "none",
                    verification: "none",
                    templateId: null,
                    snapshot: null,
                    policyRevision: null,
                  }
                : { ...fixture.policy, verification },
            }),
      });
    }
    throw new Error(`Unexpected test request: ${path}`);
  });
  const view = render(
    <NewShift
      client={client}
      source={source}
      hardwareConfig={options.hardware ?? hardware}
      onSetup={onSetup}
      {...(options.stale ? { isCurrent: options.stale } : {})}
      onStarted={onStarted}
      onBack={() => undefined}
    />,
  );
  const input = screen.getByLabelText("Type or scan a GTIN");
  fireEvent.change(input, { target: { value: fixture.gtin14 } });
  const form = input.closest("form");
  if (!form) throw new Error("Missing product form");
  fireEvent.submit(form);
  await screen.findByText("Cola");
  fireEvent.click(screen.getByRole("button", { name: "Label printing: No printing" }));
  await screen.findByLabelText("Print duplicate Data Matrix");
  return { ...view, fixture, requests, onStarted, onSetup, fetchSpy };
}

it.each(["required", "none"])(
  "creates a duplicate shift with %s verification and publishes the authoritative policy",
  async (verification) => {
    const h = await setup();
    await waitFor(() =>
      expect(screen.getByLabelText("Print duplicate Data Matrix").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByLabelText("Print duplicate Data Matrix"));
    expect(
      screen.getByRole("checkbox", { name: "Require label verification", checked: true }),
    ).toBeDefined();
    if (verification === "none")
      fireEvent.click(screen.getByLabelText("Require label verification"));
    fireEvent.click(screen.getByRole("button", { name: "Select a template" }));
    fireEvent.click(await screen.findByRole("button", { name: /Product label/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("button", { name: "Production date" })).toBeDefined();
    expect(h.requests).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(h.onStarted).toHaveBeenCalledWith(
        expect.objectContaining({ validationPrint: { ...h.fixture.policy, verification } }),
      ),
    );
    expect(h.requests).toEqual([
      {
        path: "/shifts",
        body: expect.objectContaining({
          validationPrint: {
            mode: "duplicate_dm",
            verification,
            templateId: h.fixture.policy.templateId,
          },
        }),
      },
    ]);
  },
);

it("does not create a printing shift with an unconfigured printer and offers settings", async () => {
  const h = await setup({ hardware: DEFAULT_HARDWARE_CONFIG });
  await waitFor(() =>
    expect(screen.getByLabelText("Print duplicate Data Matrix").hasAttribute("disabled")).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByLabelText("Print duplicate Data Matrix"));
  fireEvent.click(screen.getByRole("button", { name: "Select a template" }));
  fireEvent.click(await screen.findByRole("button", { name: /Product label/ }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText(
    "Configure the printer and its resolution before starting duplicate printing.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Printer settings" }));
  expect(h.onSetup).toHaveBeenCalledTimes(1);
  expect(h.requests).toEqual([]);
});

it("keeps printing disabled when the server does not offer the protocol", async () => {
  const h = await setup({ protocol: false });
  await screen.findByText("Duplicate printing is not available for this station.");
  expect(screen.getByLabelText("Print duplicate Data Matrix").hasAttribute("disabled")).toBe(true);
  expect(h.requests).toEqual([]);
});

it("does not reopen a retired route when its template response arrives", async () => {
  let resolve: (response: Response) => void = () => undefined;
  const pending = new Promise<Response>((settle) => {
    resolve = settle;
  });
  const h = await setup({ pendingTemplates: pending });
  await waitFor(() =>
    expect(screen.getByLabelText("Print duplicate Data Matrix").hasAttribute("disabled")).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByLabelText("Print duplicate Data Matrix"));
  fireEvent.click(screen.getByRole("button", { name: "Select a template" }));
  h.unmount();
  await act(async () => {
    resolve(Response.json({ items: [] }));
  });
  expect(h.onStarted).not.toHaveBeenCalled();
  expect(h.requests).toEqual([]);
});

async function selectDuplicateTemplate({ apply = true } = {}) {
  await waitFor(() =>
    expect(screen.getByLabelText("Print duplicate Data Matrix").hasAttribute("disabled")).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByLabelText("Print duplicate Data Matrix"));
  fireEvent.click(screen.getByRole("button", { name: "Select a template" }));
  fireEvent.click(await screen.findByRole("button", { name: /Product label/ }));
  if (apply) fireEvent.click(screen.getByRole("button", { name: "Apply" }));
}

it("returns to the production date without creating a shift and starts with the reviewed date", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
  const h = await setup();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "Production date" }));
  fireEvent.click(screen.getByRole("button", { name: "September 8, 2026" }));
  const selectedDate = screen.getByRole("button", { name: "Production date" }).textContent;
  fireEvent.click(screen.getByRole("button", { name: "Label printing: No printing" }));
  await selectDuplicateTemplate({ apply: false });
  expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(screen.getByRole("button", { name: "Production date" }).textContent).toBe(selectedDate);
  expect(
    screen.getByRole("button", { name: "Label printing: Data Matrix duplicate" }),
  ).toBeDefined();
  expect(h.requests).toEqual([]);
  expect(h.onStarted).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Production date" }));
  fireEvent.click(screen.getByRole("button", { name: "September 9, 2026" }));
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(h.onStarted).toHaveBeenCalledTimes(1));
  expect(h.requests).toEqual([
    {
      path: "/shifts",
      body: expect.objectContaining({
        productionDate: "2026-09-09",
        validationPrint: {
          mode: "duplicate_dm",
          templateId: h.fixture.policy.templateId,
          verification: "required",
        },
      }),
    },
  ]);
});

it("reuses the known created shift when retrying a failed open", async () => {
  const h = await setup({ failOpenOnce: true });
  await selectDuplicateTemplate();
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(h.requests).toHaveLength(1));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start" }).hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(h.onStarted).toHaveBeenCalledTimes(1));
  expect(h.requests).toHaveLength(1);
});

it("refuses a template disabled since it was selected", async () => {
  const options = { empty: false };
  const h = await setup(options);
  await selectDuplicateTemplate();
  options.empty = true;
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("The selected template is no longer available. Choose another one.");
  expect(h.requests).toEqual([]);
  expect(h.onStarted).not.toHaveBeenCalled();
});

it("refuses to enter an opened shift without the authoritative print snapshot", async () => {
  const h = await setup({ confirmPolicy: false });
  await selectDuplicateTemplate();
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText(
    "The server did not confirm printing settings. Open the shift from the list after checking its settings.",
  );
  expect(h.requests).toHaveLength(1);
  expect(h.onStarted).not.toHaveBeenCalled();
});

it("starts duplicate printing on a 300 dpi printer with a template authored at 203 dpi", async () => {
  const h = await setup({ hardware: { ...hardware, printerDpi: 300 } });
  await selectDuplicateTemplate();
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(h.onStarted).toHaveBeenCalledTimes(1));
  expect(h.requests).toEqual([
    {
      path: "/shifts",
      body: expect.objectContaining({
        validationPrint: {
          mode: "duplicate_dm",
          verification: "required",
          templateId: h.fixture.policy.templateId,
        },
      }),
    },
  ]);
  expect(screen.queryByText(/printer resolution does not match/)).toBeNull();
});

it("keeps draft settings between steps and restores applied settings when reopening", async () => {
  await setup();
  await selectDuplicateTemplate({ apply: false });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Require label verification").hasAttribute("disabled")).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByLabelText("Require label verification"));
  fireEvent.click(screen.getByRole("button", { name: "Select a template" }));
  expect(
    (await screen.findByRole("button", { name: /Product label/ })).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  fireEvent.click(screen.getByRole("button", { name: "Label printing: Data Matrix duplicate" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Require label verification").hasAttribute("disabled")).toBe(
      false,
    ),
  );
  expect(
    screen.getByRole("checkbox", { name: "Require label verification", checked: false }),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Select a template" }));
  expect(
    (await screen.findByRole("button", { name: /Product label/ })).getAttribute("aria-pressed"),
  ).toBe("true");
});

it("discards disabled printing on Back and starts with the applied duplicate policy", async () => {
  const h = await setup();
  await selectDuplicateTemplate();
  fireEvent.click(screen.getByRole("button", { name: "Label printing: Data Matrix duplicate" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Print duplicate Data Matrix").hasAttribute("disabled")).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByLabelText("Require label verification"));
  fireEvent.click(screen.getByLabelText("Print duplicate Data Matrix"));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));

  expect(
    screen.getByRole("button", { name: "Label printing: Data Matrix duplicate" }),
  ).toBeDefined();
  expect(h.requests).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(h.onStarted).toHaveBeenCalledTimes(1));
  expect(h.requests).toEqual([
    {
      path: "/shifts",
      body: expect.objectContaining({
        validationPrint: {
          mode: "duplicate_dm",
          templateId: h.fixture.policy.templateId,
          verification: "required",
        },
      }),
    },
  ]);
});

it.each([false, true])(
  "discards an unapplied duplicate policy and keeps explicit no-print=%s",
  async (explicit) => {
    const h = await setup({ returnNoPrint: true });
    await waitFor(() =>
      expect(screen.getByLabelText("Print duplicate Data Matrix").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: explicit ? "Apply" : "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Label printing: No printing" }));
    await selectDuplicateTemplate({ apply: false });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Label printing: No printing" })).toBeDefined();
    expect(h.requests).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(h.onStarted).toHaveBeenCalledTimes(1));
    expect(h.requests).toHaveLength(1);
    if (explicit) expect(h.requests[0]?.body).toMatchObject({ validationPrint: { mode: "none" } });
    else expect(h.requests[0]?.body).not.toHaveProperty("validationPrint");
  },
);

it("drops a start after the credential generation is retired", async () => {
  let current = true;
  const h = await setup({ stale: () => current });
  await selectDuplicateTemplate();
  current = false;
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  expect(h.requests).toEqual([]);
  expect(h.onStarted).not.toHaveBeenCalled();
});

it("prevents two synchronous Start clicks from creating two shifts", async () => {
  const h = await setup();
  await selectDuplicateTemplate();
  const start = screen.getByRole("button", { name: "Start" });
  act(() => {
    start.click();
    start.click();
  });
  await waitFor(() => expect(h.onStarted).toHaveBeenCalledTimes(1));
  expect(h.requests).toHaveLength(1);
});

it("restores the selected product and template after printer setup", async () => {
  const h = await setup({ hardware: DEFAULT_HARDWARE_CONFIG });
  await selectDuplicateTemplate();
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  fireEvent.click(await screen.findByRole("button", { name: "Printer settings" }));
  const draft = h.onSetup.mock.calls[0]?.[0];
  if (!draft) throw new Error("Missing setup handoff");
  h.unmount();
  render(
    <NewShift
      client={client}
      source={source}
      hardwareConfig={hardware}
      initialDraft={draft}
      onStarted={h.onStarted}
      onBack={() => undefined}
    />,
  );
  expect(screen.getByRole("button", { name: "Production date" })).toBeDefined();
  expect(
    screen.getByRole("button", { name: "Label printing: Data Matrix duplicate" }),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(h.onStarted).toHaveBeenCalledTimes(1));
  expect(h.requests).toHaveLength(1);
});

it("keeps Apply disabled when no eligible templates are available", async () => {
  const h = await setup({ empty: true });
  await waitFor(() =>
    expect(screen.getByLabelText("Print duplicate Data Matrix").hasAttribute("disabled")).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByLabelText("Print duplicate Data Matrix"));
  fireEvent.click(screen.getByRole("button", { name: "Select a template" }));
  await screen.findByText("No label templates in the admin panel. Create one and try again.");
  expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
  expect(h.requests).toEqual([]);
});

it("allows retry after losing the network before creating the shift", async () => {
  const h = await setup();
  await selectDuplicateTemplate();
  h.fetchSpy.mockRejectedValueOnce(new TypeError("Test network disconnected"));
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("Action failed. Please try again.");
  expect(h.requests).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(h.onStarted).toHaveBeenCalledTimes(1));
  expect(h.requests).toHaveLength(1);
});

it("does not enter a server printing policy when the operator selected no printing", async () => {
  const h = await setup();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText(
    "The server did not confirm printing settings. Open the shift from the list after checking its settings.",
  );
  expect(h.onStarted).not.toHaveBeenCalled();
});

it("sends an explicit no-print policy when printing is disabled in settings", async () => {
  const h = await setup({ returnNoPrint: true });
  await waitFor(() =>
    expect(screen.getByLabelText("Print duplicate Data Matrix").hasAttribute("disabled")).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByLabelText("Print duplicate Data Matrix"));
  fireEvent.click(screen.getByLabelText("Print duplicate Data Matrix"));
  expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(screen.getByRole("button", { name: "Production date" })).toBeDefined();
  expect(h.requests).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(h.onStarted).toHaveBeenCalledTimes(1));
  expect(h.requests).toEqual([
    { path: "/shifts", body: expect.objectContaining({ validationPrint: { mode: "none" } }) },
  ]);
});

it("creates an enabled repeat shift only after selecting the negotiated setting", async () => {
  const h = await setup({ reprocessing: true });
  await waitFor(() =>
    expect(screen.getByLabelText("Print duplicate Data Matrix").hasAttribute("disabled")).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByLabelText("Print duplicate Data Matrix"));
  const repeat = screen.getByLabelText("Allow reprocessing codes from previous shifts");
  expect((repeat as HTMLInputElement).checked).toBe(false);
  fireEvent.click(repeat);
  fireEvent.click(screen.getByRole("button", { name: "Select a template" }));
  fireEvent.click(await screen.findByRole("button", { name: /Product label/ }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(h.onStarted).toHaveBeenCalled());
  expect(h.requests[0]?.body).toMatchObject({
    validationPrint: { allowPreviouslyAcceptedCodes: true },
  });
});
