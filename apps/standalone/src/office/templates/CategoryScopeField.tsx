import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Input, RadioGroup } from "@markiro/ui";

import { errorProp } from "../../lib/form-error.js";
import { useProductGroups } from "../catalog-queries.js";
import { codesWithoutGroup, visibleGroups, type CategoryScope } from "./category-scope.js";

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
 * nothing. A chosen code the lookup lacks is listed after the groups as «Код N»,
 * so it can be unchecked. The template editor takes this field as well.
 */
export function CategoryScopeField({ value, onChange, error }: CategoryScopeFieldProps) {
  const { t } = useTranslation();
  const groups = useProductGroups();
  const [search, setSearch] = useState("");
  const searchId = useId();
  // Set by «Повторить»: the retry button leaves the page once the list is back,
  // and focus would fall to <body>, outside the dialog's Escape and Tab handling.
  const focusSearchWhenListed = useRef(false);
  const text = search.trim().toLocaleLowerCase("ru");
  const shown = groups.data === undefined ? [] : visibleGroups(groups.data, search);
  const unnamed = (groups.data === undefined ? [] : codesWithoutGroup(groups.data, value.codes))
    .map((code) => ({ code, label: t("office.templates.groupCode", { code }) }))
    .filter(({ label }) => text === "" || label.toLocaleLowerCase("ru").includes(text));

  useEffect(() => {
    if (groups.isSuccess && focusSearchWhenListed.current) {
      focusSearchWhenListed.current = false;
      document.getElementById(searchId)?.focus();
    }
  }, [groups.isSuccess, searchId]);

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
            <Button
              variant="secondary"
              size="compact"
              onClick={() => {
                focusSearchWhenListed.current = true;
                void groups.refetch();
              }}
            >
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
          id={searchId}
          label={t("office.categoryScope.search")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          // The field sits in form dialogs: Enter would submit the form and save a
          // half-made choice.
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
        />
        <div
          className="category-scope__list"
          role="group"
          aria-label={t("office.categoryScope.list")}
        >
          {shown.length === 0 && unnamed.length === 0 ? (
            <p className="office-note">{t("office.categoryScope.nothingFound")}</p>
          ) : (
            <>
              {shown.map((group) => (
                <Checkbox
                  key={group.code}
                  label={group.name}
                  checked={value.codes.includes(group.code)}
                  onCheckedChange={(checked) => toggle(group.code, checked)}
                />
              ))}
              {unnamed.map(({ code, label }) => (
                <Checkbox
                  key={`code-${code}`}
                  label={label}
                  checked
                  onCheckedChange={(checked) => toggle(code, checked)}
                />
              ))}
            </>
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
