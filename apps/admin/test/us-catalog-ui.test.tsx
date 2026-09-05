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

const product = {
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Apple cups",
  gtin14: null,
  archived: false,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
};
const path = "/api/us/traceability/catalog/products";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function setup(
  options: {
    locale?: "en-US" | "es-US";
    readOnly?: boolean;
    handle?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  } = {},
) {
  const send = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const custom = options.handle?.(String(url), init);
    if (custom) return custom;
    if (url === "/api/us/traceability/access")
      return Response.json({
        capabilities: options.readOnly
          ? ["traceability.read"]
          : ["traceability.read", "traceability.master_data.write"],
      });
    if (String(url).startsWith(`${path}?`))
      return Response.json({ items: [product], limit: 50, offset: 0 });
    if (url === path || url === `${path}/${product.id}`) return Response.json(product);
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
              code: "US_FSMA204_PROCESSOR",
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
  await user.click(
    await screen.findByRole("button", {
      name: options.locale === "es-US" ? "Productos" : "Products",
    }),
  );
  return { user, send, instance, onBack, onSessionLost };
}

describe("connected US catalog", () => {
  it("lists no-GTIN products in Spanish and omits writes for an auditor", async () => {
    const { user } = await setup({ locale: "es-US", readOnly: true });
    expect(await screen.findByText("Sin GTIN")).toBeTruthy();
    expect(screen.getByText("Activo")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Archivados" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Apple cups" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(product.id)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Añadir producto|Editar producto|Archivar producto/ }),
    ).toBeNull();
  });

  it("creates without GTIN and keeps unsaved content across locale changes", async () => {
    const { user, send, instance } = await setup();
    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.type(screen.getByLabelText("Product name"), "Pear cups");
    await act(() => instance.changeLanguage("es-US"));
    expect(screen.getByLabelText<HTMLInputElement>("Nombre del producto").value).toBe("Pear cups");
    await user.click(screen.getByRole("button", { name: "Guardar producto" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const mutation = send.mock.calls.find(([, init]) => init?.method === "POST");
    expect(mutation?.[0]).toBe(path);
    expect(mutation?.[1]?.body).toBe('{"name":"Pear cups","gtin":null}');
    expect(screen.getByText("Producto guardado.")).toBeTruthy();
  });

  it("focuses validation errors and sends no invalid product", async () => {
    const { user, send } = await setup();
    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.type(screen.getByLabelText("Product name"), "Pear cups");
    await user.type(screen.getByLabelText("GTIN (optional)"), "123");
    await user.click(screen.getByRole("button", { name: "Save product" }));
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    expect(screen.getByLabelText("GTIN (optional)").getAttribute("aria-invalid")).toBe("true");
    expect(send.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it.each(["create", "edit", "archive", "restore"])(
    "returns keyboard focus to the catalog after successful %s",
    async (action) => {
      const { user } = await setup({
        handle: (url) =>
          url === `${path}/${product.id}`
            ? Response.json({ ...product, archived: action === "restore" })
            : undefined,
      });
      if (action === "create") {
        await user.click(screen.getByRole("button", { name: "Add product" }));
        await user.type(screen.getByLabelText("Product name"), "Pear cups");
      } else {
        await user.click(await screen.findByRole("button", { name: "Apple cups" }));
        if (action === "edit") {
          await user.click(await screen.findByRole("button", { name: "Edit product" }));
          await user.type(screen.getByLabelText("Product name"), " revised");
        }
      }
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const label =
        action === "archive"
          ? "Archive product"
          : action === "restore"
            ? "Restore product"
            : "Save product";
      const submit = await screen.findByRole("button", { name: label });
      submit.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Products" })),
      );
    },
  );

  it.each(["product_gtin_taken", "product_gtin_locked"])(
    "retains edit on %s and permits a name-only retry",
    async (code) => {
      let rejected = false;
      const { user, send } = await setup({
        handle: (url, init) => {
          if (url === `${path}/${product.id}` && init?.method === "PATCH" && !rejected) {
            rejected = true;
            return Response.json({ code, message: "private" }, { status: 409 });
          }
          return undefined;
        },
      });
      await user.click(await screen.findByRole("button", { name: "Apple cups" }));
      await user.click(await screen.findByRole("button", { name: "Edit product" }));
      await user.type(screen.getByLabelText("GTIN (optional)"), "4006381333931");
      await user.click(screen.getByRole("button", { name: "Save product" }));
      expect(document.activeElement).toBe(await screen.findByRole("alert"));
      expect(screen.getByLabelText<HTMLInputElement>("GTIN (optional)").value).toBe(
        "4006381333931",
      );
      expect(screen.queryByText("private")).toBeNull();
      await user.clear(screen.getByLabelText("GTIN (optional)"));
      await user.clear(screen.getByLabelText("Product name"));
      await user.type(screen.getByLabelText("Product name"), "Pear cups");
      await user.click(screen.getByRole("button", { name: "Save product" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(send.mock.calls.filter(([, init]) => init?.method === "PATCH").at(-1)?.[1]?.body).toBe(
        '{"name":"Pear cups"}',
      );
    },
  );

  it("does not send an unchanged edit and confirms before discarding a draft", async () => {
    const { user, send } = await setup();
    await user.click(await screen.findByRole("button", { name: "Apple cups" }));
    await user.click(await screen.findByRole("button", { name: "Edit product" }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save product" }).disabled).toBe(
      true,
    );
    await user.type(screen.getByLabelText("Product name"), " revised");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    confirm.mockReturnValue(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(send.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("holds mutation ownership through list reload and blocks duplicate submission", async () => {
    let resolveResponse: (value: Response) => void = () => {
      throw new Error("Response promise not initialized");
    };
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    let created = false;
    const { user, send } = await setup({
      handle: (url, init) => {
        if (url === path && init?.method === "POST") {
          created = true;
          return Response.json(product);
        }
        if (created && url.startsWith(`${path}?`)) return response;
        return undefined;
      },
    });
    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.type(screen.getByLabelText("Product name"), "Pear cups");
    await user.dblClick(screen.getByRole("button", { name: "Save product" }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "← Profile" }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add product" }).disabled).toBe(
      true,
    );
    expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await act(async () =>
      resolveResponse(Response.json({ items: [product], limit: 50, offset: 0 })),
    );
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add product" }).disabled).toBe(
        false,
      ),
    );
  });

  it("archives only after confirmation and restores the same UUID", async () => {
    let archived = false;
    const { user, send } = await setup({
      handle: (url, init) => {
        if (url === `${path}/${product.id}`) {
          if (init?.method === "PATCH") archived = JSON.parse(String(init.body)).archived;
          return Response.json({ ...product, archived });
        }
        if (url.startsWith(`${path}?`))
          return Response.json({ items: [{ ...product, archived }], limit: 50, offset: 0 });
        return undefined;
      },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(await screen.findByRole("button", { name: "Apple cups" }));
    await user.click(await screen.findByRole("button", { name: "Archive product" }));
    expect(send.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Archive product" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Apple cups" }));
    await user.click(await screen.findByRole("button", { name: "Restore product" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      send.mock.calls
        .filter(([, init]) => init?.method === "PATCH")
        .map(([url, init]) => [url, init?.body]),
    ).toEqual([
      [`${path}/${product.id}`, '{"archived":true}'],
      [`${path}/${product.id}`, '{"archived":false}'],
    ]);
  });

  it("refreshes permissions after a denied save without losing the form", async () => {
    let denied = false;
    const { user } = await setup({
      handle: (url, init) => {
        if (url === path && init?.method === "POST") {
          denied = true;
          return Response.json({}, { status: 403 });
        }
        if (denied && url.endsWith("/access"))
          return Response.json({ capabilities: ["traceability.read"] });
        return undefined;
      },
    });
    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.type(screen.getByLabelText("Product name"), "Pear cups");
    await user.click(screen.getByRole("button", { name: "Save product" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save product" })).toBeNull());
    expect(screen.getByLabelText<HTMLInputElement>("Product name").value).toBe("Pear cups");
    expect(screen.getByLabelText<HTMLInputElement>("Product name").disabled).toBe(true);
  });

  it("exits the workspace on an expired catalog session", async () => {
    const { onSessionLost } = await setup({
      handle: (url) => (url.startsWith(path) ? Response.json({}, { status: 401 }) : undefined),
    });
    await waitFor(() => expect(onSessionLost).toHaveBeenCalled());
  });

  it("retains the denied draft across failed access refreshes and allows an explicit recovery", async () => {
    let denied = false;
    let recovered = false;
    const { user, send } = await setup({
      handle: (url, init) => {
        if (url === path && init?.method === "POST" && !recovered) {
          denied = true;
          return Response.json({}, { status: 403 });
        }
        if (denied && !recovered && url.endsWith("/access"))
          return Response.json({}, { status: 503 });
        return undefined;
      },
    });
    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.type(screen.getByLabelText("Product name"), "Pear cups");
    await user.type(screen.getByLabelText("GTIN (optional)"), "4006381333931");
    await user.click(screen.getByRole("button", { name: "Save product" }));
    const dialog = screen.getByRole("dialog");
    const retry = await within(dialog).findByRole<HTMLButtonElement>("button", {
      name: "Try again",
    });
    expect(screen.queryByRole("button", { name: "Save product" })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Product name").disabled).toBe(true);
    await user.click(retry);
    await waitFor(() => expect(retry.disabled).toBe(false));
    expect(screen.getByLabelText<HTMLInputElement>("Product name").value).toBe("Pear cups");
    expect(screen.getByLabelText<HTMLInputElement>("GTIN (optional)").value).toBe("4006381333931");
    expect(screen.queryByRole("button", { name: "Save product" })).toBeNull();
    recovered = true;
    await user.click(retry);
    await screen.findByRole("button", { name: "Save product" });
    expect(screen.getByLabelText<HTMLInputElement>("Product name").disabled).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Save product" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(send.mock.calls.filter(([, init]) => init?.method === "POST").at(-1)?.[1]?.body).toBe(
      '{"name":"Pear cups","gtin":"4006381333931"}',
    );
  });

  it.each(["empty capabilities", "denied access"])(
    "removes cached data when access is explicitly revoked with %s",
    async (mode) => {
      let denied = false;
      const { user } = await setup({
        handle: (url, init) => {
          if (url === path && init?.method === "POST") {
            denied = true;
            return Response.json({}, { status: 403 });
          }
          if (denied && url.endsWith("/access"))
            return mode === "denied access"
              ? Response.json({}, { status: 403 })
              : Response.json({ capabilities: [] });
          return undefined;
        },
      });
      await user.click(screen.getByRole("button", { name: "Add product" }));
      await user.type(screen.getByLabelText("Product name"), "Pear cups");
      await user.click(screen.getByRole("button", { name: "Save product" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.getByRole("alert").textContent).toBe(masterDataCopy["en-US"].md.readDenied);
      expect(screen.queryByRole("button", { name: "Apple cups" })).toBeNull();
    },
  );

  it("ignores old search responses and recovers a failed list without showing old rows as current", async () => {
    let releaseOld: (value: Response) => void = () => {
      throw new Error("Not initialized");
    };
    const old = new Promise<Response>((resolve) => {
      releaseOld = resolve;
    });
    let fail = true;
    const { user } = await setup({
      handle: (url) => {
        if (!url.startsWith(`${path}?`)) return undefined;
        const query = new URL(url, "http://localhost").searchParams.get("search");
        if (query === "old") return old;
        if (query === "new")
          return fail
            ? Response.json({}, { status: 503 })
            : Response.json({ items: [{ ...product, name: "New match" }], limit: 50, offset: 0 });
        return undefined;
      },
    });
    expect(await screen.findByRole("button", { name: "Apple cups" })).toBeTruthy();
    const search = screen.getByLabelText("Search products by name or GTIN");
    await user.type(search, "old");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByText("Refreshing products…")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apple cups" }).disabled).toBe(
      true,
    );
    await user.clear(search);
    await user.type(search, "new");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Products could not be loaded. Try again.")).toBeTruthy();
    await act(async () =>
      releaseOld(
        Response.json({ items: [{ ...product, name: "Old match" }], limit: 50, offset: 0 }),
      ),
    );
    expect(screen.queryByRole("button", { name: "Old match" })).toBeNull();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "New match" })).toBeTruthy();
  });

  it("keeps a closed detail closed when its delayed response arrives", async () => {
    let release: (value: Response) => void = () => {
      throw new Error("Not initialized");
    };
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { user } = await setup({
      handle: (url) => (url === `${path}/${product.id}` ? response : undefined),
    });
    await user.click(await screen.findByRole("button", { name: "Apple cups" }));
    expect(await screen.findByText("Loading product details…")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close product details" }));
    await act(async () => release(Response.json(product)));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends pagination and archived filters, then resets pagination on search", async () => {
    const { user, send } = await setup({
      handle: (url) =>
        url.startsWith(`${path}?`)
          ? Response.json({
              items: Array.from({ length: 50 }, (_, index) => ({
                ...product,
                id: `a0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
                name: `Product ${index}`,
              })),
              limit: 50,
              offset: new URL(url, "http://localhost").searchParams.get("offset") === "50" ? 50 : 0,
            })
          : undefined,
    });
    await screen.findByRole("button", { name: "Product 0" });
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(send.mock.calls.some(([url]) => String(url).includes("offset=50"))).toBe(true),
    );
    await user.selectOptions(screen.getByLabelText("Status"), "true");
    await waitFor(() =>
      expect(
        send.mock.calls.some(([url]) => String(url).includes("archived=true&limit=50&offset=0")),
      ).toBe(true),
    );
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await user.type(screen.getByLabelText("Search products by name or GTIN"), "Pear");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(send.mock.calls.at(-1)?.[0]).toBe(
        `${path}?archived=true&limit=50&offset=0&search=Pear`,
      ),
    );
  });
});
