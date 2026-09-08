import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { StrictMode } from "react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";
import { amendmentFinalized } from "./support/us-receiving-revision-command-fixture.js";

const product = {
  id: "b0000000-0000-4000-8000-000000000001",
  name: "Apple cups",
  gtin14: null,
  archived: false,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};
const lot = {
  id: "a0000000-0000-4000-8000-000000000001",
  productId: product.id,
  tlc: "=Supplier-🍎",
  source: null,
  assignmentBasis: "imported",
  status: "active",
  sourceLockedAt: null,
  revision: 1,
  createdBy: "historical-user",
  updatedBy: "historical-user",
  createdAt: product.createdAt,
  updatedAt: product.updatedAt,
};
const path = "/api/us/traceability/lots";
const location = {
  id: "c0000000-0000-4000-8000-000000000001",
  partyId: "d0000000-0000-4000-8000-000000000001",
  name: "Supplier dock",
  businessName: "North River",
  phoneNumber: null,
  addressKind: "street",
  streetAddress: null,
  latitude: null,
  longitude: null,
  city: null,
  stateOrRegion: null,
  zipOrPostalCode: null,
  countryCode: null,
  roles: ["tlc_source"],
  archived: false,
  createdAt: product.createdAt,
  updatedAt: product.updatedAt,
  descriptionStatus: { exportReady: false, issues: [] },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function setup(
  options: {
    readOnly?: boolean;
    qaOnly?: boolean;
    locale?: string;
    handle?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  } = {},
) {
  const send = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const custom = options.handle?.(String(url), init);
    if (custom) return custom;
    if (url === "/api/us/traceability/access")
      return Response.json({
        capabilities: [
          "traceability.read",
          ...(options.readOnly
            ? []
            : options.qaOnly
              ? ["traceability.qa.manage"]
              : ["traceability.master_data.write", "traceability.qa.manage"]),
        ],
      });
    if (String(url).startsWith(`${path}?`))
      return Response.json({ items: [lot], limit: 50, offset: 0 });
    if (url === `${path}/${lot.id}`) return Response.json(lot);
    if (String(url).startsWith(`${path}/${lot.id}/receiving-basis?`))
      return Response.json({
        lotId: lot.id,
        basisVersion: 1,
        state: "missing",
        supportCount: 0,
        items: [],
        limit: 50,
        offset: 0,
        hasMore: false,
      });
    if (url === path) return Response.json({ ...lot, ...JSON.parse(String(init?.body)) });
    if (String(url).startsWith("/api/us/traceability/catalog/products?"))
      return Response.json({ items: [product], limit: 50, offset: 0 });
    if (url === `/api/us/traceability/catalog/products/${product.id}`)
      return Response.json(product);
    if (String(url).startsWith("/api/us/traceability/locations?"))
      return Response.json({ items: [location], limit: 50, offset: 0 });
    if (url === `/api/us/traceability/locations/${location.id}`) return Response.json(location);
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const instance = i18next.createInstance();
  await instance.init({
    resources: {
      "en-US": { translation: masterDataCopy["en-US"] },
      "es-US": { translation: masterDataCopy["es-US"] },
    },
    lng: options.locale ?? "en-US",
    fallbackLng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const onSessionLost = vi.fn();
  render(
    <StrictMode>
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>
          <MasterDataWorkspace
            client={createUsBrowserClient(send)}
            organization={{ id: "synthetic", name: "North River Fresh Foods" }}
            profile={{
              code: "US_GENERIC_LOT_TRACEABILITY",
              timeZone: "America/Chicago",
              retentionYears: 5,
              baselineVersion: "US-REG-2026-09-03",
              effectiveAt: product.createdAt,
            }}
            onBack={vi.fn()}
            onSessionLost={onSessionLost}
          />
        </I18nextProvider>
      </ThemeProvider>
    </StrictMode>,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: options.locale === "es-US" ? "Lotes" : "Lots" }),
  );
  await screen.findByRole("button", { name: lot.tlc });
  return { user, send, instance, onSessionLost };
}
async function openLot(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: lot.tlc }));
  await screen.findByRole("heading", { name: lot.tlc });
}

