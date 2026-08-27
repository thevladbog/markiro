import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import { cn } from "../cn.js";

export interface FileDropZoneProps {
  /** Основной текст зоны, напр. «Перетащите файл или нажмите». */
  label: string;
  /** Вторая строка — допустимые форматы/ограничения. Не рендерится в compact. */
  hint?: string;
  accept: string;
  disabled?: boolean;
  /** Показывает busyLabel (или label) и блокирует клик/drop, как disabled. */
  busy?: boolean;
  busyLabel?: string;
  onFile: (file: File) => void;
  /** Уникальный доступный ярлык — нужен там, где видимый текст зоны неоднозначен (несколько зон на странице). */
  ariaLabel?: string;
  /** Низкая версия для плотных мест: паддинг меньше, текст в одну строку, без hint. */
  compact?: boolean;
  className?: string;
}

/**
 * Проверяет, подходит ли файл под `accept` (тот же синтаксис, что у
 * нативного `<input accept>`): список через запятую из расширений
 * (`.csv`), конкретных MIME-типов (`image/png`) и универсальных MIME-типов
 * с суффиксом `/*` (`image/*`). Пустой (или не содержащий ни одного
 * валидного паттерна) `accept` пропускает любой файл — как у нативного
 * input. Сравнение регистронезависимое.
 */
export function fileMatchesAccept(file: { name: string; type: string }, accept: string): boolean {
  const patterns = accept
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (patterns.length === 0) return true;

  const fileName = file.name.toLowerCase();
  const fileType = file.type.toLowerCase();

  return patterns.some((pattern) => {
    const normalized = pattern.toLowerCase();
    if (normalized.startsWith(".")) return fileName.endsWith(normalized);
    if (normalized.endsWith("/*")) return fileType.startsWith(normalized.slice(0, -1));
    return fileType === normalized;
  });
}

/**
 * Единая drag-and-drop зона загрузки файла для всей админки: пунктирная
 * рамка, клик или Enter/Space открывают системный диалог выбора файла,
 * перетаскивание файла на зону работает так же. Заменяет разрозненные
 * `Input type="file"` / кастомные кнопки-обёртки поверх нативного input --
 * см. фидбек по единообразию зон загрузки в тенантной админке.
 */
export function FileDropZone({
  label,
  hint,
  accept,
  disabled = false,
  busy = false,
  busyLabel,
  onFile,
  ariaLabel,
  compact = false,
  className,
}: FileDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const autoId = useId();
  const isDisabled = disabled || busy;
  const showHint = Boolean(hint) && !compact;
  const hintId = showHint ? `mk-file-drop-hint-${autoId}` : undefined;
  const displayLabel = busy ? (busyLabel ?? label) : label;

  const openPicker = () => {
    if (isDisabled) return;
    inputRef.current?.click();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openPicker();
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    // Always prevent the default so a drop is accepted at all (and, when
    // disabled, so the browser doesn't fall back to navigating to the file).
    event.preventDefault();
    if (isDisabled) return;
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (isDisabled) return;
    const file = event.dataTransfer.files?.[0];
    if (file && fileMatchesAccept(file, accept)) onFile(file);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (file) onFile(file);
    // Reset so picking the same file again still fires a change event.
    event.currentTarget.value = "";
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-disabled={isDisabled || undefined}
      aria-describedby={hintId}
      aria-busy={busy || undefined}
      data-dragover={dragOver || undefined}
      data-disabled={isDisabled || undefined}
      data-busy={busy || undefined}
      className={cn("mk-file-drop", compact && "mk-file-drop--compact", className)}
      onClick={openPicker}
      onKeyDown={handleKeyDown}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        position: "relative",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: compact ? "row" : "column",
        alignItems: "center",
        justifyContent: "center",
        gap: compact ? 8 : 6,
        padding: compact ? "10px 14px" : "20px",
        border: "1px dashed var(--line-strong)",
        borderRadius: "var(--r-2)",
        background: "var(--surface-panel)",
        textAlign: "center",
        cursor: isDisabled ? "not-allowed" : "pointer",
        opacity: isDisabled ? 0.6 : 1,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          fontSize: compact ? 16 : 20,
          lineHeight: 1,
          color: "var(--fg-3)",
          pointerEvents: "none",
        }}
      >
        ⤓
      </span>
      <span
        style={{
          display: "flex",
          flexDirection: compact ? "row" : "column",
          alignItems: "center",
          gap: compact ? 6 : 2,
          minWidth: 0,
        }}
      >
        <span
          style={{
            font: compact ? "600 13px/1.3 var(--font-ui)" : "600 14px/1.4 var(--font-ui)",
            color: "var(--fg-1)",
            whiteSpace: compact ? "nowrap" : undefined,
            overflow: compact ? "hidden" : undefined,
            textOverflow: compact ? "ellipsis" : undefined,
            minWidth: compact ? 0 : undefined,
            pointerEvents: "none",
          }}
        >
          {displayLabel}
        </span>
        {showHint ? (
          <span
            id={hintId}
            style={{ font: "var(--text-caption)", color: "var(--fg-3)", pointerEvents: "none" }}
          >
            {hint}
          </span>
        ) : null}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        aria-hidden="true"
        tabIndex={-1}
        disabled={isDisabled}
        data-testid="file-drop-input"
        className="mk-visually-hidden"
        onClick={(event) => event.stopPropagation()}
        onChange={handleChange}
      />
    </div>
  );
}
