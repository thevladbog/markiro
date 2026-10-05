import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Input, RadioGroup } from "@markiro/ui";

import { errorProp } from "../../lib/form-error.js";
import { useProductGroups } from "../catalog-queries.js";
import { visibleGroups, type CategoryScope } from "./category-scope.js";

export interface CategoryScopeFieldProps {
  value: CategoryScope;
  onChange: (next: CategoryScope) => void;
  /** Under the choice: why the categories cannot go as they are. */
  error?: string;
}

/**
 * A template's categories: every category, or the chosen ЧЗ product groups,
 * found by name (after the cloud editor's `scopeMode`, `scopeSearch` and
 * `visibleGroups`). The groups come from `useProductGroups`; while they load
 * or when they fail, «Только выбранные» keeps its codes and says why it lists
 * nothing. The template editor of plan 1e4 is to take this field as well.
 */
export function CategoryScopeField({ value, onChange, error }: CategoryScopeFieldProps) {
  const { t } = useTranslation();
  const groups = useProductGroups();
  const [search, setSearch] = useState("");
  const shown = groups.data === undefined ? [] : visibleGroups(groups.data, search);

  const toggle = (code: number, checked: boolean) =>
    onChange({
      mode: "selected",
      codes: checked ? [...value.codes, code] : value.codes.filter((each) => each !== code),
    });

  const list = () => {
    if (groups.isPending) return <p className="office-note">{t("office.categoryScope.loading")}</p>;
    if (groups.isError) {
      return (
        <Alert
          tone="error"
          action={
            <Button variant="secondary" size="compact" onClick={() => void groups.refetch()}>
              {t("office.common.retry")}
            </Button>
          }
        >
          {t("office.categoryScope.failed")}
        </Alert>
      );
    }
    return (
      <>
        <Input
          label={t("office.categoryScope.search")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div
          className="category-scope__list"
          role="group"
          aria-label={t("office.categoryScope.list")}
        >
          {shown.length === 0 ? (
            <p className="office-note">{t("office.categoryScope.nothingFound")}</p>
          ) : (
            shown.map((group) => (
              <Checkbox
                key={group.code}
                label={group.name}
                checked={value.codes.includes(group.code)}
                onCheckedChange={(checked) => toggle(group.code, checked)}
              />
            ))
          )}
        </div>
      </>
    );
  };

  return (
    <div className="category-scope">
      <RadioGroup
        label={t("office.categoryScope.label")}
        options={[
          { value: "all", label: t("office.categoryScope.all") },
          { value: "selected", label: t("office.categoryScope.selected") },
        ]}
        value={value.mode}
        onValueChange={(mode) =>
          onChange({ ...value, mode: mode === "selected" ? "selected" : "all" })
        }
        {...errorProp(error)}
      />
      {value.mode === "selected" && (
        <>
          <p className="office-note" aria-live="polite">
            {t("office.categoryScope.chosen", { n: value.codes.length })}
          </p>
          {list()}
        </>
      )}
    </div>
  );
}
