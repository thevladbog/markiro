import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@markiro/ui";
import type { OperatorMirrorRecord } from "@markiro/db";
import {
  normalizeOperatorNameQuery,
  searchOperatorsByName,
  type OperatorSearchResult,
} from "../lib/operator-search.js";

export interface OperatorNameSearchProps {
  operators: readonly OperatorMirrorRecord[];
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (operator: OperatorSearchResult) => void;
  onTextEntryActiveChange?: (active: boolean) => void;
  disabled?: boolean;
}

export function OperatorNameSearch({
  operators,
  query,
  onQueryChange,
  onSelect,
  onTextEntryActiveChange,
  disabled = false,
}: OperatorNameSearchProps) {
  const { t } = useTranslation();
  const normalized = normalizeOperatorNameQuery(query);
  const matches = useMemo(() => searchOperatorsByName(operators, query), [operators, query]);
  const hasEnoughLetters =
    Array.from(normalized).filter((character) => /\p{L}/u.test(character)).length >= 2;

  return (
    <section className="operator-name-search" aria-label={t("login.nameSearchTitle")}>
      <Input
        size="floor"
        label={t("login.nameLabel")}
        aria-label={t("login.nameLabel")}
        value={query}
        maxLength={3}
        autoComplete="off"
        autoCapitalize="none"
        disabled={disabled}
        onFocus={() => onTextEntryActiveChange?.(true)}
        onBlur={() => onTextEntryActiveChange?.(false)}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
      />
      <div className="operator-name-search__results" aria-live="polite">
        {!hasEnoughLetters ? (
          <p className="operator-name-search__hint">{t("login.nameHint")}</p>
        ) : matches.length === 0 ? (
          <p className="operator-name-search__hint">{t("login.nameEmpty")}</p>
        ) : (
          matches.map((operator) => (
            <Button
              key={operator.operatorId}
              size="floor"
              variant="secondary"
              fullWidth
              disabled={disabled}
              onClick={() => onSelect(operator)}
            >
              <span
                className="operator-name-search__result-label"
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {operator.name}
              </span>
            </Button>
          ))
        )}
      </div>
    </section>
  );
}
