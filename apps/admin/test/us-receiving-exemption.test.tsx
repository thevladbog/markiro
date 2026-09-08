import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { StrictMode, useState } from "react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReceivingDraftItem } from "@markiro/platform-contracts";
import { receivingRecordSchema, type ReceivingRecord } from "@markiro/platform-contracts";
import { liveReadFixtureResponse } from "./support/us-receiving-live-fixture.js";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { ReceivingExemptionFields } from "../src/us/receiving/exemption-fields.js";
import { ReceivingView } from "../src/us/receiving/view.js";
import {
  eventId,
  exemptionFinalized,
  exemptionReadiness,
  exemptionRecord,
  previousLocation,
  previousLocationId,
  product,
  productId,
  receivingLocation,
  receivingLocationId,
  receivingPath,
} from "./support/us-receiving-exemption-fixture.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function resources() {
  return {
    "en-US": { translation: masterDataCopy["en-US"] },
    "es-US": { translation: masterDataCopy["es-US"] },
  };
}

async function i18n(locale: "en-US" | "es-US" = "en-US") {
  const instance = i18next.createInstance();
  await instance.init({
    resources: resources(),
    lng: locale,
    fallbackLng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  return instance;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function summary(status: "draft" | "finalized" = "draft") {
  const { draft, ...header } = exemptionRecord;
  return {
    ...header,
    status,
    dateReceived: draft.dateReceived,
    locationId: draft.locationId,
    previousSourceLocationId: draft.previousSourceLocationId,
    lineCount: draft.items.length,
    documentCount: draft.documentIds.length,
  };
}

async function setup(
  options: {
    locale?: "en-US" | "es-US";
    qa?: boolean;
    finalized?: boolean;
    handle?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  } = {},
) {
  let current: ReceivingRecord = receivingRecordSchema.parse(
    options.finalized ? exemptionFinalized : exemptionRecord,
  );
  const source: typeof fetch = async (input, init) => {
    const url = String(input);
    const custom = options.handle?.(url, init);
    if (custom) return custom;
    if (url.startsWith(`${receivingPath}?`))
      return json({
        items: [summary(options.finalized ? "finalized" : "draft")],
        limit: 50,
        offset: 0,
      });
    if (url === `${receivingPath}/${eventId}`) return json(current);
    if (url.includes("/readiness")) return json(exemptionReadiness);
    if (url.endsWith("/finalize")) return json(exemptionFinalized);
    if (url === `/api/us/traceability/catalog/products/${productId}`) return json(product);
    if (url === `/api/us/traceability/locations/${receivingLocationId}`)
      return json(receivingLocation);
    if (url === `/api/us/traceability/locations/${previousLocationId}`)
      return json(previousLocation);
    if (url.startsWith("/api/us/traceability/catalog/products?"))
      return json({ items: [product], limit: 50, offset: 0 });
    if (url.startsWith("/api/us/traceability/locations?"))
      return json({ items: [receivingLocation, previousLocation], limit: 50, offset: 0 });
    if (url.startsWith("/api/us/traceability/lots?"))
      return json({ items: [], limit: 50, offset: 0 });
    return json({ items: [], limit: 50, offset: 0 });
  };
  const send = vi.fn<typeof fetch>(async (url, init) => {
    const response = await source(url, init);
    if (init?.method && init.method !== "GET" && response.ok) {
      const parsed = receivingRecordSchema.safeParse(await response.clone().json());
      if (parsed.success) current = parsed.data;
    }
    return liveReadFixtureResponse(url, init, response);
  });
  const instance = await i18n(options.locale);
  const onSessionLost = vi.fn();
  const onForbidden = vi.fn(async () => {});
  const props = {
    client: createUsBrowserClient(send),
    canWrite: true,
    canManageQa: options.qa ?? true,
    mutationPending: false,
    beginMutation: () => () => {},
    onDirtyChange: vi.fn(),
    onForbidden,
    onSessionLost,
    onNotice: vi.fn(),
    onClientFailure: vi.fn(),
    timeZone: exemptionRecord.timeZone,
    onOpenLot: vi.fn(),
  };
  const tree = (qa = props.canManageQa) => (
    <StrictMode>
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>
          <ReceivingView {...props} canManageQa={qa} />
        </I18nextProvider>
      </ThemeProvider>
    </StrictMode>
  );
  const view = render(tree());
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: exemptionRecord.eventNumber }));
  await screen.findByRole("heading", { name: exemptionRecord.eventNumber });
  return { user, send, instance, tree, onSessionLost, onForbidden, ...view };
}

