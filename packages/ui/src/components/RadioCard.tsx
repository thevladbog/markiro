import { useId, type ReactNode } from "react";

/** A whole-cell radio label; native grouping retains arrow-key navigation. */
export interface RadioCardProps {
  name: string;
  label: string;
  title: string;
  caption: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  children: ReactNode;
  description?: string | undefined;
}

export function RadioCard({
  name,
  label,
  title,
  caption,
  checked,
  disabled,
  onSelect,
  children,
  description,
}: RadioCardProps) {
  const descriptionId = useId();
  const valueId = useId();
  const captionId = useId();
  return (
    <div className="mk-radio-card-container">
      <label className="mk-radio-card" data-selected={checked} data-disabled={disabled}>
        <input
          type="radio"
          name={name}
          aria-label={label}
          aria-checked={checked}
          aria-describedby={`${captionId} ${valueId}${description ? ` ${descriptionId}` : ""}`}
          checked={checked}
          disabled={disabled}
          onChange={onSelect}
          onClick={() => {
            if (checked) onSelect();
          }}
        />
        <span className="mk-radio-card__heading">
          <span>{title}</span>
          <span className="mk-radio-card__check" aria-hidden="true">
            {checked ? "✓" : ""}
          </span>
        </span>
        <span id={captionId} className="mk-radio-card__caption">
          {caption}
        </span>
        <span id={valueId} className="mk-radio-card__value">
          {children}
        </span>
      </label>
      {description && (
        <p className="mk-radio-card__reason" id={descriptionId}>
          {description}
        </p>
      )}
    </div>
  );
}
