import { newImageCheckpoint } from "./national-catalog-image-state";
import {
  resolveCatalogProductGroup,
  type CatalogCategoryGroup,
  type CatalogProductGroupEntry,
} from "./national-catalog-product-group";
import { chooseDefaultPhoto } from "./national-catalog-photo-selection";
import { randomUUID } from "node:crypto";
import {
  catalogProductFieldForLabel,
  productFieldEntrySchema,
  readCatalogProductFields,
  type CatalogProductFieldEntry,
} from "./national-catalog-product-fields";
import { isDeepStrictEqual } from "node:util";
import { ConflictException, UnprocessableEntityException } from "@nestjs/common";
import { schema } from "@markiro/db";
import {
  isValidGtin,
  normalizeToGtin14,
  parseCategorySchemaDefinition,
  productAttributeValueSchema,
  type ProductAttributeValue,
} from "@markiro/domain";
import {
  importPreviewSchema,
  type ImportField,
  type ImportPhoto,
  type ImportPrepare,
  type ImportPreview,
} from "@markiro/platform-contracts";
import { and, eq, inArray, isNotNull, isNull, gt } from "drizzle-orm";
import { z } from "zod";
import { createProductSchema } from "../products/dto";
import {
  buildNationalCatalogImportEntries,
  type NationalCatalogStableFieldMapping,
} from "./national-catalog-proposal.service";
import type { DbTx, ImportItemRow, ImportSessionRow } from "./national-catalog-import.types";
import {
  nationalCatalogProductAttributeUnit,
  type NationalCatalogProduct,
} from "./national-catalog.types";
import { hashContent } from "./national-catalog-preparation-state";

type ProductRow = typeof schema.products.$inferSelect;
type MappedEntry = ReturnType<typeof buildNationalCatalogImportEntries>["entries"][number];
export type ImportPreviewEntry =
  | CatalogProductFieldEntry
  | CatalogProductGroupEntry
  | {
      entryId: string;
      target: "name";
      source: "national_catalog" | "manual";
      currentValue: string | null;
      proposedValue: string;
    }
  | {
      entryId: string;
      target: "category";
      source: "national_catalog";
      option: StoredCategoryOption;
    }
  | {
      entryId: string;
      target: "mapped";
      source: "national_catalog";
      entry: MappedEntry;
      requiresEntryIds: string[];
    };
export type StoredImportDiff = {
  version: 1;
  entries: ImportPreviewEntry[];
  view: Omit<ImportPreview, "identity"> & { identity?: ImportPreview["identity"] | undefined };
};
export const optionSchema = z
  .object({
    optionId: z.uuid(),
    label: z.string(),
    schemaVersionId: z.uuid(),
    categoryId: z.string(),
    groupCode: z.number().int(),
    mappingId: z.uuid(),
    selected: z.boolean(),
  })
  .strict();
export type StoredCategoryOption = z.infer<typeof optionSchema>;
export function productFingerprint(product: ProductRow): string {
  return hashContent(product);
}
/** These are server-owned option IDs, never accepted as schema/mapping IDs. */
export async function resolveCategoryOption(
  tx: DbTx,
  tenantId: string,
  sessionId: string,
  itemId: string,
  optionId: string,
): Promise<StoredCategoryOption> {
  const rows = await tx
    .select({ options: schema.nationalCatalogImportPreviews.categoryOptions })
    .from(schema.nationalCatalogImportPreviews)
    .where(
      and(
        eq(schema.nationalCatalogImportPreviews.tenantId, tenantId),
        eq(schema.nationalCatalogImportPreviews.sessionId, sessionId),
        eq(schema.nationalCatalogImportPreviews.itemId, itemId),
        gt(schema.nationalCatalogImportPreviews.expiresAt, new Date()),
        isNull(schema.nationalCatalogImportPreviews.payloadPurgedAt),
      ),
    );
  for (const row of rows) {
    const parsed = z.array(optionSchema).safeParse(row.options);
    const found = parsed.success
      ? parsed.data.find((option) => option.optionId === optionId)
      : undefined;
    if (found) return found;
  }
  throw new UnprocessableEntityException("category_option_invalid");
}
/** Required by apply: the initial binding must be accepted with its dependent attributes. */
export function assertPreviewEntrySelection(
  diff: StoredImportDiff,
  acceptedEntryIds: string[],
): void {
  const accepted = new Set(acceptedEntryIds);
  const applicable = new Set(
    diff.view.fields.filter((field) => field.applicable).map((field) => field.id),
  );
  if (
    accepted.size !== acceptedEntryIds.length ||
    acceptedEntryIds.some((id) => !applicable.has(id))
  )
    throw new UnprocessableEntityException("preview_entry_invalid");
  for (const entry of diff.entries)
    if (
      accepted.has(entry.entryId) &&
      entry.target === "mapped" &&
      entry.requiresEntryIds.some((id) => !accepted.has(id))
    )
      throw new UnprocessableEntityException("category_entry_required");
}
export const mappingSchema = z
  .object({
    id: z.uuid(),
    sourceAttributeId: z.string().min(1),
    targetField: z.enum(["name", "print_name", "shelf_life_days"]),
    conversion: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("identity") }).strict(),
      z.object({ kind: z.literal("string_trim") }).strict(),
      z.object({ kind: z.literal("positive_integer") }).strict(),
    ]),
    mappingVersion: z.number().int().positive(),
  })
  .strict();
