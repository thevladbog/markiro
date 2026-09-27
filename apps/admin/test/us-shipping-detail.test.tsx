import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { finalizedRecord, renderShipping } from "./support/us-shipping-ui-fixture.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("renders frozen Shipping KDEs and recorded quantity without claiming dispatch or case selection", async () => {
  await renderShipping({ initial: finalizedRecord(), canShip: false });
  expect(await screen.findByRole("heading", { name: "SHP-26-0001" })).toBeTruthy();
  expect(screen.getByRole("article", { name: "Shipping detail" })).toBeTruthy();
  expect(screen.getAllByText("Harbor Market").length).toBeGreaterThan(0);
  expect(screen.getByText("200 Example Harbor Ave")).toBeTruthy();
  expect(screen.getByText("NRF-260915-APL01")).toBeTruthy();
  expect(screen.getAllByText("Fresh-cut apples").length).toBeGreaterThan(0);
  expect(screen.getByText("100 case")).toBeTruthy();
  expect(await screen.findByText(/Current recorded lot balance: 80 case/)).toBeTruthy();
  expect(screen.getByText("BOL-0916-H")).toBeTruthy();
  expect(screen.getByText("INV-2026-0916-047")).toBeTruthy();
  expect(screen.getByText(/recorded quantity is separate from case links/i)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Link cases" })).toBeNull();
});

