import { useTranslation } from "react-i18next";
import type { DadataSuggestionStatus } from "@markiro/platform-contracts";

export function SuggestionMenu<T>({
  id,
  result,
  pending,
  error,
  visible,
  activeIndex,
  onActiveIndexChange,
  getKey,
  getLabel,
  onSelect,
}: {
  id: string;
  result: { status: DadataSuggestionStatus; items: T[] } | undefined;
  pending: boolean;
  error: unknown;
  visible: boolean;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
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
  if (!visible || !result?.items.length) return null;
  return (
    <div id={id} className="suggest-field__menu" role="listbox">
      {result.items.map((item, index) => {
        const key = getKey(item);
        const active = index === activeIndex;
        return (
          <button
            id={`${id}-option-${encodeURIComponent(key)}`}
            key={key}
            type="button"
            role="option"
            aria-selected={active}
            data-active={active || undefined}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => onActiveIndexChange(index)}
            onClick={() => onSelect(item)}
          >
            {getLabel(item)}
          </button>
        );
      })}
    </div>
  );
}
