import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { StrictMode } from "react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";
import { UsApp } from "../src/us/app.js";

const product = {
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Apple cups",
  gtin14: null,
  archived: false,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
};
const original = {
  productId: product.id,
  revision: 0,
  productName: product.name,
  brandName: null,
  commodity: null,
  variety: null,
  packagingSizeValue: null,
  packagingSizeUom: null,
  packagingStyle: null,
  defaultQuantityUom: null,
  coverageStatus: "unknown",
  coverageRationale: null,
  ftlCategory: null,
  ftlSourceUrl: null,
  ftlSourceVersion: null,
  reviewedBy: null,
  reviewedAt: null,
  createdAt: null,
  updatedAt: null,
};
const path = `/api/us/traceability/products/${product.id}`;
const catalog = "/api/us/traceability/catalog/products";
const read = ["traceability.read"];
const write = [...read, "traceability.master_data.write"];
const qa = [...write, "traceability.qa.manage"];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function setup(
  options: {
    capabilities?: string[];
    generic?: boolean;
    handle?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  } = {},
) {
  const send = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const custom = options.handle?.(String(url), init);
    if (custom) return custom;
    if (url === "/api/us/traceability/access")
      return Response.json({ capabilities: options.capabilities ?? qa });
    if (String(url).startsWith(`${catalog}?`))
      return Response.json({ items: [product], limit: 50, offset: 0 });
    if (url === `${catalog}/${product.id}`) return Response.json(product);
    if (url === path) {
      if (init?.method === "PUT") {
        const { expectedRevision, ...input } = JSON.parse(String(init.body));
        return Response.json({
          ...original,
          ...input,
          revision: expectedRevision + 1,
          reviewedBy: input.coverageStatus === "unknown" ? null : "reviewer-1",
          reviewedAt: input.coverageStatus === "unknown" ? null : product.updatedAt,
          createdAt: product.createdAt,
          updatedAt: product.updatedAt,
        });
      }
      return Response.json(original);
    }
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const instance = i18next.createInstance();
  await instance.init({
    resources: {
      "en-US": { translation: masterDataCopy["en-US"] },
      "es-US": { translation: masterDataCopy["es-US"] },
    },
    lng: "en-US",
    fallbackLng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const onBack = vi.fn();
  const onSessionLost = vi.fn();
  render(
    <StrictMode>
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>
          <MasterDataWorkspace
            client={createUsBrowserClient(send)}
            organization={{ id: "synthetic", name: "North River Fresh Foods" }}
            profile={{
              code: options.generic ? "US_GENERIC_LOT_TRACEABILITY" : "US_FSMA204_PROCESSOR",
              timeZone: "America/Chicago",
              retentionYears: 5,
              baselineVersion: "US-REG-2026-09-03",
              effectiveAt: product.createdAt,
            }}
            onBack={onBack}
            onSessionLost={onSessionLost}
          />
        </I18nextProvider>
      </ThemeProvider>
    </StrictMode>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Products" }));
  await user.click(await screen.findByRole("button", { name: product.name }));
  await user.click(await screen.findByRole("button", { name: "Traceability profile" }));
  return { user, send, instance, onBack, onSessionLost };
}
const putCalls = (send: ReturnType<typeof vi.fn<typeof fetch>>) =>
  send.mock.calls.filter(([, init]) => init?.method === "PUT");

describe("connected US product profile", () => {
  it("keeps the draft and loaded revision when the real app changes language and theme", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (url === "/api/us/deployment")
        return Response.json({
          edition: "US",
          releaseEnabled: false,
          interfaceLocales: ["en-US", "es-US"],
          defaultInterfaceLocale: "en-US",
        });
      if (url === "/api/us-auth/get-session")
        return Response.json({
          user: { id: "u1", email: "owner@example.test", name: "Owner", twoFactorEnabled: true },
          session: { activeOrganizationId: "synthetic" },
        });
      if (url === "/api/us-auth/organization/list")
        return Response.json([{ id: "synthetic", name: "North River", slug: "north-river" }]);
      if (url === "/api/us/traceability/profile")
        return Response.json({
          code: "US_FSMA204_PROCESSOR",
          timeZone: "America/Chicago",
          retentionYears: 5,
          baselineVersion: "US-REG-2026-09-03",
          effectiveAt: product.createdAt,
        });
      if (url === "/api/us/traceability/access") return Response.json({ capabilities: qa });
      if (url === path) return Response.json(original);
      if (url === `${catalog}/${product.id}`) return Response.json(product);
      return Response.json({
        items: String(url).startsWith(catalog) ? [product] : [],
        limit: 50,
        offset: 0,
      });
    });
    render(
      <ThemeProvider defaultTheme="light">
        <UsApp client={createUsBrowserClient(send)} />
      </ThemeProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open reference data" }));
    await user.click(await screen.findByRole("button", { name: "Products" }));
    await user.click(await screen.findByRole("button", { name: product.name }));
    await user.click(await screen.findByRole("button", { name: "Traceability profile" }));
    await user.type(await screen.findByLabelText("Brand"), "Do not lose this draft");
    const before = send.mock.calls.filter(([url]) => url === path).length;
    await user.click(screen.getByRole("button", { name: "Language" }));
    await user.click(screen.getByRole("button", { name: "Cambiar tema" }));
    expect(screen.getByLabelText<HTMLInputElement>("Marca").value).toBe("Do not lose this draft");
    expect(send.mock.calls.filter(([url]) => url === path)).toHaveLength(before);
  });
  it("loads defaults without writing and saves an exact description with the loaded revision", async () => {
    const { user, send } = await setup({ capabilities: write });
    expect(await screen.findByLabelText<HTMLInputElement>("Product name")).toHaveProperty(
      "value",
      "Apple cups",
    );
    expect(putCalls(send)).toHaveLength(0);
    expect(screen.getByLabelText<HTMLSelectElement>("Coverage").disabled).toBe(true);
    await user.type(screen.getByLabelText("Pack size"), "6.125");
    await user.selectOptions(screen.getByLabelText("Pack size unit"), "oz");
    await user.selectOptions(screen.getByLabelText("Default quantity unit"), "case");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Profile saved.")).toBeTruthy();
    expect(JSON.parse(String(putCalls(send)[0]?.[1]?.body))).toEqual({
      productName: "Apple cups",
      brandName: null,
      commodity: null,
      variety: null,
      packagingSizeValue: "6.125",
      packagingSizeUom: "oz",
      packagingStyle: null,
      defaultQuantityUom: "case",
      coverageStatus: "unknown",
      coverageRationale: null,
      ftlCategory: null,
      ftlSourceUrl: null,
      ftlSourceVersion: null,
      expectedRevision: 0,
    });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save profile" }).disabled).toBe(
      true,
    );
  });
  it("keeps locale changes and exposes invalid coverage fields before sending", async () => {
    const { user, send, instance } = await setup();
    await screen.findByLabelText("Product name");
    await user.type(screen.getByLabelText("Brand"), "North River");
    await user.selectOptions(screen.getByLabelText("Coverage"), "covered");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    expect(screen.getByLabelText("Review rationale").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("FTL category").getAttribute("aria-invalid")).toBe("true");
    expect(putCalls(send)).toHaveLength(0);
    await act(() => instance.changeLanguage("es-US"));
    expect(screen.getByLabelText<HTMLInputElement>("Marca").value).toBe("North River");
    await user.type(screen.getByLabelText("Justificación de la revisión"), "Fresh-cut fruit.");
    await user.type(screen.getByLabelText("Categoría FTL"), "Fruits (fresh-cut)");
    await user.type(screen.getByLabelText("URL de la fuente"), "https://example.com/ftl");
    await user.type(screen.getByLabelText("Versión de la fuente"), "US-REG-2026-09-03");
    await user.click(screen.getByRole("button", { name: "Guardar perfil" }));
    expect(await screen.findByText("Perfil guardado.")).toBeTruthy();
    expect(screen.getByText("reviewer-1")).toBeTruthy();
    expect(putCalls(send)).toHaveLength(1);
  });
  it.each(["0", "1e3", "1,25", "6.1234"])(
    "rejects invalid pack size %s without coercion",
    async (value) => {
      const { user, send } = await setup();
      await screen.findByLabelText("Pack size");
      await user.type(screen.getByLabelText("Pack size"), value);
      await user.selectOptions(screen.getByLabelText("Pack size unit"), "oz");
      await user.click(screen.getByRole("button", { name: "Save profile" }));
      expect(screen.getByLabelText("Pack size").getAttribute("aria-invalid")).toBe("true");
      expect(putCalls(send)).toHaveLength(0);
    },
  );
  it("shows generic applicability as not assessed, not as a coverage verdict", async () => {
    const { user, send } = await setup({ generic: true });
    expect(await screen.findByText(/FTR applicability is not assessed/)).toBeTruthy();
    expect(screen.queryByLabelText("Coverage")).toBeNull();
    await user.type(screen.getByLabelText("Brand"), "North River");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Profile saved.");
    expect(JSON.parse(String(putCalls(send)[0]?.[1]?.body))).toMatchObject({
      coverageStatus: "unknown",
      coverageRationale: null,
      ftlCategory: null,
      ftlSourceUrl: null,
      ftlSourceVersion: null,
    });
  });
  it("lets an auditor inspect the profile without mutation controls", async () => {
    const { send } = await setup({ capabilities: read });
    expect(await screen.findByLabelText<HTMLInputElement>("Product name")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByLabelText<HTMLSelectElement>("Coverage").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
    expect(putCalls(send)).toHaveLength(0);
  });
  it("preserves a conflicted draft and requires explicit reload before another save", async () => {
    let conflict = false;
    const { user, send } = await setup({
      handle: (url, init) => {
        if (url !== path) return undefined;
        if (init?.method === "PUT") {
          conflict = true;
          return Response.json({ code: "product_profile_conflict" }, { status: 409 });
        }
        return conflict
          ? Response.json({
              ...original,
              brandName: "Other user",
              revision: 2,
              createdAt: product.createdAt,
              updatedAt: product.updatedAt,
            })
          : undefined;
      },
    });
    await user.type(await screen.findByLabelText("Brand"), "My draft");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText(/changed since you opened it/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Brand").value).toBe("My draft");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save profile" }).disabled).toBe(
      true,
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "Load latest profile" }));
    expect(screen.getByLabelText<HTMLInputElement>("Brand").value).toBe("My draft");
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Load latest profile" }));
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("Brand").value).toBe("Other user"),
    );
    expect(putCalls(send)).toHaveLength(1);
  });
  it("preserves draft on a forbidden save plus transient access failure, then recovers", async () => {
    let rejected = false;
    let accessFailed = false;
    const { user, send } = await setup({
      handle: (url, init) => {
        if (url === path && init?.method === "PUT" && !rejected) {
          rejected = true;
          return Response.json({}, { status: 403 });
        }
        if (url === "/api/us/traceability/access" && rejected && !accessFailed) {
          accessFailed = true;
          return Response.json({}, { status: 503 });
        }
        return undefined;
      },
    });
    await user.type(await screen.findByLabelText("Brand"), "Kept draft");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Reference-data access could not be loaded.");
    expect(screen.getByLabelText<HTMLInputElement>("Brand").value).toBe("Kept draft");
    expect(screen.getByLabelText<HTMLInputElement>("Brand").disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: product.name })),
    );
    await user.click(await screen.findByRole("button", { name: "Save profile" }));
    await screen.findByText("Profile saved.");
    expect(putCalls(send)).toHaveLength(2);
  });
  it("clears protected content when refreshed read permission is revoked", async () => {
    let revoked = false;
    const { user } = await setup({
      handle: (url, init) => {
        if (url === path && init?.method === "PUT") {
          revoked = true;
          return Response.json({}, { status: 403 });
        }
        return url === "/api/us/traceability/access" && revoked
          ? Response.json({ capabilities: [] })
          : undefined;
      },
    });
    await user.type(await screen.findByLabelText("Brand"), "Private draft");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Your current organization access does not include reference data.");
    expect(screen.queryByLabelText("Brand")).toBeNull();
  });
  it("discards only unauthorized coverage edits after QA revocation, preserving the description", async () => {
    let rejected = false;
    const { user, send } = await setup({
      handle: (url, init) => {
        if (url === path && init?.method === "PUT" && !rejected) {
          rejected = true;
          return Response.json({}, { status: 403 });
        }
        if (url === "/api/us/traceability/access" && rejected)
          return Response.json({ capabilities: write });
        return undefined;
      },
    });
    await user.type(await screen.findByLabelText("Brand"), "Keep my brand");
    await user.selectOptions(screen.getByLabelText("Coverage"), "not_covered");
    await user.type(screen.getByLabelText("Review rationale"), "Draft decision");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    const discard = await screen.findByRole("button", { name: "Discard coverage changes" });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save profile" }).disabled).toBe(
      true,
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(discard);
    expect(screen.getByLabelText<HTMLSelectElement>("Coverage").value).toBe("not_covered");
    confirm.mockReturnValue(true);
    await user.click(discard);
    expect(screen.getByLabelText<HTMLInputElement>("Brand").value).toBe("Keep my brand");
    expect(screen.getByLabelText<HTMLSelectElement>("Coverage").value).toBe("unknown");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Profile saved.");
    expect(JSON.parse(String(putCalls(send).at(-1)?.[1]?.body))).toMatchObject({
      brandName: "Keep my brand",
      coverageStatus: "unknown",
      coverageRationale: null,
      expectedRevision: 0,
    });
  });
  it("confirms navigation away from unsaved edits and restores catalog focus", async () => {
    const { user } = await setup();
    await user.type(await screen.findByLabelText("Brand"), "Draft");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: /Back to products/ }));
    expect(screen.getByLabelText<HTMLInputElement>("Brand").value).toBe("Draft");
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: /Back to products/ }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Products" })),
    );
  });
});