function textValue(value: unknown): string | null {
  return value === null ? null : typeof value === "string" ? value : JSON.stringify(value);
}

export async function buildImportPreview(
  tx: DbTx,
  session: ImportSessionRow,
  item: ImportItemRow,
  source: NationalCatalogProduct,
  body: ImportPrepare,
  imagePreparation?: { actorId: string; enabled: boolean },
  fetchedAt = new Date(),
  categoryGroups: readonly CatalogCategoryGroup[] = [],
): Promise<ImportPreview> {
  const tenantId = session.tenantId;
  if (!item.gtin14 || !item.cardId || String(source.id) !== item.cardId)
    throw new ConflictException("card_identity_changed");
  if (
    !source.identifiers.some(
      (id) => isValidGtin(id.value) && normalizeToGtin14(id.value) === item.gtin14,
    )
  )
    throw new ConflictException("bound_gtin_missing");
  if (source.status === "archived" || source.detailedStatuses.includes("archived"))
    throw new ConflictException("archived_card");
  const local = await tx
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.gtin14, item.gtin14)))
    .for("share");
  const product = local.find((row) => !row.archived) ?? null;
  if (!product && local.length) throw new ConflictException("archived_local");
  if (item.productId && item.productId !== product?.id)
    throw new ConflictException("product_identity_changed");
  const [profile] = product
    ? await tx
        .select()
        .from(schema.productRegulatoryProfiles)
        .where(
          and(
            eq(schema.productRegulatoryProfiles.tenantId, tenantId),
            eq(schema.productRegulatoryProfiles.productId, product.id),
          ),
        )
        .for("share")
    : [];
  const [link] = product
    ? await tx
        .select()
        .from(schema.nationalCatalogProductLinks)
        .where(
          and(
            eq(schema.nationalCatalogProductLinks.tenantId, tenantId),
            eq(schema.nationalCatalogProductLinks.productId, product.id),
            isNull(schema.nationalCatalogProductLinks.closedAt),
          ),
        )
        .for("share")
    : [];
  const [photo] = product
    ? await tx
        .select({
          assetId: schema.productImages.assetId,
          updatedAt: schema.productImages.updatedAt,
          checksum: schema.mediaAssets.checksum,
          width: schema.mediaAssets.width,
          height: schema.mediaAssets.height,
        })
        .from(schema.productImages)
        .innerJoin(
          schema.mediaAssets,
          and(
            eq(schema.mediaAssets.ownerTenantId, tenantId),
            eq(schema.mediaAssets.id, schema.productImages.assetId),
          ),
        )
        .where(
          and(
            eq(schema.productImages.tenantId, tenantId),
            eq(schema.productImages.productId, product.id),
          ),
        )
    : [];
  const requestedChoice = body.categoryChoices.find((choice) => choice.itemId === item.id);
  if (profile && requestedChoice)
    throw new UnprocessableEntityException("category_change_separate");
  const choice = requestedChoice
    ? await resolveCategoryOption(tx, tenantId, session.id, item.id, requestedChoice.optionId)
    : null;
  const categoryIds = source.categories.map((category) => String(category.id));
  const candidates = categoryIds.length
    ? await tx
        .select({
          version: schema.nationalCatalogSchemaVersions,
          mapping: schema.nationalCatalogCategoryGroupMappings,
        })
        .from(schema.nationalCatalogSchemaVersions)
        .innerJoin(
          schema.nationalCatalogCategoryGroupMappings,
          and(
            eq(
              schema.nationalCatalogCategoryGroupMappings.schemaVersionId,
              schema.nationalCatalogSchemaVersions.id,
            ),
            eq(
              schema.nationalCatalogCategoryGroupMappings.categoryId,
              schema.nationalCatalogSchemaVersions.categoryId,
            ),
            eq(schema.nationalCatalogCategoryGroupMappings.state, "exact"),
            isNotNull(schema.nationalCatalogCategoryGroupMappings.reviewedAt),
          ),
        )
        .where(
          and(
            eq(schema.nationalCatalogSchemaVersions.status, "active"),
            inArray(schema.nationalCatalogSchemaVersions.categoryId, categoryIds),
          ),
        )
        .for("share")
    : [];
  const compatible = candidates.filter(
    ({ mapping, version }) =>
      ((product?.chzProductGroupCode == null && !profile) ||
        mapping.chzProductGroupCode === product?.chzProductGroupCode) &&
      (!profile ||
        (profile.schemaVersionId === version.id && profile.categoryId === version.categoryId)),
  );
  const target = profile
    ? compatible.find(({ version }) => version.id === profile.schemaVersionId)
    : choice
      ? compatible.find(
          ({ version, mapping }) =>
            version.id === choice.schemaVersionId &&
            mapping.id === choice.mappingId &&
            mapping.chzProductGroupCode === choice.groupCode,
        )
      : undefined;
  if (choice && !target) throw new ConflictException("category_option_stale");
  const options: StoredCategoryOption[] = profile
    ? []
    : compatible.map(({ version, mapping }) => ({
        optionId: choice?.mappingId === mapping.id ? choice.optionId : randomUUID(),
        label: version.categoryName,
        schemaVersionId: version.id,
        categoryId: version.categoryId,
        groupCode: mapping.chzProductGroupCode,
        mappingId: mapping.id,
        selected: choice?.mappingId === mapping.id,
      }));
  const entries: ImportPreviewEntry[] = [];
  const fields: ImportField[] = [];
  const providerName = source.name?.trim() ?? "";
  const manualName = body.manualNames.find((value) => value.itemId === item.id)?.name;
  const candidateName = manualName ?? providerName;
  const parsedName = createProductSchema.shape.name.safeParse(candidateName);
  const name = parsedName.success ? parsedName.data : null;
  if (name && name !== product?.name) {
    const entry: ImportPreviewEntry = {
      entryId: randomUUID(),
      target: "name",
      source: manualName === undefined ? "national_catalog" : "manual",
      currentValue: product?.name ?? null,
      proposedValue: name,
    };
    entries.push(entry);
    fields.push({
      id: entry.entryId,
      label: "Название",
      labelKey: "name",
      before: entry.currentValue,
      after: name,
      applicable: true,
      reason: null,
      source: entry.source,
      selectedByDefault: !product,
      requiresEntryIds: [],
    });
  }
  let categoryEntryId: string | null = null;
  if (!choice && source.categories.length) {
    const resolvedGroup = resolveCatalogProductGroup(source.categories, categoryGroups);
    const groupCodes = [resolvedGroup.code, product?.chzProductGroupCode].filter(
      (code): code is number => code != null,
    );
    const groups = groupCodes.length
      ? await tx
          .select()
          .from(schema.chzProductGroups)
          .where(inArray(schema.chzProductGroups.code, groupCodes))
          .for("share")
      : [];
    const group = groups.find((row) => row.code === resolvedGroup.code);
    const before = product?.chzProductGroupCode ?? null;
    if (!group || group.code !== before) {
      const entryId = randomUUID();
      const reason =
        resolvedGroup.reason ??
        (!group
          ? "product_group_unknown"
          : before !== null || profile
            ? "product_group_change_separate"
            : null);
      if (group && !reason)
        entries.push({
          entryId,
          target: "product_group",
          source: "national_catalog",
          currentValue: before,
          proposedValue: group.code,
        });
      fields.push({
        id: entryId,
        label: "Группа продукции",
        labelKey: "chz_product_group_code",
        before:
          groups.find((row) => row.code === before)?.name ??
          (before === null ? null : String(before)),
        after: group?.name ?? (resolvedGroup.code === null ? null : String(resolvedGroup.code)),
        applicable: reason === null,
        reason,
        source: "national_catalog",
        selectedByDefault: !product && reason === null,
        requiresEntryIds: [],
      });
    }
  }
  if (choice && target) {
    categoryEntryId = randomUUID();
    entries.push({
      entryId: categoryEntryId,
      target: "category",
      source: "national_catalog",
      option: choice,
    });
    fields.push({
      id: categoryEntryId,
      label: "Категория",
      labelKey: "category",
      before: null,
      after: choice.label,
      applicable: true,
      reason: null,
      source: "national_catalog",
      selectedByDefault: !product,
      requiresEntryIds: [],
    });
  }
  const currentRows = product
    ? await tx
        .select()
        .from(schema.productRegulatoryAttributeValues)
        .where(
          and(
            eq(schema.productRegulatoryAttributeValues.tenantId, tenantId),
            eq(schema.productRegulatoryAttributeValues.productId, product.id),
            isNull(schema.productRegulatoryAttributeValues.supersededAt),
          ),
        )
        .for("share")
    : [];
  const currentValues = new Map<string, ProductAttributeValue>();
  for (const row of currentRows) {
    const parsed = productAttributeValueSchema.safeParse(row.value);
    if (parsed.success) currentValues.set(row.attributeId, parsed.data);
  }
  let stableMappings: NationalCatalogStableFieldMapping[] = [];
  const productFields = readCatalogProductFields(source.attributes, item.gtin14);
  const importedAttributes = new Set<string>();
  if (target) {
    const definition = parseCategorySchemaDefinition(target.version.definition);
    const mappings = await tx
      .select({
        id: schema.nationalCatalogAttributeMappings.id,
        sourceAttributeId: schema.nationalCatalogAttributeMappings.sourceAttributeId,
        targetField: schema.nationalCatalogAttributeMappings.targetField,
        conversion: schema.nationalCatalogAttributeMappings.conversion,
        mappingVersion: schema.nationalCatalogAttributeMappings.mappingVersion,
      })
      .from(schema.nationalCatalogAttributeMappings)
      .where(eq(schema.nationalCatalogAttributeMappings.schemaVersionId, target.version.id))
      .for("share");
    stableMappings = mappings.flatMap((row) => {
      const parsed = mappingSchema.safeParse(row);
      return parsed.success && parsed.data.targetField !== "name" ? [parsed.data] : [];
    });
    const built = buildNationalCatalogImportEntries({
      schemaVersionId: target.version.id,
      definitions: definition.attributes,
      currentValues,
      sourceAttributes: source.attributes
        .filter(
          (attribute) =>
            attribute.gtin === null ||
            (isValidGtin(attribute.gtin) && normalizeToGtin14(attribute.gtin) === item.gtin14),
        )
        .map((attribute) => ({
          id: attribute.id,
          value: attribute.value,
          unit: nationalCatalogProductAttributeUnit(attribute),
        })),
      sourceName: source.name,
      stableMappings,
      currentStableFields: new Map<
        NationalCatalogStableFieldMapping["targetField"],
        string | number | null
      >([
        ["name", product?.name ?? null],
        ["print_name", product?.printName ?? null],
        ["shelf_life_days", product?.shelfLifeDays ?? null],
      ]),
    });
    for (const entry of built.entries) {
      if (
        productFields.some((field) =>
          entry.target === "stable_field"
            ? field.targetField === entry.targetField
            : String(field.sourceAttributeId) === entry.targetAttributeId,
        )
      )
        continue;
      if (entry.target === "attribute") importedAttributes.add(entry.targetAttributeId);
      if (isDeepStrictEqual(entry.currentValue, entry.proposedValue)) continue;
      entries.push({
        entryId: entry.entryId,
        target: "mapped",
        source: "national_catalog",
        entry,
        requiresEntryIds: categoryEntryId ? [categoryEntryId] : [],
      });
      fields.push({
        id: entry.entryId,
        label:
          entry.target === "attribute"
            ? (definition.attributes.find((a) => a.id === entry.targetAttributeId)?.label ??
              entry.targetAttributeId)
            : entry.targetField,
        ...(entry.target === "stable_field" ? { labelKey: entry.targetField } : {}),
        before: textValue(entry.currentValue),
        after: textValue(entry.proposedValue),
        applicable: true,
        reason: null,
        source: "national_catalog",
        selectedByDefault: !product,
        requiresEntryIds: categoryEntryId ? [categoryEntryId] : [],
      });
    }
  }
  const egaisCodes =
    product && productFields.some((field) => field.targetField === "egais_code")
      ? await tx
          .select({ code: schema.productEgaisCodes.code })
          .from(schema.productEgaisCodes)
          .where(
            and(
              eq(schema.productEgaisCodes.tenantId, tenantId),
              eq(schema.productEgaisCodes.productId, product.id),
            ),
          )
          .for("share")
      : [];
  for (const field of productFields) {
    importedAttributes.add(String(field.sourceAttributeId));
    const currentValue =
      field.targetField === "egais_code"
        ? (product?.egaisCode ?? null)
        : (product?.shelfLifeDays ?? null);
    if (currentValue === field.value) continue;
    const entry = productFieldEntrySchema.parse({
      targetField: field.targetField,
      sourceAttributeId: field.sourceAttributeId,
      mappingVersion: field.mappingVersion,
      entryId: randomUUID(),
      target: "product_field",
      source: "national_catalog",
      currentValue,
      proposedValue: field.value,
    });
    entries.push(entry);
    const applicable =
      field.targetField !== "egais_code" ||
      egaisCodes.length < 20 ||
      egaisCodes.some((row) => row.code === field.value);
    fields.push({
      id: entry.entryId,
      label: field.targetField,
      labelKey: field.targetField,
      before: currentValue === null ? null : String(currentValue),
      after: String(field.value),
      applicable,
      reason: applicable ? null : "egais_code_limit",
      source: "national_catalog",
      selectedByDefault: !product && applicable,
      requiresEntryIds: [],
    });
  }
  for (const attribute of source.attributes) {
    if (importedAttributes.has(String(attribute.id))) continue;
    const productField = catalogProductFieldForLabel(attribute.name);
    const currentValue =
      productField === "egais_code"
        ? product?.egaisCode
        : productField === "shelf_life_days"
          ? product?.shelfLifeDays
          : null;
    fields.push({
      id: randomUUID(),
      label: attribute.name,
      ...(productField ? { labelKey: productField } : {}),
      before: currentValue == null ? null : String(currentValue),
      after: attribute.value,
      applicable: false,
      reason: target || productField ? "attribute_not_importable" : "compatible_schema_required",
      source: "national_catalog",
      selectedByDefault: false,
      requiresEntryIds: [],
    });
  }
  const id = randomUUID();
  const photos = buildPhotoCandidates(source, item.gtin14, !!photo, imagePreparation?.enabled);
  const linkAction = !link
    ? "attach"
    : link.environment === session.environment &&
        link.cardId === item.cardId &&
        link.boundGtin14 === item.gtin14
      ? "keep"
      : "replace";
  const view: ImportPreview = {
    id,
    itemId: item.id,
    identity: { gtin14: item.gtin14, cardId: item.cardId, name: source.name },
    productId: product?.id ?? null,
    expiresAt: session.expiresAt.toISOString(),
    fields,
    photos: photos.map(({ dto }) => dto),
    categoryOptions: options.map(({ optionId, label, selected }) => ({
      optionId,
      label,
      selected,
    })),
    linkAction,
    canApply: !!product || name !== null,
    reason: !product && !name ? "name_required" : null,
  };
  const diff: StoredImportDiff = { version: 1, entries, view: importPreviewSchema.parse(view) };
  const snapshot = {
    sourceMethod: "feed_product",
    environment: session.environment,
    cardId: item.cardId,
    boundGtin14: item.gtin14,
    access: item.access,
    raw: source.raw,
    normalized: source,
    ...(categoryGroups.length
      ? {
          categoryGroups: {
            sourceMethod: "categories",
            categories: categoryGroups
              .filter((category) => source.categories.some((c) => c.id === category.id))
              .map(({ id, active, gismtCodes }) => ({ id, active, gismtCodes })),
          },
        }
      : {}),
  };
  const sourceHash = hashContent(snapshot);
  await tx.insert(schema.nationalCatalogImportPreviews).values({
    id,
    tenantId,
    sessionId: session.id,
    itemId: item.id,
    productId: product?.id ?? null,
    expiresAt: session.expiresAt,
    createdAt: fetchedAt,
    source: snapshot,
    sourceHash,
    expectedProductRevision: product ? productFingerprint(product) : null,
    expectedProfileRevision: profile?.revision ?? null,
    expectedLinkRevision: link?.revision ?? null,
    expectedSchemaRevision: target
      ? hashContent({ version: target.version, mapping: target.mapping, stableMappings })
      : null,
    previousValues: {
      expectedAbsentGtin: product ? null : item.gtin14,
      product,
      profile: profile ?? null,
      attributes: currentRows,
      link: link ?? null,
      schema: target ?? null,
      stableMappings,
      initialProduct: {
        chzProductGroupCode: choice?.groupCode ?? null,
        boxCapacity: null,
        palletCapacity: null,
        status: "draft",
      },
    },
    previousPhoto: photo ?? null,
    diff,
    manualProvenance: entries.filter((entry) => entry.source === "manual"),
    categoryOptions: options,
  });
  if (photos.length)
    await tx.insert(schema.nationalCatalogImportImages).values(
      photos.map(({ dto, url, sourceId }) => ({
        tenantId,
        sessionId: session.id,
        previewId: id,
        candidateId: dto.candidateId,
        sourceId,
        preparationActorId:
          imagePreparation?.enabled && dto.automaticWorkPending ? imagePreparation.actorId : null,
        preparationCheckpoint: dto.automaticWorkPending ? newImageCheckpoint() : null,
        sourceHash,
        sourceUrl: url,
        state: dto.state === "failed" ? ("failed" as const) : ("pending" as const),
        expiresAt: session.expiresAt,
        primary: dto.primary,
        errorCode: dto.reason,
      })),
    );
  return view;
}
export function buildPhotoCandidates(
  source: NationalCatalogProduct,
  gtin14: string,
  hasImage: boolean,
  prepareMainPhoto = false,
): Array<{ dto: ImportPhoto; url: string | null; sourceId: string }> {
  const candidates = source.images.map((image) => {
    const matches =
      image.barcode !== null &&
      isValidGtin(image.barcode) &&
      normalizeToGtin14(image.barcode) === gtin14;
    const invalid = image.barcode !== null && !isValidGtin(image.barcode);
    const foreign = image.barcode !== null && !invalid && !matches;
    return { candidateId: randomUUID(), image, matches, invalid, foreign };
  });
  const selected = chooseDefaultPhoto(
    gtin14,
    candidates
      .filter((row) => !row.invalid)
      .map((row) => ({
        candidateId: row.candidateId,
        barcode: row.image.barcode === null ? null : normalizeToGtin14(row.image.barcode),
        primary: row.image.primary,
      })),
  );
  return [
    ...candidates.map((row) => ({
      dto: {
        candidateId: row.candidateId,
        previewPath: null,
        state: row.invalid ? ("failed" as const) : ("pending" as const),
        automaticWorkPending: prepareMainPhoto && row.candidateId === selected,
        primary: row.image.primary,
        selectedByDefault: !hasImage && row.candidateId === selected,
        reason: row.invalid
          ? ("invalid_barcode" as const)
          : row.foreign
            ? ("barcode_mismatch" as const)
            : null,
      },
      url: row.invalid ? null : row.image.url,
      sourceId: row.image.sourceId,
    })),
    ...source.imageIssues.map((issue) => ({
      dto: {
        candidateId: randomUUID(),
        previewPath: null,
        state: "failed" as const,
        automaticWorkPending: false,
        primary: false,
        selectedByDefault: false,
        reason: issue.reason,
      },
      url: null,
      sourceId: issue.sourceId,
    })),
  ];
}
