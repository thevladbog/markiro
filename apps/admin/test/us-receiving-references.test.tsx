import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import i18next from "i18next";
import { StrictMode, useState, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { ReceivingDocumentSection } from "../src/us/receiving/document-section.js";
import { referenceCopy } from "../src/us/receiving/reference-copy.js";
import { ReceivingReferencePicker } from "../src/us/receiving/reference-picker.js";

const ids = Array.from(
  { length: 103 },
  (_, index) => `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
const timestamp = "2026-09-07T00:00:00.000Z";

const product = {
  id: ids[0]!,
  name: "Apple slices",
  gtin14: null,
  archived: false,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const location = {
  id: ids[1]!,
  partyId: ids[2]!,
  name: "Receiving dock",
  businessName: "North River Fresh Foods",
  phoneNumber: null,
  addressKind: "street" as const,
  streetAddress: null,
  latitude: null,
  longitude: null,
  city: "Portland",
  stateOrRegion: "OR",
  zipOrPostalCode: null,
  countryCode: "US",
  roles: ["receive_at" as const],
  archived: false,
  createdAt: timestamp,
  updatedAt: timestamp,
  descriptionStatus: { exportReady: false, issues: [] },
};
const lot = {
  id: ids[3]!,
  productId: product.id,
  tlc: "TLC-APPLE-01",
  source: null,
  assignmentBasis: "imported" as const,
  sourceLockedAt: null,
  status: "active" as const,
  revision: 1,
  createdBy: "actor",
  updatedBy: "actor",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const party = {
  id: ids[2]!,
  name: "Orchard Slice Supply",
  legalName: null,
  contactName: null,
  contactPhone: null,
  contactEmail: null,
  notes: null,
  archived: false,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const document = {
  id: ids[4]!,
  type: "bol" as const,
  typeOtherLabel: null,
  number: "BOL-0914-A",
  partyId: party.id,
  issuedOn: "2026-09-14",
  notes: null,
  archivedAt: null,
  createdBy: "actor",
  createdAt: timestamp,
  updatedAt: timestamp,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function renderUs(node: ReactNode, locale: "en-US" | "es-US" = "en-US") {
  const instance = i18next.createInstance();
  void instance.init({
    resources: {
      "en-US": { translation: { receivingRef: referenceCopy["en-US"] } },
      "es-US": { translation: { receivingRef: referenceCopy["es-US"] } },
    },
    lng: locale,
    fallbackLng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  return render(
    <ThemeProvider defaultTheme="light">
      <I18nextProvider i18n={instance}>{node}</I18nextProvider>
    </ThemeProvider>,
  );
}

function pathOf(input: RequestInfo | URL): URL {
  return new URL(String(input), "http://markiro.test");
}

describe("receiving reference picker", () => {
  it.each([
    ["product", product.id, product.name, "/catalog/products", product],
    ["location", location.id, location.name, "/locations", location],
    ["lot", lot.id, lot.tlc, "/lots", lot],
    ["document", document.id, document.number, "/reference-documents", document],
    ["party", party.id, party.name, "/parties", party],
  ] as const)(
    "preserves an off-page %s selection and loads its readable label",
    async (kind, selectedId, selectedLabel, route, detail) => {
      const send = vi.fn<typeof fetch>(async (input) => {
        const url = pathOf(input);
        if (url.pathname.endsWith(`/${selectedId}`)) return json(detail);
        if (url.pathname.endsWith(route)) return json({ items: [], limit: 50, offset: 0 });
        throw new Error(`Unexpected request: ${url.pathname}`);
      });
      renderUs(
        <ReceivingReferencePicker
          client={createUsBrowserClient(send)}
          kind={kind}
          label="Reference"
          value={selectedId}
          disabled
          onChange={vi.fn()}
          onSessionLost={vi.fn()}
          onForbidden={vi.fn()}
          {...(kind === "lot" ? { productId: product.id } : {})}
          {...(kind === "location" ? { roles: ["receive_at", "tlc_source"] as const } : {})}
        />,
      );

      expect(await screen.findByRole("option", { name: selectedLabel })).toBeTruthy();
      expect((screen.getByLabelText("Reference") as HTMLSelectElement).value).toBe(selectedId);
      expect(screen.getAllByText("Reference")).toHaveLength(1);
      const listUrl = send.mock.calls
        .map(([input]) => pathOf(input))
        .find((url) => url.pathname.endsWith(route) && url.search.length > 0);
      expect(listUrl?.searchParams.get("limit")).toBe("50");
      expect(listUrl?.searchParams.get("offset")).toBe("0");
      if (kind === "lot") {
        expect(listUrl?.searchParams.get("status")).toBe("active");
        expect(listUrl?.searchParams.get("productId")).toBe(product.id);
      } else {
        expect(listUrl?.searchParams.get("archived")).toBe("false");
      }
      if (kind === "location")
        expect(listUrl?.searchParams.getAll("roles")).toEqual(["receive_at", "tlc_source"]);
    },
  );

  it("prioritizes session loss when parallel detail and list lookups return different denials", async () => {
    const onSessionLost = vi.fn();
    const onForbidden = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn<typeof fetch>(async (input) =>
      pathOf(input).pathname.endsWith(`/${product.id}`)
        ? json({ code: "hidden" }, 401)
        : json({ code: "hidden" }, 403),
    );
    renderUs(
      <ReceivingReferencePicker
        client={createUsBrowserClient(send)}
        kind="product"
        label="Product"
        value={product.id}
        disabled={false}
        onChange={vi.fn()}
        onSessionLost={onSessionLost}
        onForbidden={onForbidden}
      />,
    );

    await screen.findByRole("alert");
    expect(onSessionLost).toHaveBeenCalledTimes(1);
    expect(onForbidden).not.toHaveBeenCalled();
  });

  it.each([
    [401, "session_required", "session"],
    [403, "forbidden", "forbidden"],
  ] as const)(
    "propagates %s even when the list lookup also fails",
    async (status, _code, expectedCallback) => {
      const onSessionLost = vi.fn();
      const onForbidden = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn<typeof fetch>(async (input) => {
        const url = pathOf(input);
        return url.pathname.endsWith(`/${product.id}`)
          ? json({ code: "hidden" }, status)
          : json({ code: "unavailable" }, 500);
      });
      renderUs(
        <ReceivingReferencePicker
          client={createUsBrowserClient(send)}
          kind="product"
          label="Product"
          value={product.id}
          disabled={false}
          onChange={vi.fn()}
          onSessionLost={onSessionLost}
          onForbidden={onForbidden}
        />,
      );

      await screen.findByRole("alert");
      await waitFor(() =>
        expect(expectedCallback === "session" ? onSessionLost : onForbidden).toHaveBeenCalledTimes(
          1,
        ),
      );
      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it("searches on Enter without submitting its parent editor form", async () => {
    const submitted = vi.fn((event: React.FormEvent) => event.preventDefault());
    const send = vi.fn<typeof fetch>(async (input) => {
      const url = pathOf(input);
      if (url.pathname.endsWith("/catalog/products"))
        return json({ items: [], limit: 50, offset: Number(url.searchParams.get("offset")) });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    renderUs(
      <form onSubmit={submitted}>
        <ReceivingReferencePicker
          client={createUsBrowserClient(send)}
          kind="product"
          label="Product"
          value=""
          disabled={false}
          onChange={vi.fn()}
          onSessionLost={vi.fn()}
          onForbidden={vi.fn()}
        />
      </form>,
    );
    const user = userEvent.setup();
    await screen.findByText("No active references match this search.");
    await user.type(screen.getByLabelText("Search active products"), "apple{Enter}");

    await waitFor(() =>
      expect(
        send.mock.calls.some(([input]) => pathOf(input).searchParams.get("search") === "apple"),
      ).toBe(true),
    );
    expect(submitted).not.toHaveBeenCalled();
    expect(screen.queryByText("Page 1")).toBeNull();
  });

  it("keeps pagination after navigating from a full first page to an empty later page", async () => {
    const products = Array.from({ length: 50 }, (_, index) => ({
      ...product,
      id: ids[index]!,
      name: `Product ${index + 1}`,
    }));
    const send = vi.fn<typeof fetch>(async (input) => {
      const url = pathOf(input);
      if (!url.pathname.endsWith("/catalog/products"))
        throw new Error(`Unexpected request: ${url.pathname}`);
      const offset = Number(url.searchParams.get("offset"));
      return json({ items: offset === 0 ? products : [], limit: 50, offset });
    });
    renderUs(
      <ReceivingReferencePicker
        client={createUsBrowserClient(send)}
        kind="product"
        label="Product"
        value=""
        disabled={false}
        onChange={vi.fn()}
        onSessionLost={vi.fn()}
        onForbidden={vi.fn()}
      />,
    );

    expect(await screen.findByText("Page 1")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Page 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeTruthy();
    expect(screen.getByText("No active references match this search.")).toBeTruthy();
  });

  it("renders the picker states in U.S. Spanish", async () => {
    const send = vi.fn<typeof fetch>(async () => json({ items: [], limit: 50, offset: 0 }));
    renderUs(
      <ReceivingReferencePicker
        client={createUsBrowserClient(send)}
        kind="product"
        label="Producto"
        value=""
        disabled={false}
        onChange={vi.fn()}
        onSessionLost={vi.fn()}
        onForbidden={vi.fn()}
      />,
      "es-US",
    );

    expect(await screen.findByLabelText("Buscar productos activos")).toBeTruthy();
    expect(screen.getByText("Ninguna referencia activa coincide con esta búsqueda.")).toBeTruthy();
  });
});

describe("receiving document section", () => {
  function documentTransport(options: { create?: Response[] } = {}) {
    const createResponses = [...(options.create ?? [])];
    return vi.fn<typeof fetch>(async (input, init) => {
      const url = pathOf(input);
      if (url.pathname.endsWith("/reference-documents") && init?.method === "POST")
        return createResponses.shift() ?? json(document);
      if (url.pathname.endsWith("/reference-documents"))
        return json({
          items: [document, { ...document, id: ids[5]!, number: "ASN-0914" }],
          limit: 50,
          offset: 0,
        });
      if (url.pathname.includes("/reference-documents/")) {
        const id = url.pathname.split("/").at(-1)!;
        return json({
          ...document,
          id,
          number: id === document.id ? document.number : `DOC-${id.slice(-3)}`,
        });
      }
      if (url.pathname.endsWith("/parties")) return json({ items: [party], limit: 50, offset: 0 });
      if (url.pathname.endsWith(`/parties/${party.id}`)) return json(party);
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
  }

  function Harness({
    send,
    initial = [],
    disabled = false,
    onDirtyChange = vi.fn(),
    beginMutation = vi.fn(() => vi.fn()),
  }: {
    send: typeof fetch;
    initial?: string[];
    disabled?: boolean;
    onDirtyChange?: (dirty: boolean) => void;
    beginMutation?: () => () => void;
  }) {
    const [documentIds, setDocumentIds] = useState(initial);
    return (
      <ReceivingDocumentSection
        client={createUsBrowserClient(send)}
        documentIds={documentIds}
        disabled={disabled}
        onChange={setDocumentIds}
        onSessionLost={vi.fn()}
        onForbidden={vi.fn()}
        beginMutation={beginMutation}
        onDirtyChange={onDirtyChange}
      />
    );
  }

  it("keeps attachment order and rejects duplicate document links", async () => {
    const send = documentTransport();
    renderUs(<Harness send={send} initial={[document.id]} />);
    const user = userEvent.setup();
    const chooser = (await screen.findByLabelText("Reference document")) as HTMLSelectElement;

    await user.selectOptions(chooser, document.id);
    await user.click(screen.getByRole("button", { name: "Attach document" }));
    expect(await screen.findByText("This document is already attached.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Detach document" })).toHaveLength(1);

    await user.selectOptions(chooser, ids[5]!);
    await user.click(screen.getByRole("button", { name: "Attach document" }));
    const rows = await screen.findAllByRole("button", { name: "Detach document" });
    expect(rows).toHaveLength(2);
    expect(
      screen.getAllByRole("listitem").map((row) => row.querySelector("span")?.textContent),
    ).toEqual([document.number, "DOC-006"]);

    await user.click(rows[0]!);
    expect(
      screen.getAllByRole("listitem").map((row) => row.querySelector("span")?.textContent),
    ).toEqual(["DOC-006"]);
    expect(send.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("refuses a 101st document without calling the change handler", async () => {
    const send = documentTransport();
    renderUs(<Harness send={send} initial={ids.slice(0, 100)} />);

    expect(await screen.findByText("A receiving draft can have up to 100 documents.")).toBeTruthy();
    await userEvent.click(screen.getByText("Create document metadata"));
    expect(
      (screen.getByRole("button", { name: "Attach document" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Create and attach" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("gates creation by receiving write access and validates metadata before HTTP", async () => {
    const send = documentTransport();
    renderUs(<Harness send={send} disabled />);
    const createSummary = screen.getByText("Create document metadata");
    expect((createSummary.parentElement as HTMLDetailsElement).open).toBe(false);
    await userEvent.click(createSummary);
    expect((createSummary.parentElement as HTMLDetailsElement).open).toBe(true);
    expect(
      ((await screen.findByRole("button", { name: "Create and attach" })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((screen.getByLabelText("Document number") as HTMLInputElement).disabled).toBe(true);
    cleanup();
    renderUs(<Harness send={send} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Create document metadata"));
    await user.click(screen.getByRole("button", { name: "Create and attach" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Check the document metadata.",
    );
    expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("does not load issuing parties until the compact creator is expanded", async () => {
    const send = documentTransport();
    renderUs(<Harness send={send} />);
    await screen.findByLabelText("Reference document");
    expect(send.mock.calls.some(([input]) => pathOf(input).pathname.endsWith("/parties"))).toBe(
      false,
    );

    await userEvent.click(screen.getByText("Create document metadata"));
    await waitFor(() =>
      expect(send.mock.calls.some(([input]) => pathOf(input).pathname.endsWith("/parties"))).toBe(
        true,
      ),
    );
  });

  it("creates validated metadata under the global mutation guard and attaches the result", async () => {
    const send = documentTransport();
    const release = vi.fn();
    const beginMutation = vi.fn(() => release);
    const dirty = vi.fn();
    const { unmount } = renderUs(
      <Harness send={send} beginMutation={beginMutation} onDirtyChange={dirty} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("Create document metadata"));
    await screen.findByLabelText("Document number");
    await user.type(screen.getByLabelText("Document number"), "  BOL-0914-A  ");
    await user.selectOptions(screen.getByLabelText("Issuing party"), party.id);
    await user.type(screen.getByLabelText("Issued on"), "2026-09-14");
    await user.type(screen.getByLabelText("Notes"), "  Driver copy  ");
    await user.click(screen.getByRole("button", { name: "Create and attach" }));

    await screen.findByText("Document created and attached.");
    const post = send.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      type: "bol",
      typeOtherLabel: null,
      number: "BOL-0914-A",
      partyId: party.id,
      issuedOn: "2026-09-14",
      notes: "Driver copy",
    });
    expect(beginMutation).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenCalledWith(true);
    expect(dirty).toHaveBeenLastCalledWith(false);
    unmount();
    expect(dirty).toHaveBeenLastCalledWith(false);
  });

  it("keeps create callbacks live through the development StrictMode effect probe", async () => {
    const send = documentTransport();
    renderUs(
      <StrictMode>
        <Harness send={send} />
      </StrictMode>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("Create document metadata"));
    await user.type(screen.getByLabelText("Document number"), "BOL-0914-A");
    await user.click(screen.getByRole("button", { name: "Create and attach" }));

    expect(await screen.findByText("Document created and attached.")).toBeTruthy();
  });

  it("clears unsaved inline metadata and releases the parent dirty guard", async () => {
    const dirty = vi.fn();
    renderUs(<Harness send={documentTransport()} onDirtyChange={dirty} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Create document metadata"));
    await user.type(screen.getByLabelText("Document number"), "BOL-DRAFT");
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(true));

    await user.click(screen.getByRole("button", { name: "Clear document metadata" }));
    expect((screen.getByLabelText("Document number") as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
  });

  it("freezes an uncertain create until explicit same-input retry and directs duplicates to search", async () => {
    const send = documentTransport({
      create: [json({ code: "unavailable" }, 500), json({ code: "document_duplicate" }, 409)],
    });
    renderUs(<Harness send={send} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Create document metadata"));
    await screen.findByLabelText("Document number");
    await user.type(screen.getByLabelText("Document number"), "BOL-0914-A");
    await user.click(screen.getByRole("button", { name: "Create and attach" }));

    expect(
      await screen.findByText(
        "The create result could not be confirmed. This document may already exist. Retry only with the same metadata.",
      ),
    ).toBeTruthy();
    expect((screen.getByLabelText("Document number") as HTMLInputElement).disabled).toBe(true);
    expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Retry same creation" }));
    expect(
      await screen.findByText(
        "A document with this identity already exists. Search for and attach it.",
      ),
    ).toBeTruthy();
    const posts = send.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.[1]?.body).toBe(posts[0]?.[1]?.body);
  });

  it("admits only one create while two clicks land before React disables the button", async () => {
    let resolveCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const send = vi.fn<typeof fetch>(async (input, init) => {
      const url = pathOf(input);
      if (url.pathname.endsWith("/reference-documents") && init?.method === "POST")
        return createResponse;
      if (url.pathname.endsWith("/reference-documents"))
        return json({ items: [], limit: 50, offset: 0 });
      if (url.pathname.endsWith("/parties")) return json({ items: [], limit: 50, offset: 0 });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const onChange = vi.fn();
    const release = vi.fn();
    renderUs(
      <ReceivingDocumentSection
        client={createUsBrowserClient(send)}
        documentIds={[]}
        disabled={false}
        onChange={onChange}
        onSessionLost={vi.fn()}
        onForbidden={vi.fn()}
        beginMutation={() => release}
        onDirtyChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByText("Create document metadata"));
    await userEvent.type(screen.getByLabelText("Document number"), "BOL-0914-A");
    const create = screen.getByRole("button", { name: "Create and attach" });
    fireEvent.click(create);
    fireEvent.click(create);

    expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    resolveCreate(json(document));
    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith([document.id]);
  });

  it("releases the mutation without calling parent state after an in-flight create unmounts", async () => {
    let resolveCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const send = vi.fn<typeof fetch>(async (input, init) => {
      const url = pathOf(input);
      if (url.pathname.endsWith("/reference-documents") && init?.method === "POST")
        return createResponse;
      if (url.pathname.endsWith("/reference-documents"))
        return json({ items: [], limit: 50, offset: 0 });
      if (url.pathname.endsWith("/parties")) return json({ items: [], limit: 50, offset: 0 });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const onChange = vi.fn();
    const release = vi.fn();
    const rendered = renderUs(
      <ReceivingDocumentSection
        client={createUsBrowserClient(send)}
        documentIds={[]}
        disabled={false}
        onChange={onChange}
        onSessionLost={vi.fn()}
        onForbidden={vi.fn()}
        beginMutation={() => release}
        onDirtyChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByText("Create document metadata"));
    await userEvent.type(screen.getByLabelText("Document number"), "BOL-0914-A");
    fireEvent.click(screen.getByRole("button", { name: "Create and attach" }));
    rendered.unmount();
    resolveCreate(json(document));

    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(onChange).not.toHaveBeenCalled();
  });
});
