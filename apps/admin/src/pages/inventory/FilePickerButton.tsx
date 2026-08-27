import { useRef } from "react";
import { Button } from "@markiro/ui";

/** Кнопка дизайн-системы поверх скрытого нативного file-инпута. */
export function FilePickerButton({
  label,
  busyLabel,
  accept,
  disabled = false,
  busy = false,
  ariaLabel,
  onFile,
}: {
  label: string;
  busyLabel: string;
  accept: string;
  disabled?: boolean;
  busy?: boolean;
  /** Уникальный доступный ярлык (например, «Файл INTRODUCED»), если видимый текст неоднозначен. */
  ariaLabel?: string;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <span className="mk-file-picker">
      <input
        ref={inputRef}
        data-testid="file-picker-input"
        className="mk-file-picker__input"
        type="file"
        accept={accept}
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) onFile(file);
          event.currentTarget.value = "";
        }}
      />
      <Button
        variant="secondary"
        disabled={disabled || busy}
        aria-label={ariaLabel}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? busyLabel : label}
      </Button>
    </span>
  );
}
