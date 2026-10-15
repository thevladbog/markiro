import { canonicalExportEqual } from "./us-demo-canonical.js";

import {
  createUsLocationSchema,
  createUsPartySchema,
  createUsProductSchema,
  platformUuidSchema,
  productTraceabilityProfileSchema,
  putProductTraceabilityProfileSchema,
  referenceDocumentInputSchema,
  referenceDocumentSchema,
  usLocationSchema,
  usPartySchema,
  usProductSchema,
  type CreateUsLocation,
  type CreateUsParty,
  type CreateUsProductInput,
  type ProductTraceabilityProfile,
  type PutProductTraceabilityProfile,
  type ReferenceDocument,
  type ReferenceDocumentInput,
  type UsLocation,
  type UsParty,
  type UsProduct,
} from "@markiro/platform-contracts";
import { z } from "zod";
import { usDemoDefinition, usDemoDefinitionDigest } from "./us-demo-definition.js";

export type UsDemoPartyKey = "previous_source" | "processor" | "recipient";
export type UsDemoProductKey = "inbound" | "output";
export type UsDemoDocumentKey =
  | "receiving_asn"
  | "receiving_bol"
  | "transformation_work_order"
  | "transformation_batch"
  | "shipping_bol"
  | "shipping_invoice";
export type UsDemoReferenceBindings = Readonly<{
  parties: Readonly<Record<UsDemoPartyKey, string>>;
  locations: Readonly<Record<UsDemoPartyKey, string>>;
  products: Readonly<Record<UsDemoProductKey, string>>;
  documents: Readonly<Record<UsDemoDocumentKey, string>>;
}>;
export type UsDemoReferenceResult = Readonly<{
  recipeVersion: 1;
  bindings: UsDemoReferenceBindings;
  evidence: Readonly<{
    parties: readonly UsParty[];
    locations: readonly UsLocation[];
    products: readonly UsProduct[];
    profiles: readonly ProductTraceabilityProfile[];
    documents: readonly ReferenceDocument[];
  }>;
}>;
export type UsDemoReferenceRecipe = Readonly<{
  recipeVersion: 1;
  definitionDigest: string;
  parties: readonly Readonly<{ key: UsDemoPartyKey; input: CreateUsParty }>[];
  locations: readonly Readonly<{
    key: UsDemoPartyKey;
    partyKey: UsDemoPartyKey;
    input: Omit<CreateUsLocation, "partyId">;
  }>[];
  products: readonly Readonly<{
    key: UsDemoProductKey;
    input: CreateUsProductInput;
    profile: PutProductTraceabilityProfile;
  }>[];
  documents: readonly Readonly<{
    key: UsDemoDocumentKey;
    partyKey: UsDemoPartyKey;
    input: Omit<ReferenceDocumentInput, "partyId">;
  }>[];
}>;

const partyBindingSchema = z
  .object({
    previous_source: platformUuidSchema,
    processor: platformUuidSchema,
    recipient: platformUuidSchema,
  })
  .strict();
const productBindingSchema = z
  .object({ inbound: platformUuidSchema, output: platformUuidSchema })
  .strict();
const documentBindingSchema = z
  .object({
    receiving_asn: platformUuidSchema,
    receiving_bol: platformUuidSchema,
    transformation_work_order: platformUuidSchema,
    transformation_batch: platformUuidSchema,
    shipping_bol: platformUuidSchema,
    shipping_invoice: platformUuidSchema,
  })
  .strict();
const resultSchema = z
  .object({
    recipeVersion: z.literal(1),
    bindings: z
      .object({
        parties: partyBindingSchema,
        locations: partyBindingSchema,
        products: productBindingSchema,
        documents: documentBindingSchema,
      })
      .strict(),
    evidence: z
      .object({
        parties: z.array(usPartySchema).length(3),
        locations: z.array(usLocationSchema).length(3),
        products: z.array(usProductSchema).length(2),
        profiles: z.array(productTraceabilityProfileSchema).length(2),
        documents: z.array(referenceDocumentSchema).length(6),
      })
      .strict(),
  })
  .strict();

export function parseUsDemoReferenceResult(raw: unknown): UsDemoReferenceResult {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) throw new Error("us_demo_reference_mismatch");
  const result = parsed.data;
  const groups = ["parties", "locations", "products", "documents"] as const;
  const ids = groups.flatMap((group) => Object.values(result.bindings[group]));
  if (
    new Set(ids).size !== 14 ||
    groups.some((group) =>
      Object.values(result.bindings[group]).some(
        (id, index) => result.evidence[group][index]?.id !== id,
      ),
    ) ||
    result.evidence.profiles.some(
      (profile, index) => profile.productId !== result.evidence.products[index]?.id,
    ) ||
    !canonicalExportEqual(raw, result)
  )
    throw new Error("us_demo_reference_mismatch");
  return result;
}

