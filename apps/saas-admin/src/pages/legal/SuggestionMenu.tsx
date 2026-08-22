import { useTranslation } from "react-i18next";
import type { DadataSuggestionStatus } from "@markiro/platform-contracts";

export function SuggestionMenu<T>({
  result,
  pending,
  error,
  getKey,
  getLabel,
  onSelect,
}: {
  result: { status: DadataSuggestionStatus; items: T[] } | undefined;
  pending: boolean;
  error: unknown;
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  onSelect: (item: T) => void;
}) {
  const { t } = useTranslation();
  if (pending) return <span className="suggest-field__status">{t("legal.dadata.searching")}</span>;
  const status = error ? "unavailable" : result?.status;
  if (status && status !== "ready") {
    return (
      <span className="suggest-field__status" role="status">
        {t(`legal.dadata.${status}`)}
      </span>
    );
  }
  if (!result?.items.length) return null;
  return (
    <div className="suggest-field__menu" role="listbox">
      {result.items.map((item) => (
        <button key={getKey(item)} type="button" role="option" onClick={() => onSelect(item)}>
          {getLabel(item)}
        </button>
      ))}
    </div>
  );
}
