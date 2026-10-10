import { Input } from "@markiro/ui";
import { useTranslation } from "react-i18next";
export interface TemplateChoice {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
}
/** Shared searchable list; its parent bounds the scroll area independently of the preview. */
export function TemplateChoiceList({
  choices,
  selectedId,
  defaultId,
  onSelect,
  disabled = false,
  ariaLabel,
  search,
  onSearch,
  radio = false,
}: {
  choices: readonly TemplateChoice[];
  selectedId: string | null;
  defaultId?: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  search: string;
  onSearch: (value: string) => void;
  radio?: boolean;
}) {
  const { t } = useTranslation();
  const needle = search.trim().toLocaleLowerCase();
  const visible = choices.filter((c) => c.name.toLocaleLowerCase().includes(needle));
  const content = (choice: TemplateChoice) => (
    <span>
      <strong>{choice.name}</strong>
      <small>
        {choice.widthMm} × {choice.heightMm} {t("warehouse.mm")}
      </small>
      {choice.id === defaultId ? (
        <small className="label-template-default">{t("shifts.templateDefault")}</small>
      ) : null}
    </span>
  );
  return (
    <div className="label-template-choices">
      <Input
        size="floor"
        type="search"
        label={t("shifts.templateSearch")}
        value={search}
        disabled={disabled}
        onChange={(e) => onSearch(e.target.value)}
      />
      <div
        className="label-template-list"
        role={radio ? "radiogroup" : "group"}
        aria-label={ariaLabel}
      >
        {visible.length === 0 ? (
          <p>{t(choices.length === 0 ? "warehouse.noTemplates" : "shifts.templateSearchEmpty")}</p>
        ) : (
          visible.map((choice) =>
            radio ? (
              <label className="warehouse-template-option" key={choice.id}>
                <input
                  type="radio"
                  name="label-template-choice"
                  checked={selectedId === choice.id}
                  disabled={disabled}
                  onChange={() => onSelect(choice.id)}
                />
                {content(choice)}
              </label>
            ) : (
              <button
                key={choice.id}
                type="button"
                className={`label-template-option${selectedId === choice.id ? " label-template-option--selected" : ""}`}
                aria-pressed={selectedId === choice.id}
                disabled={disabled}
                onClick={() => onSelect(choice.id)}
              >
                {content(choice)}
              </button>
            ),
          )
        )}
      </div>
    </div>
  );
}
