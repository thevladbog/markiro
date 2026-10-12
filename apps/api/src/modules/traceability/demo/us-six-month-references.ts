import {
  createUsLocationSchema,
  createUsPartySchema,
  createUsProductSchema,
  putProductTraceabilityProfileSchema,
  type CreateUsLocation,
  type CreateUsParty,
  type CreateUsProductInput,
  type PutProductTraceabilityProfile,
} from "@markiro/platform-contracts";
import { makeUsDemoReferenceRecipe } from "./us-demo-reference-recipe.js";

export type UsSixMonthCatalogue = Readonly<{
  parties: readonly Readonly<{ key: string; input: CreateUsParty }>[];
  locations: readonly Readonly<{
    key: string;
    partyKey: string;
    input: Omit<CreateUsLocation, "partyId">;
  }>[];
  products: readonly Readonly<{
    key: string;
    input: CreateUsProductInput;
    profile: PutProductTraceabilityProfile;
  }>[];
}>;

/** Called solely on owned copies of validated JSON. */
function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

/** Fictional reference inputs only; identities and actual review stamps belong to execution. */
export function makeUsSixMonthCatalogue(): UsSixMonthCatalogue {
  const compact = makeUsDemoReferenceRecipe();
  const parties: { key: string; input: CreateUsParty }[] = [...compact.parties];
  const locations: {
    key: string;
    partyKey: string;
    input: Omit<CreateUsLocation, "partyId">;
  }[] = [...compact.locations];
  const products: {
    key: string;
    input: CreateUsProductInput;
    profile: PutProductTraceabilityProfile;
  }[] = [...compact.products];
  const ordinalText = (ordinal: number) => String(ordinal).padStart(2, "0");
  const addedSupplierOrdinals = Array.from({ length: 9 }, (_, index) => index + 2);
  const addedRecipientOrdinals = Array.from({ length: 11 }, (_, index) => index + 2);
  for (const [kind, ordinals, compactKey, stem, phonePrefix, street] of [
    [
      "supplier",
      addedSupplierOrdinals,
      "previous_source",
      "Orchard Supply",
      "509",
      "Example Orchard Rd",
    ],
    [
      "recipient",
      addedRecipientOrdinals,
      "recipient",
      "Market Distribution",
      "206",
      "Example Harbor Ave",
    ],
  ] as const) {
    const template = compact.locations.find(({ key }) => key === compactKey);
    if (!template) throw new Error("us_six_month_catalogue_template_missing");
    for (const ordinal of ordinals) {
      const text = ordinalText(ordinal);
      const key = `${kind}_${text}`;
      const name = `Example ${stem} ${text} LLC`;
      const phone = `+1 ${phonePrefix}-555-01${text}`;
      parties.push({
        key,
        input: createUsPartySchema.parse({
          name,
          legalName: name,
          contactName: null,
          contactPhone: phone,
          contactEmail: null,
          notes: null,
        }),
      });
      const { partyId: _parent, ...input } = createUsLocationSchema.parse({
        ...template.input,
        partyId: "00000000-0000-4000-8000-000000000000",
        name,
        businessName: name,
        phoneNumber: phone,
        streetAddress: `${text}00 ${street}`,
      });
      void _parent;
      locations.push({ key, partyKey: key, input });
    }
  }
  const varieties = [
    "Red Delicious",
    "Gala",
    "Fuji",
    "Granny Smith",
    "Honeycrisp",
    "Golden Delicious",
    "Pink Lady",
    "Braeburn",
  ] as const;
  for (const [kind, suffix] of [
    ["inbound", "Slices"],
    ["output", "Snack Cups"],
  ] as const) {
    const template = compact.products.find(({ key }) => key === kind);
    if (!template) throw new Error("us_six_month_catalogue_template_missing");
    for (const [index, variety] of varieties.entries()) {
      if (index === 0) continue;
      const name = `Fresh-Cut ${variety} Apple ${suffix}`;
      products.push({
        key: `${kind}_${ordinalText(index + 1)}`,
        input: createUsProductSchema.parse({ name, gtin: null }),
        profile: putProductTraceabilityProfileSchema.parse({
          ...template.profile,
          productName: name,
          variety,
        }),
      });
    }
  }
  return freezeOwned(structuredClone({ parties, locations, products }));
}
