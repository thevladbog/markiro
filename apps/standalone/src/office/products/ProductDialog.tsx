import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Checkbox, Input, Select } from "@markiro/ui";

import type { OfficeProduct } from "../../host/protocol.js";
import { productCreate, productUpdate, type ProductInput } from "../../host/requests.js";
import { gtinRule, toGtin14 } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import {
  gtinOwner,
  PRODUCT_CONFLICTS,
  PRODUCT_FIELDS,
  productFields,
  productFieldsSchema,
  staysDraft,
  toProductInput,
  type GtinOwner,
  type ProductFields,
} from "./product-form.js";
import { useProductGroups } from "./product-queries.js";

/** Group names in Russian order, with numbers by value. */
const GROUP_NAMES = new Intl.Collator("ru", { numeric: true });

/** What a save sends: the product's fields, and for an edit its `archived` flag. */
interface ProductWrite {
  input: ProductInput;
  archived: boolean;
}

export interface ProductDialogProps {
  /** `null` adds a product. */
  product: OfficeProduct | null;
  onClose: () => void;
  onSaved: (product: OfficeProduct) => void;
  /** The product changed on the host: close and load the list again. */
  onReload: () => void;
}

/**
 * Adds a product, or changes one: the host takes the whole record with the
 * loaded revision, and archiving is its `archived` flag (no delete). The GTIN
 * may change too. Once it is valid, the dialog shows the 14 digits it is saved
 * as and whose GS1 prefix it has; neither blocks a save.
 */
export function ProductDialog({ product, onClose, onSaved, onReload }: ProductDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const groups = useProductGroups();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const counterparties = useOfficeQuery(officeKeys.counterparties, (api, token) =>
    api.listCounterparties(token),
  );
  const save = useOfficeMutation((api, token, { input, archived }: ProductWrite) =>
    product === null
      ? api.createProduct(token, productCreate(input))
      : api.updateProduct(token, product.id, productUpdate(input, archived, product.rev)),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isDirty },
  } = useForm<ProductFields>({
    resolver: zodResolver(productFieldsSchema),
    defaultValues: productFields(product),
  });
  const [typedGtin, group, boxCapacity, palletBoxCapacity] = watch([
    "gtin14",
    "chzProductGroupCode",
    "boxCapacity",
    "palletBoxCapacity",
  ]);

  const gtin = gtinRule.safeParse(typedGtin);
  const gtin14 = gtin.success ? toGtin14(gtin.data) : null;
  // Absent while either list loads or when one did not load.
  const owner =
    gtin14 !== null && org.isSuccess && counterparties.isSuccess
      ? gtinOwner(gtin14, org.data.gs1Prefixes, counterparties.data)
      : null;
  const ownerText = (found: GtinOwner) => {
    switch (found.kind) {
      case "own":
        return t("office.products.owner.own");
      case "counterparty": {
        const { name, archived } = found.counterparty;
        return t("office.products.owner.counterparty", {
          name: archived ? t("office.common.archivedName", { name }) : name,
        });
      }
      case "unknown":
        return t("office.products.owner.unknown");
    }
  };

  const groupOptions: { value: string; label: string }[] = [
    { value: "", label: t("office.products.fields.noGroup") },
    ...[...(groups.data ?? [])]
      .sort((a, b) => GROUP_NAMES.compare(a.name, b.name))
      .map((each) => ({ value: String(each.code), label: each.name })),
  ];
  // The product's own group stays a choice when the lookup lacks it or did not load.
  const ownGroup = product?.chzProductGroupCode ?? null;
  if (ownGroup !== null && !groupOptions.some((option) => option.value === String(ownGroup))) {
    groupOptions.push({
      value: String(ownGroup),
      label: groups.isSuccess
        ? t("office.products.groupMissing", { code: ownGroup })
        : t("office.products.unknownGroup", { code: ownGroup }),
    });
  }

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const write: ProductWrite = { input: toProductInput(values), archived: values.archived };
    let saved: OfficeProduct;
    try {
      saved = await save.mutateAsync(write);
    } catch (error) {
      const outcome = writeFailure(error, PRODUCT_FIELDS, PRODUCT_CONFLICTS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  });

  return (
    <FormDialog
      title={
        product === null
          ? t("office.products.createTitle")
          : t("office.products.editTitle", { name: product.name })
      }
      submitLabel={product === null ? t("office.products.create") : t("office.common.save")}
      submitDisabled={product !== null && !isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <div className="product-gtin">
        <Input
          label={t("office.products.fields.gtin")}
          hint={t("office.products.fields.gtinHint")}
          inputMode="numeric"
          mono
          {...fieldError(errors.gtin14?.message)}
          {...register("gtin14")}
        />
        <div className="product-gtin__notes" aria-live="polite">
          {gtin14 !== null && gtin14 !== typedGtin.trim() && (
            <p className="office-note">{t("office.products.gtinSavedAs", { gtin14 })}</p>
          )}
          {owner !== null && <p className="office-note">{ownerText(owner)}</p>}
        </div>
      </div>
      <Input
        label={t("office.products.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      <Input
        label={t("office.products.fields.printName")}
        hint={t("office.products.fields.printNameHint")}
        {...fieldError(errors.printName?.message)}
        {...register("printName")}
      />
      <Controller
        control={control}
        name="chzProductGroupCode"
        render={({ field }) => (
          <Select
            native
            label={t("office.products.fields.group")}
            options={groupOptions}
            value={field.value}
            onValueChange={field.onChange}
            disabled={!groups.isSuccess}
            {...(groups.isError ? { hint: t("office.products.groupsUnavailable") } : {})}
            {...fieldError(errors.chzProductGroupCode?.message)}
          />
        )}
      />
      <Input
        label={t("office.products.fields.boxCapacity")}
        hint={t("office.products.fields.optional")}
        inputMode="numeric"
        mono
        {...fieldError(errors.boxCapacity?.message)}
        {...register("boxCapacity")}
      />
      <Input
        label={t("office.products.fields.palletBoxCapacity")}
        hint={t("office.products.fields.palletBoxCapacityHint")}
        inputMode="numeric"
        mono
        {...fieldError(errors.palletBoxCapacity?.message)}
        {...register("palletBoxCapacity")}
      />
      {staysDraft({ chzProductGroupCode: group, boxCapacity, palletBoxCapacity }) && (
        <p className="office-note">{t("office.products.draftHint")}</p>
      )}
      <Input
        label={t("office.products.fields.shelfLifeDays")}
        hint={t("office.products.fields.optional")}
        inputMode="numeric"
        mono
        {...fieldError(errors.shelfLifeDays?.message)}
        {...register("shelfLifeDays")}
      />
      {product !== null && (
        <Controller
          control={control}
          name="archived"
          render={({ field }) => (
            <Checkbox
              label={t("office.products.fields.archived")}
              checked={field.value}
              onCheckedChange={field.onChange}
            />
          )}
        />
      )}
    </FormDialog>
  );
}