it.each([
  [
    "en-US",
    "Ship-from description",
    "Recipient description",
    "Product description",
    "Source description",
    "Issuer",
    "Street address",
    "Brand",
    "GTIN",
  ],
  [
    "es-US",
    "Descripción del origen",
    "Descripción del destinatario",
    "Descripción del producto",
    "Descripción de la fuente",
    "Emisor",
    "Dirección",
    "Marca",
    "GTIN",
  ],
] as const)(
  "renders every typed frozen description field in %s",
  async (
    locale,
    shipFromLabel,
    recipientLabel,
    productLabel,
    sourceLabel,
    issuerLabel,
    streetLabel,
    brandLabel,
    gtinLabel,
  ) => {
    const record = finalizedRecord();
    if (!("snapshot" in record)) throw new Error("fixture must be finalized");
    const line = record.snapshot.items[0];
    const document = record.snapshot.documents[0];
    if (!line || !document) throw new Error("fixture must have a line and document");
    record.snapshot.finalizedAt = "2026-09-28T02:30:00.000Z";
    record.snapshot.shipFrom.phoneNumber = "+1 503 555 0131";
    record.snapshot.recipient.phoneNumber = "+1 503 555 0142";
    line.source = {
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: "https://supplier.example.test/Exact/Case?batch=0001",
      resolvedLocation: {
        ...record.snapshot.shipFrom,
        businessName: "Origin Orchard",
        address: { kind: "coordinates", latitude: "45.588", longitude: "-122.776" },
        city: "Salem",
        stateOrRegion: "OR",
        zipOrPostalCode: "97301",
        phoneNumber: "+1 503 555 0167",
      },
    };
    line.product.description.gtin = "00000096385074";
    document.issuer = {
      id: "c0000000-0000-4000-8000-000000000010",
      name: "River Documents",
      legalName: "River Documents LLC",
    };
    await renderShipping({ initial: record, locale, canShip: false });
    expect(await screen.findByRole("heading", { name: "SHP-26-0001" })).toBeTruthy();
    for (const label of [
      shipFromLabel,
      recipientLabel,
      productLabel,
      sourceLabel,
      issuerLabel,
      streetLabel,
      brandLabel,
      gtinLabel,
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    const labels =
      locale === "en-US"
        ? {
            business: "Business name",
            phone: "Phone",
            city: "City",
            state: "State or region",
            zip: "ZIP or postal code",
            country: "Country",
            countryCode: "Country code",
            locationId: "Location ID",
            partyId: "Party ID",
            coordinates: "Coordinates",
            productId: "Product ID",
            commodity: "Commodity",
            variety: "Variety",
            size: "Packaging size",
            style: "Packaging style",
            sourceKind: "Source kind",
            sourceReference: "Source reference",
            issuerLegal: "Issuer legal name",
            resolved: "Resolved location",
          }
        : {
            business: "Nombre comercial",
            phone: "Teléfono",
            city: "Ciudad",
            state: "Estado o región",
            zip: "Código postal",
            country: "País",
            countryCode: "Código de país",
            locationId: "ID de ubicación",
            partyId: "ID de entidad",
            coordinates: "Coordenadas",
            productId: "ID de producto",
            commodity: "Producto básico",
            variety: "Variedad",
            size: "Tamaño del envase",
            style: "Tipo de envase",
            sourceKind: "Tipo de fuente",
            sourceReference: "Referencia de origen",
            issuerLegal: "Razón social del emisor",
            resolved: "Ubicación resuelta",
          };
    const fact = (region: HTMLElement, label: string, value: string) => {
      const term = within(region)
        .getAllByText(label)
        .find((element) => element.tagName === "DT");
      expect(term?.parentElement?.querySelector("dd")?.textContent).toBe(value);
    };
    const shipFrom = screen.getByRole("region", { name: shipFromLabel });
    const recipient = screen.getByRole("region", { name: recipientLabel });
    const product = screen.getByRole("region", { name: productLabel });
    const source = screen.getByRole("region", { name: sourceLabel });
    const resolved = screen.getByRole("region", { name: labels.resolved });
    const documents = screen.getByRole("region", {
      name: locale === "en-US" ? "Reference documents" : "Documentos de referencia",
    });
    for (const [region, name, phone, address, city, zip] of [
      [
        shipFrom,
        "North River Fresh Foods",
        "+1 503 555 0131",
        "500 Example River Pkwy",
        "Portland",
        "97203",
      ],
      [
        recipient,
        "Harbor Market",
        "+1 503 555 0142",
        "200 Example Harbor Ave",
        "Portland",
        "97203",
      ],
    ] as const) {
      fact(region, labels.business, name);
      fact(region, labels.phone, phone);
      fact(region, streetLabel, address);
      fact(region, labels.city, city);
      fact(region, labels.state, "OR");
      fact(region, labels.zip, zip);
      fact(region, labels.country, "United States");
      fact(region, labels.countryCode, "US");
      fact(region, labels.partyId, "c0000000-0000-4000-8000-000000000009");
    }
    fact(shipFrom, labels.locationId, "c0000000-0000-4000-8000-000000000005");
    fact(recipient, labels.locationId, "c0000000-0000-4000-8000-000000000006");
    fact(product, labels.productId, "c0000000-0000-4000-8000-000000000004");
    fact(product, productLabel, "Fresh-cut apples");
    fact(product, brandLabel, "North River");
    fact(product, labels.commodity, "Fruit");
    fact(product, labels.variety, "Honeycrisp");
    fact(product, labels.size, "1 case");
    fact(product, labels.style, "Sealed case");
    fact(product, gtinLabel, "00000096385074");
    fact(source, labels.sourceKind, locale === "en-US" ? "Web URL" : "URL web");
    fact(source, labels.sourceReference, "https://supplier.example.test/Exact/Case?batch=0001");
    fact(resolved, labels.business, "Origin Orchard");
    fact(resolved, labels.phone, "+1 503 555 0167");
    fact(resolved, labels.coordinates, "45.588, -122.776");
    fact(resolved, labels.city, "Salem");
    fact(resolved, labels.state, "OR");
    fact(resolved, labels.zip, "97301");
    fact(resolved, labels.country, "United States");
    fact(resolved, labels.countryCode, "US");
    fact(resolved, labels.locationId, "c0000000-0000-4000-8000-000000000005");
    fact(resolved, labels.partyId, "c0000000-0000-4000-8000-000000000009");
    const bol = within(documents).getByText("BOL-0916-H").closest("li");
    if (!bol) throw new Error("BOL must have a document row");
    fact(bol, issuerLabel, "River Documents");
    fact(bol, labels.issuerLegal, "River Documents LLC");
    expect(screen.getByText("09/27/2026")).toBeTruthy();
    expect(screen.getByText(/09\/27\/2026 21:30/)).toBeTruthy();
    expect(screen.queryByText("09/28/2026 02:30")).toBeNull();
  },
);