function FieldsHarness({ initial }: { initial: ReceivingDraftItem }) {
  const [value, setValue] = useState(initial);
  return (
    <ReceivingExemptionFields
      value={value}
      receivingLocationId={receivingLocationId}
      receivingLocationLabel={receivingLocation.name}
      disabled={false}
      onChange={setValue}
    />
  );
}

function ChangingSiteHarness({ initial }: { initial: ReceivingDraftItem }) {
  const [value, setValue] = useState(initial);
  const [site, setSite] = useState(receivingLocationId);
  return (
    <>
      <button type="button" onClick={() => setSite(previousLocationId)}>
        Change receiving site
      </button>
      <ReceivingExemptionFields
        value={value}
        receivingLocationId={site}
        receivingLocationLabel={
          site === receivingLocationId ? receivingLocation.name : previousLocation.name
        }
        disabled={false}
        onChange={setValue}
      />
    </>
  );
}

describe("Receiving exempt-supplier editor", () => {
  it("accepts a contract-valid 120-code-point supplementary Unicode proposal without truncation", async () => {
    const instance = await i18n();
    render(
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>
          <FieldsHarness initial={exemptionRecord.draft.items[1]!} />
        </I18nextProvider>
      </ThemeProvider>,
    );
    const user = userEvent.setup();
    const proposal = screen.getByLabelText("Proposed TLC for own assignment");
    const valid = "🚀".repeat(120);

    await user.clear(proposal);
    await user.type(proposal, valid);

    expect(proposal).toHaveProperty("value", valid);
    expect(Array.from((proposal as HTMLInputElement).value)).toHaveLength(120);
  });

  it("keeps received identity separate when switching paths and requires explicit source correction", async () => {
    const instance = await i18n();
    const item = exemptionRecord.draft.items[0]!;
    render(
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>
          <FieldsHarness initial={item} />
        </I18nextProvider>
      </ThemeProvider>,
    );
    const user = userEvent.setup();
    expect(screen.getByLabelText("Supporting evidence URL")).toHaveProperty(
      "value",
      item.exemptReceipt?.evidenceUrl,
    );
    expect(screen.getByRole("radio", { name: "Existing TLC" }).getAttribute("data-state")).toBe(
      "checked",
    );
    expect(screen.queryByLabelText("Proposed TLC for own assignment")).toBeNull();

    await user.click(screen.getByRole("radio", { name: "No TLC assigned" }));
    expect(screen.getByLabelText("Proposed TLC for own assignment")).toBeTruthy();
    expect(screen.getByText(/does not match the receiving location/i)).toBeTruthy();
    await user.type(screen.getByLabelText("Proposed TLC for own assignment"), "OWN-01");
    await user.click(screen.getByRole("radio", { name: "Existing TLC" }));
    expect(screen.queryByLabelText("Proposed TLC for own assignment")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "No TLC assigned" }));
    expect(screen.getByLabelText("Proposed TLC for own assignment")).toHaveProperty(
      "value",
      "OWN-01",
    );
  });

  it("shows connected saved inputs and never activates hidden exemption data", async () => {
    const { user, send } = await setup();
    expect(screen.getByLabelText("Supporting evidence URL")).toHaveProperty(
      "value",
      exemptionRecord.draft.items[0]!.exemptReceipt?.evidenceUrl,
    );
    await user.click(screen.getByRole("checkbox", { name: "Exempt supplier" }));
    expect(screen.queryByLabelText("Supporting evidence URL")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    const write = send.mock.calls.find(([, init]) => init?.method === "PUT");
    const saved = JSON.parse(String(write?.[1]?.body));
    expect(saved.draft.items[0].exemptSupplier).toBe(false);
    expect(saved.draft.items[0].exemptReceipt).toEqual(
      exemptionRecord.draft.items[0]!.exemptReceipt,
    );
  });

  it("does not silently rewrite an own-assignment source after the receiving site changes", async () => {
    const instance = await i18n();
    render(
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>
          <ChangingSiteHarness initial={exemptionRecord.draft.items[1]!} />
        </I18nextProvider>
      </ThemeProvider>,
    );
    const user = userEvent.setup();
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change receiving site" }));
    expect(screen.getByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("does not match the receiving location"),
    );
    await user.click(screen.getByRole("button", { name: "Use receiving location as TLC source" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(previousLocation.name)).toBeTruthy();
  });

  it.each(["success", "failure", "obsolete"] as const)(
    "binds the connected physical-source label to the selected site during a delayed %s lookup",
    async (outcome) => {
      const nextLocation = {
        ...receivingLocation,
        id: "c0000000-0000-4000-8000-000000000099",
        name: "South receiving dock",
      };
      const replies: ((response: Response) => void)[] = [];
      const { user } = await setup({
        handle: (url) => {
          if (url === `/api/us/traceability/locations/${nextLocation.id}`)
            return new Promise<Response>((resolve) => replies.push(resolve));
          if (url.startsWith("/api/us/traceability/locations?"))
            return json({
              items: [receivingLocation, previousLocation, nextLocation],
              limit: 50,
              offset: 0,
            });
          return undefined;
        },
      });
      await user.click(screen.getByRole("button", { name: /^Line 2/ }));
      const sourceSummary = () =>
        screen.getByText("Physical TLC source at finalization").parentElement;
      await waitFor(() =>
        expect(sourceSummary()).toHaveProperty(
          "textContent",
          expect.stringContaining(receivingLocation.name),
        ),
      );
      const site = screen.getByRole("combobox", { name: "Receiving location" });
      await waitFor(() => expect(site).toHaveProperty("disabled", false));
      await user.selectOptions(site, nextLocation.id);
      await waitFor(() => expect(replies).toHaveLength(2));
      expect(sourceSummary()).toHaveProperty(
        "textContent",
        expect.stringContaining(nextLocation.id),
      );
      expect(sourceSummary()?.textContent).not.toContain(receivingLocation.name);

      if (outcome === "obsolete") {
        // The picker request starts before the editor's independent label lookup.
        // Finish only the picker so a real user can change the selected site again.
        await act(async () => replies[0]?.(json(nextLocation)));
        await waitFor(() => expect(site).toHaveProperty("disabled", false));
        await user.selectOptions(site, receivingLocationId);
        await waitFor(() =>
          expect(sourceSummary()).toHaveProperty(
            "textContent",
            expect.stringContaining(receivingLocation.name),
          ),
        );
        await act(async () => replies[1]?.(json(nextLocation)));
        expect(sourceSummary()?.textContent).not.toContain(nextLocation.name);
        expect(sourceSummary()?.textContent).toContain(receivingLocation.name);
      } else {
        await act(async () => {
          for (const reply of replies)
            reply(outcome === "success" ? json(nextLocation) : json({ code: "unavailable" }, 503));
        });
        expect(sourceSummary()).toHaveProperty(
          "textContent",
          expect.stringContaining(outcome === "success" ? nextLocation.name : nextLocation.id),
        );
        expect(sourceSummary()?.textContent).not.toContain(receivingLocation.name);
      }
    },
  );

  it.each([undefined, null])("opens a saved exempt line with %s extension", async (extension) => {
    const instance = await i18n();
    const legacy = Object.fromEntries(
      Object.entries(exemptionRecord.draft.items[0]!).filter(([key]) => key !== "exemptReceipt"),
    ) as ReceivingDraftItem;
    const initial = extension === undefined ? legacy : { ...legacy, exemptReceipt: extension };
    render(
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>
          <FieldsHarness initial={initial} />
        </I18nextProvider>
      </ThemeProvider>,
    );
    expect(screen.getByLabelText("Supporting evidence URL")).toHaveProperty("value", "");
    expect(screen.queryByLabelText("Proposed TLC for own assignment")).toBeNull();
  });

  it("keeps connected exempt input and retry identity after a mismatched save acknowledgement", async () => {
    const changedResponse = {
      ...exemptionRecord,
      draft: {
        ...exemptionRecord.draft,
        items: [
          {
            ...exemptionRecord.draft.items[0]!,
            exemptReason: "Server returned a different reason",
          },
          exemptionRecord.draft.items[1]!,
        ],
      },
    };
    const { user, send } = await setup({
      handle: (url, init) =>
        url === `${receivingPath}/${eventId}` && init?.method === "PUT"
          ? json(changedResponse)
          : undefined,
    });
    const reason = screen.getByLabelText("Exemption reason", { exact: true });
    await user.type(reason, " — retained locally");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    const retry = await screen.findByRole("button", { name: "Retry same save" });
    expect(reason).toHaveProperty(
      "value",
      "Supplier declaration for this shipment — retained locally",
    );
    await user.click(retry);
    const writes = send.mock.calls.filter(
      ([url, init]) => url === `${receivingPath}/${eventId}` && init?.method === "PUT",
    );
    expect(writes).toHaveLength(2);
    expect(writes[0]?.[1]?.body).toBe(writes[1]?.[1]?.body);
  });
});

describe("per-line QA review", () => {
  it("shows two exact saved reference sources with their kind and shared resolved location", async () => {
    const firstSource = "https://source.example.test/tlc/receipt-4001/line-1";
    const secondSource = "https://source.example.test/tlc/receipt-4001/line-2";
    const firstEvidence = "https://evidence.example.test/exemption/receipt-4001/line-1";
    const secondEvidence = "https://evidence.example.test/exemption/receipt-4001/line-2";
    const referenceRecord = {
      ...exemptionRecord,
      draft: {
        ...exemptionRecord.draft,
        items: [
          {
            ...exemptionRecord.draft.items[0]!,
            source: {
              kind: "reference" as const,
              referenceKind: "web_url" as const,
              referenceValue: firstSource,
              resolvedLocationId: previousLocationId,
            },
            exemptReceipt: {
              ...exemptionRecord.draft.items[0]!.exemptReceipt!,
              evidenceUrl: firstEvidence,
            },
          },
          {
            ...exemptionRecord.draft.items[0]!,
            source: {
              kind: "reference" as const,
              referenceKind: "web_url" as const,
              referenceValue: secondSource,
              resolvedLocationId: previousLocationId,
            },
            exemptReceipt: {
              ...exemptionRecord.draft.items[0]!.exemptReceipt!,
              evidenceUrl: secondEvidence,
            },
          },
        ],
      },
    };
    const { user } = await setup({
      handle: (url) => {
        if (url === `${receivingPath}/${eventId}`) return json(referenceRecord);
        if (url.includes("/readiness")) return json(exemptionReadiness);
        return undefined;
      },
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await user.click(await screen.findByRole("button", { name: "Finalize" }));
    const dialog = await screen.findByRole("dialog");

    for (const [lineNo, source, evidence] of [
      [1, firstSource, firstEvidence],
      [2, secondSource, secondEvidence],
    ] as const) {
      const checkbox = within(dialog).getByRole("checkbox", {
        name: `Review exemption for line ${lineNo}`,
      });
      const line = checkbox.closest("li");
      expect(line).not.toBeNull();
      const review = within(line!);
      expect(review.getByText("Source reference")).toBeTruthy();
      expect(review.getByRole("link", { name: source })).toHaveProperty("href", source);
      expect(review.getByRole("link", { name: source })).toHaveProperty(
        "rel",
        "noopener noreferrer",
      );
      expect(review.getByRole("link", { name: evidence })).toHaveProperty("href", evidence);
      expect(review.getAllByText(previousLocation.name).length).toBeGreaterThan(0);
    }
  });

  it("requires every saved exempt line and submits the ascending exact set", async () => {
    const { user, send } = await setup();
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await user.click(await screen.findByRole("button", { name: "Finalize" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Confirm finalization" });
    expect(confirm).toHaveProperty("disabled", true);
    await user.click(within(dialog).getByRole("checkbox", { name: "Review exemption for line 2" }));
    expect(confirm).toHaveProperty("disabled", true);
    await user.click(within(dialog).getByRole("checkbox", { name: "Review exemption for line 1" }));
    expect(confirm).toHaveProperty("disabled", false);
    await user.click(confirm);
    await screen.findAllByText("qa-user");
    const request = send.mock.calls.find(([url]) => String(url).endsWith("/finalize"));
    expect(JSON.parse(String(request?.[1]?.body)).reviewedExemptLines).toEqual([1, 2]);
  });

  it("loads each shared review label once, blocks failed lookups and ignores late replies", async () => {
    let releaseProduct: ((response: Response) => void) | undefined;
    const { user, send } = await setup({
      handle: (url) =>
        url === `/api/us/traceability/catalog/products/${productId}`
          ? new Promise((resolve) => {
              releaseProduct = resolve;
            })
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    const productReadsBeforeDialog = send.mock.calls.filter(([url]) =>
      String(url).endsWith(`/catalog/products/${productId}`),
    ).length;
    const locationReadsBeforeDialog = [receivingLocationId, previousLocationId].map(
      (id) => send.mock.calls.filter(([url]) => String(url).endsWith(`/locations/${id}`)).length,
    );
    await user.click(await screen.findByRole("button", { name: "Finalize" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Confirm finalization" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      send.mock.calls.filter(([url]) => String(url).endsWith(`/catalog/products/${productId}`))
        .length - productReadsBeforeDialog,
    ).toBe(1);
    for (const [index, id] of [receivingLocationId, previousLocationId].entries())
      expect(
        send.mock.calls.filter(([url]) => String(url).endsWith(`/locations/${id}`)).length -
          (locationReadsBeforeDialog[index] ?? 0),
      ).toBe(1);
    await user.click(within(dialog).getAllByRole("button", { name: "Cancel" })[1]!);
    await act(async () => releaseProduct?.(json(product)));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("blocks mismatched required lines and failed reference labels", async () => {
    const mismatched = { ...exemptionReadiness, exemptReviewRequiredLines: [1] };
    const first = await setup({
      handle: (url) => (url.includes("/readiness") ? json(mismatched) : undefined),
    });
    await first.user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await first.user.click(await screen.findByRole("button", { name: "Finalize" }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/do not match the server review requirement/i)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Confirm finalization" })).toHaveProperty(
      "disabled",
      true,
    );
    cleanup();

    const second = await setup({
      handle: (url) =>
        url === `/api/us/traceability/catalog/products/${productId}`
          ? json({ code: "unavailable" }, 500)
          : undefined,
    });
    await second.user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await second.user.click(await screen.findByRole("button", { name: "Finalize" }));
    dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Reference labels could not be loaded/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Confirm finalization" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("propagates session loss during review lookup without enabling confirmation", async () => {
    const { user, onSessionLost } = await setup({
      handle: (url) =>
        url === `/api/us/traceability/catalog/products/${productId}`
          ? json({ code: "hidden" }, 401)
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await user.click(await screen.findByRole("button", { name: "Finalize" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => undefined);
    expect(onSessionLost).toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Confirm finalization" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("starts unchecked again after cancel and after QA loss and restoration", async () => {
    const { user, rerender, tree } = await setup();
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await user.click(await screen.findByRole("button", { name: "Finalize" }));
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox", { name: "Review exemption for line 1" }));
    await user.click(within(dialog).getAllByRole("button", { name: "Cancel" })[1]!);
    await user.click(screen.getByRole("button", { name: "Finalize" }));
    dialog = await screen.findByRole("dialog");
    expect(
      within(dialog)
        .getByRole("checkbox", { name: "Review exemption for line 1" })
        .getAttribute("data-state"),
    ).toBe("unchecked");
    rerender(tree(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(tree(true));
    expect(screen.queryByRole("button", { name: "Finalize" })).toBeNull();
  });

  it("uses the Spanish review label without falling back to English", async () => {
    const { user } = await setup({ locale: "es-US" });
    await user.click(screen.getByRole("button", { name: "Revisar borrador guardado" }));
    await user.click(await screen.findByRole("button", { name: "Finalizar" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("checkbox", { name: "Revisar exención de la línea 1" }),
    ).toBeTruthy();
  });

  it("freezes review choices and retries an uncertain delivery with the exact same body", async () => {
    let attempts = 0;
    const { user, send } = await setup({
      handle: (url) =>
        url.endsWith("/finalize") && attempts++ === 0
          ? Promise.reject(new TypeError("lost delivery"))
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await user.click(await screen.findByRole("button", { name: "Finalize" }));
    const dialog = await screen.findByRole("dialog");
    for (const line of [1, 2])
      await user.click(
        within(dialog).getByRole("checkbox", { name: `Review exemption for line ${line}` }),
      );
    await user.click(within(dialog).getByRole("button", { name: "Confirm finalization" }));
    const retry = await screen.findByRole("button", { name: "Retry same finalization" });
    expect(
      within(dialog).getByRole("checkbox", { name: "Review exemption for line 1" }),
    ).toHaveProperty("disabled", true);
    await user.click(retry);
    await screen.findAllByText("qa-user");
    const calls = send.mock.calls.filter(([url]) => String(url).endsWith("/finalize"));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]?.body).toBe(calls[1]?.[1]?.body);
  });
});

describe("frozen exempt history", () => {
  it("renders only the v2 snapshot review and a safe evidence link without live label requests", async () => {
    const { send } = await setup({ finalized: true });
    expect(screen.getByText("Supplier declaration for this shipment")).toBeTruthy();
    const evidence = screen.getByRole("link", {
      name: "https://supplier.example.test/declarations/receipt-4001",
    });
    expect(evidence).toHaveProperty(
      "href",
      "https://supplier.example.test/declarations/receipt-4001",
    );
    expect(evidence).toHaveProperty("rel", "noopener noreferrer");
    expect(screen.getAllByText("qa-user").length).toBeGreaterThan(1);
    expect(
      send.mock.calls.some(([url]) => /\/catalog\/products\/|\/locations\//.test(String(url))),
    ).toBe(false);
  });
});