const basisPath = `${path}/${lot.id}/receiving-basis`;
const receiptPath = `/api/us/traceability/receiving/${amendmentFinalized.id}`;
const supportingReceipt = {
  ...amendmentFinalized,
  content:
    amendmentFinalized.content.kind === "finalized"
      ? {
          ...amendmentFinalized.content,
          snapshot: {
            ...amendmentFinalized.content.snapshot,
            items: amendmentFinalized.content.snapshot.items.map((item) => ({
              ...item,
              lotId: lot.id,
            })),
          },
        }
      : null,
};
const support = {
  rootId: amendmentFinalized.lifecycle.rootId,
  eventId: amendmentFinalized.id,
  eventNumber: "REC-26-0001",
  revision: 3,
  lineNos: [1, 2, 3],
};
const presentBasis = {
  lotId: lot.id,
  basisVersion: 6,
  state: "present",
  supportCount: 1,
  items: [support],
  limit: 50,
  offset: 0,
  hasMore: false,
};

describe("lot current receiving basis", () => {
  it("preserves both return contexts when a receipt's lot lookup fails", async () => {
    let lotUnavailable = false;
    const { user } = await setup({
      readOnly: true,
      handle: (url) => {
        if (url.startsWith(basisPath)) return Response.json(presentBasis);
        if (url === receiptPath) return Response.json(supportingReceipt);
        if (url === `${path}/${lot.id}` && lotUnavailable)
          return Response.json({}, { status: 503 });
      },
    });
    await openLot(user);
    await user.click(await screen.findByRole("button", { name: "REC-26-0001 · Revision 3" }));
    await screen.findByRole("heading", { name: "REC-26-0001" });
    lotUnavailable = true;
    const lotLink = screen.getAllByRole("button", { name: "Open current lot" })[0];
    if (!lotLink) throw new Error("Expected a frozen line lot link");
    await user.click(lotLink);
    await screen.findByRole("button", { name: "Try again" });
    await user.click(screen.getByRole("button", { name: "Back to receiving" }));
    await screen.findByRole("heading", { name: "REC-26-0001" });
    lotUnavailable = false;
    await user.click(screen.getByRole("button", { name: "Back to lot" }));
    await screen.findByRole("heading", { name: lot.tlc });
    await screen.findByText("Supporting revisions: 1");
  });

  it.each([401, 403])(
    "routes basis access failure %s through the workspace auth boundary",
    async (status) => {
      let revoked = false;
      const { user, onSessionLost } = await setup({
        handle: (url) => {
          if (url.startsWith(basisPath)) {
            revoked = true;
            return Response.json({}, { status });
          }
          if (revoked && url.endsWith("/access")) return Response.json({ capabilities: [] });
        },
      });
      await openLot(user);
      if (status === 401) await waitFor(() => expect(onSessionLost).toHaveBeenCalledTimes(1));
      else await waitFor(() => expect(screen.queryByRole("heading", { name: lot.tlc })).toBeNull());
      expect(screen.queryByText("No current receiving basis")).toBeNull();
    },
  );

  it("ignores a delayed basis authorization failure after leaving the lot", async () => {
    let resolve!: (value: Response) => void;
    const deferred = new Promise<Response>((done) => {
      resolve = done;
    });
    const { user, onSessionLost } = await setup({
      handle: (url) => (url.startsWith(basisPath) ? deferred : undefined),
    });
    await openLot(user);
    await screen.findByText("Loading receiving basis…");
    await user.click(screen.getByRole("button", { name: /Back to lots/ }));
    await screen.findByRole("button", { name: lot.tlc });
    await act(async () => {
      resolve(Response.json({}, { status: 401 }));
    });
    expect(onSessionLost).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Current receiving basis" })).toBeNull();
  });

  it("holds the existing workspace lock while an exact revision is opening", async () => {
    let resolve!: (value: Response) => void;
    const deferred = new Promise<Response>((done) => {
      resolve = done;
    });
    const { user, send } = await setup({
      readOnly: true,
      handle: (url) => {
        if (url.startsWith(basisPath)) return Response.json(presentBasis);
        if (url === receiptPath) return deferred;
      },
    });
    await openLot(user);
    await user.click(await screen.findByRole("button", { name: "REC-26-0001 · Revision 3" }));
    expect((screen.getByRole("button", { name: "Lots" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reload lot" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => {
      resolve(Response.json({}, { status: 503 }));
    });
    await screen.findByText(
      "This receiving revision could not be opened. Retry the revision or refresh its current basis.",
    );
    expect((screen.getByRole("button", { name: "Lots" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(send.mock.calls.filter(([url]) => url === receiptPath)).toHaveLength(1);
  });

  it("refreshes receiving basis when the lot is reloaded even if its revision did not change", async () => {
    let supported = true;
    const { user } = await setup({
      handle: (url) =>
        url.startsWith(basisPath) && supported ? Response.json(presentBasis) : undefined,
    });
    await openLot(user);
    await screen.findByText("Supporting revisions: 1");
    supported = false;
    await user.click(screen.getByRole("button", { name: "Reload lot" }));
    await screen.findByText("No current receiving basis");
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Imported")).toBeTruthy();
  });

  it("keeps missing support separate from active lot status and imported assignment", async () => {
    const { user, send } = await setup();
    await openLot(user);
    const card = await screen.findByRole("region", { name: "Current receiving basis" });
    expect(await within(card).findByText("No current receiving basis")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Imported")).toBeTruthy();
    expect(send.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("counts supporting revisions, not lines, and opens the exact revision with a return to the lot", async () => {
    const { user, send } = await setup({
      readOnly: true,
      handle: (url) => {
        if (url.startsWith(basisPath)) return Response.json(presentBasis);
        if (url === receiptPath) return Response.json(supportingReceipt);
      },
    });
    await openLot(user);
    const card = await screen.findByRole("region", { name: "Current receiving basis" });
    expect(await within(card).findByText("Supporting revisions: 1")).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "REC-26-0001 · Revision 3" }));
    await screen.findByRole("heading", { name: "REC-26-0001" });
    await user.click(screen.getByRole("button", { name: "Back to lot" }));
    await screen.findByRole("heading", { name: lot.tlc });
    expect(await screen.findByText("Supporting revisions: 1")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Back to lots/ }));
    await screen.findByRole("button", { name: lot.tlc });
    expect(send.mock.calls.filter(([url]) => url === receiptPath)).toHaveLength(1);
    expect(send.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("shows loading then unavailable, never missing, and retries the failed basis read", async () => {
    let resolve!: (value: Response) => void;
    let failed = true;
    const deferred = new Promise<Response>((done) => {
      resolve = done;
    });
    const { user } = await setup({
      handle: (url) =>
        url.startsWith(basisPath) ? (failed ? deferred : Response.json(presentBasis)) : undefined,
    });
    await openLot(user);
    expect(await screen.findByText("Loading receiving basis…")).toBeTruthy();
    expect(screen.queryByText("No current receiving basis")).toBeNull();
    await act(async () => {
      resolve(Response.json({}, { status: 503 }));
    });
    expect(await screen.findByText("The receiving basis could not be loaded.")).toBeTruthy();
    expect(screen.queryByText("No current receiving basis")).toBeNull();
    failed = false;
    await user.click(screen.getByRole("button", { name: "Refresh receiving basis" }));
    expect(await screen.findByText("Supporting revisions: 1")).toBeTruthy();
  });

  it("keeps present state on an empty later page after support changes", async () => {
    const items = Array.from({ length: 50 }, (_, i) => {
      const id = `f0000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
      return { ...support, rootId: id, eventId: id, revision: 1 };
    });
    const { user, send } = await setup({
      handle: (url) => {
        if (!url.startsWith(basisPath)) return;
        const later = new URL(url, "http://local").searchParams.get("offset") === "50";
        return Response.json(
          later
            ? { ...presentBasis, offset: 50, items: [] }
            : { ...presentBasis, supportCount: 51, items, hasMore: true },
        );
      },
    });
    await openLot(user);
    const card = await screen.findByRole("region", { name: "Current receiving basis" });
    await within(card).findByText("Supporting revisions: 51");
    await user.click(within(card).getByRole("button", { name: "Next page" }));
    expect(await within(card).findByText("Supporting revisions: 1")).toBeTruthy();
    expect(within(card).queryByText("No current receiving basis")).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Previous page" }));
    await within(card).findByText("Supporting revisions: 51");
    expect(send.mock.calls.some(([url]) => String(url).includes("offset=50"))).toBe(true);
  });

  it.each(["unavailable", "wrong root", "wrong lot"])(
    "keeps the lot on %s receipt lookup and permits an exact retry",
    async (fault) => {
      let failed = true;
      const { user } = await setup({
        readOnly: true,
        handle: (url) => {
          if (url.startsWith(basisPath)) return Response.json(presentBasis);
          if (url === receiptPath) {
            if (!failed) return Response.json(supportingReceipt);
            if (fault === "unavailable") return Response.json({}, { status: 503 });
            if (fault === "wrong lot") return Response.json(amendmentFinalized);
            return Response.json({
              ...supportingReceipt,
              lifecycle: {
                ...supportingReceipt.lifecycle,
                rootId: "b0000000-0000-4000-8000-000000000099",
              },
            });
          }
        },
      });
      await openLot(user);
      const button = await screen.findByRole("button", { name: "REC-26-0001 · Revision 3" });
      await user.click(button);
      expect(
        await screen.findByText(
          "This receiving revision could not be opened. Retry the revision or refresh its current basis.",
        ),
      ).toBeTruthy();
      expect(screen.getByRole("heading", { name: lot.tlc })).toBeTruthy();
      failed = false;
      await user.click(button);
      await screen.findByRole("heading", { name: "REC-26-0001" });
    },
  );

  it("renders the independent missing basis in Spanish", async () => {
    const { user } = await setup({ locale: "es-US" });
    await openLot(user);
    const card = await screen.findByRole("region", { name: "Base de recepción vigente" });
    expect(await within(card).findByText("Sin base de recepción vigente")).toBeTruthy();
    expect(screen.getByText("Activo")).toBeTruthy();
  });
});

describe("connected US lots", () => {
  it("loads the product label for a newly created lot outside the previous list page", async () => {
    const other = { ...product, id: "b0000000-0000-4000-8000-000000000002", name: "Pear cups" };
    const { user } = await setup({
      handle: (url) =>
        url.startsWith("/api/us/traceability/catalog/products?")
          ? Response.json({ items: [other], limit: 50, offset: 0 })
          : url.endsWith(`/catalog/products/${other.id}`)
            ? Response.json(other)
            : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Add imported lot" }));
    await user.selectOptions(await screen.findByLabelText("Product"), other.id);
    await user.type(screen.getByLabelText("Lot code (TLC)"), "PEAR-01");
    await user.click(screen.getByRole("button", { name: "Save lot" }));
    await screen.findByRole("heading", { name: "PEAR-01" });
    expect(await screen.findByText("Pear cups")).toBeTruthy();
  });
  it("keeps a duplicate draft until the user confirms opening the existing lot", async () => {
    const { user, send } = await setup({
      handle: (url) =>
        url === path
          ? Response.json({ code: "LOT_DUPLICATE", existingId: lot.id }, { status: 409 })
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Add imported lot" }));
    await user.selectOptions(await screen.findByLabelText("Product"), product.id);
    await user.type(screen.getByLabelText("Lot code (TLC)"), lot.tlc);
    await user.click(screen.getByRole("button", { name: "Save lot" }));
    await screen.findByText("This source and TLC already exist.");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "Open existing lot" }));
    expect(screen.getByLabelText<HTMLInputElement>("Lot code (TLC)").value).toBe(lot.tlc);
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Open existing lot" }));
    await screen.findByRole("heading", { name: lot.tlc });
    expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("holds navigation and repeated writes until the pending request settles", async () => {
    let release: (value: Response) => void = () => {
      throw new Error("Response promise not initialized");
    };
    const held = {
      promise: new Promise<Response>((resolve) => {
        release = resolve;
      }),
      resolve: (value: Response) => release(value),
    };
    const { user, send } = await setup({
      handle: (url) => (url.endsWith("/status") ? held.promise : undefined),
    });
    await openLot(user);
    await user.click(screen.getByRole("button", { name: "Change status" }));
    await user.selectOptions(screen.getByLabelText("New status"), "quarantined");
    await user.type(screen.getByLabelText("Reason"), "Quality review hold");
    await user.click(screen.getByRole("button", { name: "Save status change" }));
    try {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Products" }).disabled).toBe(
        true,
      );
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled).toBe(true);
      await user.click(screen.getByRole("button", { name: "Save status change" }));
      expect(send.mock.calls.filter(([url]) => String(url).endsWith("/status"))).toHaveLength(1);
    } finally {
      await act(async () =>
        held.resolve(Response.json({ ...lot, status: "quarantined", revision: 2 })),
      );
    }
    await screen.findByRole("heading", { name: lot.tlc });
  });
  it.each(["read-only", "read-revoked", "session-lost", "refresh-failed"])(
    "handles %s after a denied command",
    async (outcome) => {
      let denied = false;
      const { user, onSessionLost } = await setup({
        handle: (url) => {
          if (url.endsWith("/status")) {
            denied = true;
            return Response.json({}, { status: outcome === "session-lost" ? 401 : 403 });
          }
          if (url.endsWith("/access") && denied)
            return outcome === "refresh-failed"
              ? Response.json({}, { status: 503 })
              : Response.json({
                  capabilities: outcome === "read-revoked" ? [] : ["traceability.read"],
                });
          return undefined;
        },
      });
      await openLot(user);
      await user.click(screen.getByRole("button", { name: "Change status" }));
      await user.selectOptions(screen.getByLabelText("New status"), "quarantined");
      await user.type(screen.getByLabelText("Reason"), "Keep this QA draft");
      await user.click(screen.getByRole("button", { name: "Save status change" }));
      if (outcome === "session-lost")
        await waitFor(() => expect(onSessionLost).toHaveBeenCalledTimes(1));
      else if (outcome === "read-revoked")
        await waitFor(() => expect(screen.queryByLabelText("Reason")).toBeNull());
      else {
        await waitFor(() =>
          expect(
            screen.getByRole<HTMLButtonElement>("button", { name: "Save status change" }).disabled,
          ).toBe(true),
        );
        expect(screen.getByLabelText<HTMLTextAreaElement>("Reason").value).toBe(
          "Keep this QA draft",
        );
      }
    },
  );
  it.each(["product", "location"])(
    "Enter in %s search applies the search without submitting the lot",
    async (kind) => {
      const { user, send } = await setup();
      await user.click(screen.getByRole("button", { name: "Add imported lot" }));
      await user.selectOptions(await screen.findByLabelText("Product"), product.id);
      await user.type(screen.getByLabelText("Lot code (TLC)"), lot.tlc);
      if (kind === "location") {
        await user.selectOptions(screen.getByLabelText("Source type"), "location");
        await user.selectOptions(await screen.findByLabelText("Location"), location.id);
      }
      await user.type(
        screen.getByLabelText(
          kind === "product" ? "Search active products" : "Search active locations",
        ),
        "Apple{Enter}",
      );
      expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
      await waitFor(() =>
        expect(send.mock.calls.some(([url]) => String(url).includes("search=Apple"))).toBe(true),
      );
      expect(screen.getByLabelText<HTMLInputElement>("Lot code (TLC)").value).toBe(lot.tlc);
    },
  );
  it("cancel cannot clear a known revision conflict or unlock a stale detail", async () => {
    const { user, send } = await setup({
      handle: (url) =>
        url.endsWith("/status")
          ? Response.json({ code: "lot_revision_conflict" }, { status: 409 })
          : undefined,
    });
    await openLot(user);
    await user.click(screen.getByRole("button", { name: "Change status" }));
    await user.selectOptions(screen.getByLabelText("New status"), "quarantined");
    await user.type(screen.getByLabelText("Reason"), "Hold for review");
    await user.click(screen.getByRole("button", { name: "Save status change" }));
    await screen.findByText(/Reload the lot before saving again/);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Change status" }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Correct source" }).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole("button", { name: "Reload lot" }));
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Change status" }).disabled,
      ).toBe(false),
    );
    expect(send.mock.calls.filter(([url]) => String(url).endsWith("/status"))).toHaveLength(1);
  });
  it("shows real identities in Spanish without unavailable event claims or auditor writes", async () => {
    const { user } = await setup({ readOnly: true, locale: "es-US" });
    await openLot(user);
    expect(screen.getByText(lot.id)).toBeTruthy();
    expect(screen.getByText("Activo")).toBeTruthy();
    expect(screen.getByText(/La aplicabilidad de FTR no se evalúa/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Corregir fuente|Cambiar estado|Añadir lote/ }),
    ).toBeNull();
    expect(screen.queryByText(/No gaps found|No events/)).toBeNull();
  });
  it("creates an imported no-GTIN lot, preserves the draft across language changes, and returns focus", async () => {
    const { user, send, instance } = await setup();
    await user.click(screen.getByRole("button", { name: "Add imported lot" }));
    await user.selectOptions(await screen.findByLabelText("Product"), product.id);
    await user.type(screen.getByLabelText("Lot code (TLC)"), "  =Supplier-🍎  ");
    await act(() => instance.changeLanguage("es-US"));
    expect(screen.getByLabelText<HTMLInputElement>("Código de lote (TLC)").value).toBe(
      "  =Supplier-🍎  ",
    );
    await user.click(screen.getByRole("button", { name: "Guardar lote" }));
    const heading = await screen.findByRole("heading", { name: lot.tlc });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    // The newly selected product need not have appeared in the previous lot page.
    expect(await screen.findByText("Apple cups")).toBeTruthy();
    expect(send.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body).toBe(
      JSON.stringify({
        productId: product.id,
        tlc: lot.tlc,
        source: null,
        assignmentBasis: "imported",
      }),
    );
  });
  it("validates before transport and confirms unsaved navigation", async () => {
    const { user, send } = await setup();
    await user.click(screen.getByRole("button", { name: "Add imported lot" }));
    await user.click(screen.getByRole("button", { name: "Save lot" }));
    expect(document.activeElement).toBe(await screen.findByRole("alert"));
    expect(send.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await user.type(screen.getByLabelText("Lot code (TLC)"), "draft");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "Products" }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>("Lot code (TLC)").value).toBe("draft");
  });
  it("retains reason and blocks writes after a revision conflict until confirmed reload succeeds", async () => {
    let conflict = false;
    let reloadFails = false;
    const { user, send } = await setup({
      handle: (url) => {
        if (url === `${path}/${lot.id}/source`) {
          conflict = true;
          return Response.json({ code: "lot_revision_conflict" }, { status: 409 });
        }
        if (url === `${path}/${lot.id}`)
          return conflict
            ? reloadFails
              ? Response.json({}, { status: 503 })
              : Response.json({ ...lot, revision: 2 })
            : Response.json({
                ...lot,
                source: { kind: "location", locationId: "c0000000-0000-4000-8000-000000000001" },
              });
        return undefined;
      },
    });
    await openLot(user);
    await user.click(screen.getByRole("button", { name: "Correct source" }));
    await user.selectOptions(screen.getByLabelText("Source type"), "absent");
    await user.type(screen.getByLabelText("Reason"), "Confirmed supplier reference");
    await user.click(screen.getByRole("button", { name: "Save source correction" }));
    expect(await screen.findByText(/Reload the lot before saving again/)).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save source correction" }).disabled,
    ).toBe(true);
    expect(screen.getByLabelText<HTMLTextAreaElement>("Reason").value).toBe(
      "Confirmed supplier reference",
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "Reload lot" }));
    expect(confirm).toHaveBeenCalled();
    confirm.mockReturnValue(true);
    reloadFails = true;
    await user.click(screen.getByRole("button", { name: "Reload lot" }));
    await screen.findByText(/could not be reloaded/);
    expect(screen.getByLabelText<HTMLTextAreaElement>("Reason").value).toBe(
      "Confirmed supplier reference",
    );
    reloadFails = false;
    await user.click(screen.getByRole("button", { name: "Reload lot" }));
    await screen.findByRole("heading", { name: lot.tlc });
    expect(send.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });
  it("offers domain transitions only and keeps QA permission independent of master-data writes", async () => {
    const { user, send } = await setup({
      qaOnly: true,
      handle: (url) =>
        url === `${path}/${lot.id}`
          ? Response.json({ ...lot, status: "recalled" })
          : url.endsWith("/status")
            ? Response.json({ ...lot, status: "archived", revision: 2 })
            : undefined,
    });
    await openLot(user);
    expect(screen.queryByRole("button", { name: "Correct source" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change status" }));
    expect(screen.queryByRole("option", { name: "Active" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("New status"), "archived");
    await user.type(screen.getByLabelText("Reason"), "Closed after recall");
    await user.click(screen.getByRole("button", { name: "Save status change" }));
    await screen.findByRole("heading", { name: lot.tlc });
    expect(screen.queryByRole("button", { name: "Change status" })).toBeNull();
    expect(send.mock.calls.find(([url]) => String(url).endsWith("/status"))?.[1]?.body).toBe(
      '{"status":"archived","reason":"Closed after recall","expectedRevision":1}',
    );
  });
  it("never offers source correction after finalization has locked the source", async () => {
    const { user } = await setup({
      handle: (url) =>
        url === `${path}/${lot.id}`
          ? Response.json({ ...lot, sourceLockedAt: lot.createdAt })
          : undefined,
    });
    await openLot(user);
    expect(screen.queryByRole("button", { name: "Correct source" })).toBeNull();
    expect(screen.getByText(/locked after finalized use/)).toBeTruthy();
  });
});
