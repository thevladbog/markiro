import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Input, Select } from "@markiro/ui";

import type { OfficeProduct } from "../../host/protocol.js";
import { productCreate, productUpdate, type ProductInput } from "../../host/requests.js";
import { gtinRule, productNameRule, toGtin14 } from "../../lib/rules.js";
import { EntityDrawer } from "../EntityDrawer.js";
import { writeFailure, type AlertFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { searchableSelect } from "../select-search.js";
import { PRODUCT_CONFLICTS } from "./product-form.js";
import "./set-product.css";

const COSMETICS_GROUP = 35;
const MAX_SET_ITEMS = 1000;
const FIELDS = { gtin14: "gtin14", name: "name", setItems: "setItems" } as const;
type Field = keyof typeof FIELDS;

interface RecipeLine {
  gtin14: string;
  productName: string;
  quantity: string;
}

interface SetProductDrawerProps {
  product: OfficeProduct | null;
  products: readonly OfficeProduct[];
  onClose: () => void;
  onReload: () => void;
  onSaved: (product: OfficeProduct) => void;
}

export function SetProductDrawer({
  product,
  products,
  onClose,
  onReload,
  onSaved,
}: SetProductDrawerProps) {
  const { t } = useTranslation();
  const [gtin, setGtin] = useState(product?.gtin14 ?? "");
  const [name, setName] = useState(product?.name ?? "");
  const [lines, setLines] = useState<RecipeLine[]>(() =>
    (product?.setItems ?? []).map((item) => ({ ...item, quantity: String(item.quantity) })),
  );
  const [selection, setSelection] = useState("");
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const available = new Map(
    products
      .filter(
        (row) =>
          row.status === "active" &&
          !row.archived &&
          !row.demo &&
          row.setItems === undefined &&
          row.chzProductGroupCode === COSMETICS_GROUP,
      )
      .map((row) => [row.gtin14, row.name]),
  );
  const choices = [...available]
    .filter(([code]) => !lines.some((line) => line.gtin14 === code))
    .map(([value, label]) => ({ value, label: `${label} · ${value}` }));
  const dirty =
    name !== (product?.name ?? "") ||
    gtin !== (product?.gtin14 ?? "") ||
    JSON.stringify(lines) !==
      JSON.stringify(
        (product?.setItems ?? []).map((item) => ({ ...item, quantity: String(item.quantity) })),
      );
  const save = useOfficeMutation((api, token, input: ProductInput) =>
    product === null
      ? api.createProduct(token, productCreate(input))
      : api.updateProduct(token, product.id, productUpdate(input, product.archived, product.rev)),
  );

  function updateLines(next: RecipeLine[]) {
    setLines(next);
    setErrors((current) => ({ ...current, setItems: "" }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const checkedGtin = gtinRule.safeParse(gtin);
    const checkedName = productNameRule.safeParse(name);
    const checkedItems = lines.map((line) => ({
      ...line,
      quantity: /^\d+$/u.test(line.quantity) ? Number(line.quantity) : 0,
    }));
    const total = checkedItems.reduce((sum, line) => sum + line.quantity, 0);
    const itemsValid =
      total > 0 &&
      total <= MAX_SET_ITEMS &&
      checkedItems.every((line) => line.quantity > 0 && available.has(line.gtin14));
    const next: Partial<Record<Field, string>> = {};
    if (!checkedGtin.success) next.gtin14 = checkedGtin.error.issues[0]?.message ?? "rules.gtin";
    if (!checkedName.success) next.name = "rules.productName";
    if (!itemsValid) next.setItems = "office.products.sets.invalid";
    setErrors(next);
    if (!checkedGtin.success || !checkedName.success || !itemsValid) return;

    try {
      const saved = await save.mutateAsync({
        gtin14: toGtin14(checkedGtin.data),
        name: checkedName.data,
        setItems: checkedItems,
        chzProductGroupCode: COSMETICS_GROUP,
        printName: product?.printName ?? null,
        boxCapacity: null,
        palletBoxCapacity: null,
        shelfLifeDays: product?.shelfLifeDays ?? null,
        defaultBoxTemplateId: null,
        defaultPalletTemplateId: null,
        defaultPalletSheetId: null,
        defaultCounterpartyId: product?.defaultCounterpartyId ?? null,
        egaisCode: null,
      });
      onSaved(saved);
    } catch (error) {
      const outcome = writeFailure(error, FIELDS, PRODUCT_CONFLICTS);
      if (outcome.kind === "field") {
        setErrors({
          [outcome.field]:
            outcome.field === "setItems" ? "office.products.sets.invalid" : outcome.message,
        });
      } else {
        setFailure(outcome);
      }
    }
  }

  return (
    <EntityDrawer
      title={t(product === null ? "office.products.sets.add" : "office.products.sets.edit")}
      submitLabel={t("office.common.save")}
      submitDisabled={product !== null && !dirty}
      dirty={dirty}
      onClose={onClose}
      onSubmit={submit}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <Input
        label={t("office.products.sets.name")}
        value={name}
        onChange={(event) => setName(event.target.value)}
        {...(errors.name ? { error: t(errors.name) } : {})}
      />
      <Input
        label={t("office.products.sets.gtin")}
        value={gtin}
        inputMode="numeric"
        mono
        onChange={(event) => setGtin(event.target.value)}
        {...(errors.gtin14 ? { error: t(errors.gtin14) } : {})}
      />
      <Input
        label={t("office.products.table.group")}
        value={t("office.products.sets.cosmetics")}
        readOnly
      />
      <fieldset className="set-product__recipe">
        <legend>{t("office.products.sets.composition")}</legend>
        <ul>
          {lines.map((line) => (
            <li key={line.gtin14}>
              <span>
                <strong>{available.get(line.gtin14) ?? line.productName}</strong>
                <small>{line.gtin14}</small>
                {!available.has(line.gtin14) && (
                  <small>{t("office.products.sets.unavailable")}</small>
                )}
              </span>
              <Input
                label={t("office.products.sets.quantityFor", { name: line.productName })}
                inputMode="numeric"
                value={line.quantity}
                onChange={(event) =>
                  updateLines(
                    lines.map((item) =>
                      item.gtin14 === line.gtin14
                        ? { ...item, quantity: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              <Button
                type="button"
                variant="secondary"
                aria-label={t("office.products.sets.removeNamed", { name: line.productName })}
                onClick={() => updateLines(lines.filter((item) => item.gtin14 !== line.gtin14))}
              >
                {t("office.products.sets.remove")}
              </Button>
            </li>
          ))}
        </ul>
        <div className="set-product__add">
          <Select
            label={t("office.products.sets.choose")}
            options={[{ value: "", label: t("office.products.sets.placeholder") }, ...choices]}
            value={selection}
            onValueChange={setSelection}
            {...searchableSelect(t)}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={selection === ""}
            onClick={() => {
              const productName = available.get(selection);
              if (productName === undefined || !choices.some(({ value }) => value === selection))
                return;
              updateLines([...lines, { gtin14: selection, productName, quantity: "1" }]);
              setSelection("");
            }}
          >
            {t("office.products.sets.addItem")}
          </Button>
        </div>
        {errors.setItems && <Alert tone="warn">{t(errors.setItems)}</Alert>}
      </fieldset>
    </EntityDrawer>
  );
}