/** Fresh JSON inputs; persisted stage input pins this complete recipe separately from the descriptor. */
export function makeUsDemoReferenceRecipe(): UsDemoReferenceRecipe {
  const parentPlaceholder = "00000000-0000-4000-8000-000000000000";
  const addresses: Readonly<Record<UsDemoPartyKey, readonly [string, string, string, string]>> = {
    previous_source: ["100 Example Orchard Rd", "Yakima", "WA", "98901"],
    processor: ["500 Example River Pkwy", "Portland", "OR", "97203"],
    recipient: ["200 Example Harbor Ave", "Seattle", "WA", "98134"],
  };
  const roles: Readonly<Record<UsDemoPartyKey, CreateUsLocation["roles"]>> = {
    previous_source: ["supplier", "tlc_source"],
    processor: ["processor", "receive_at", "ship_from", "tlc_source"],
    recipient: ["recipient"],
  };
  const documentSpecs: readonly Readonly<{
    key: UsDemoDocumentKey;
    partyKey: UsDemoPartyKey;
    type: ReferenceDocumentInput["type"];
    number: string;
    issuedOn: string;
  }>[] = [
    {
      key: "receiving_asn",
      partyKey: "previous_source",
      type: "asn",
      number: usDemoDefinition.receiving.references[0],
      issuedOn: usDemoDefinition.receiving.eventDate,
    },
    {
      key: "receiving_bol",
      partyKey: "previous_source",
      type: "bol",
      number: usDemoDefinition.receiving.references[1],
      issuedOn: usDemoDefinition.receiving.eventDate,
    },
    {
      key: "transformation_work_order",
      partyKey: "processor",
      type: "work_order",
      number: usDemoDefinition.transformation.references[0],
      issuedOn: usDemoDefinition.transformation.eventDate,
    },
    {
      key: "transformation_batch",
      partyKey: "processor",
      type: "batch_log",
      number: usDemoDefinition.transformation.references[1],
      issuedOn: usDemoDefinition.transformation.eventDate,
    },
    {
      key: "shipping_bol",
      partyKey: "recipient",
      type: "bol",
      number: usDemoDefinition.shipping.references[0],
      issuedOn: usDemoDefinition.shipping.eventDate,
    },
    {
      key: "shipping_invoice",
      partyKey: "recipient",
      type: "invoice",
      number: usDemoDefinition.shipping.references[1],
      issuedOn: usDemoDefinition.shipping.eventDate,
    },
  ];
  return {
    recipeVersion: 1,
    definitionDigest: usDemoDefinitionDigest,
    parties: usDemoDefinition.parties.map(({ key, name, phone }) => ({
      key,
      input: createUsPartySchema.parse({
        name,
        legalName: name,
        contactName: null,
        contactPhone: phone,
        contactEmail: null,
        notes: null,
      }),
    })),
    locations: usDemoDefinition.parties.map(({ key, name, phone }) => {
      const [streetAddress, city, stateOrRegion, zipOrPostalCode] = addresses[key];
      const { partyId: _parent, ...input } = createUsLocationSchema.parse({
        partyId: parentPlaceholder,
        name,
        businessName: name,
        phoneNumber: phone,
        addressKind: "street",
        streetAddress,
        latitude: null,
        longitude: null,
        city,
        stateOrRegion,
        zipOrPostalCode,
        countryCode: "US",
        roles: [...roles[key]],
      });
      void _parent;
      return { key, partyKey: key, input };
    }),
    products: usDemoDefinition.products.map(({ key, description, brand }) => ({
      key,
      input: createUsProductSchema.parse({ name: description, gtin: null }),
      profile: putProductTraceabilityProfileSchema.parse({
        expectedRevision: 0,
        productName: description,
        brandName: brand,
        commodity: "Apples",
        variety: key === "inbound" ? "Red Delicious" : null,
        packagingSizeValue: key === "inbound" ? "10" : "6",
        packagingSizeUom: key === "inbound" ? "lb" : "oz",
        packagingStyle: key === "inbound" ? "bag" : "cup, 24 cups/case",
        defaultQuantityUom: key === "inbound" ? "lb" : "case",
        coverageStatus: "covered",
        coverageRationale:
          "Synthetic demo manual review of a fresh-cut fruit fixture; not an operational assessment.",
        ftlCategory: "Fruits (fresh-cut)",
        ftlSourceUrl:
          "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
        ftlSourceVersion: "markiro-us-synthetic-ftl-review-v1",
      }),
    })),
    documents: documentSpecs.map(({ key, partyKey, ...document }) => {
      const { partyId: _parent, ...input } = referenceDocumentInputSchema.parse({
        ...document,
        partyId: parentPlaceholder,
        typeOtherLabel: null,
        notes: "Synthetic demo metadata only; no source attachment.",
      });
      void _parent;
      return { key, partyKey, input };
    }),
  };
}
