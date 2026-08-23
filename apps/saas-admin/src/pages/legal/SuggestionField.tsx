import { Input } from "@markiro/ui";
import type { DadataSuggestionStatus } from "@markiro/platform-contracts";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";

import { SuggestionMenu } from "./SuggestionMenu.js";

export function SuggestionField<T>({
  label,
  hint,
  value,
  result,
  pending,
  error,
  disabled = false,
  getKey,
  getLabel,
  getSelectedValue,
  onValueChange,
  onSelect,
}: {
  label: string;
  hint: string;
  value: string;
  result: { status: DadataSuggestionStatus; items: T[] } | undefined;
  pending: boolean;
  error: unknown;
  disabled?: boolean;
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  getSelectedValue: (item: T) => string;
  onValueChange: (value: string) => void;
  onSelect: (item: T) => void;
}) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [dismissedValue, setDismissedValue] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const items = result?.items ?? [];
  const visible =
    focused && dismissedValue !== value && result?.status === "ready" && Boolean(items.length);
  const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined;
  const activeOptionId = activeItem
    ? `${listboxId}-option-${encodeURIComponent(getKey(activeItem))}`
    : undefined;

  const dismiss = (dismissed: string) => {
    setDismissedValue(dismissed);
    setFocused(false);
    setActiveIndex(-1);
  };

  useEffect(() => {
    if (!focused) return;
    const dismissOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && fieldRef.current?.contains(target)) return;
      dismiss(value);
    };
    document.addEventListener("pointerdown", dismissOutsidePointer);
    return () => document.removeEventListener("pointerdown", dismissOutsidePointer);
  }, [focused, value]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    setDismissedValue(null);
    setFocused(true);
    setActiveIndex(-1);
    onValueChange(event.target.value);
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextFocus = event.relatedTarget;
    if (nextFocus instanceof Node && fieldRef.current?.contains(nextFocus)) return;
    dismiss(value);
  };

  const handleSelect = (item: T) => {
    dismiss(getSelectedValue(item));
    onSelect(item);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss(value);
      return;
    }
    if (!visible) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, items.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index <= 0 ? items.length - 1 : index - 1));
      return;
    }
    if (event.key === "Enter" && activeItem) {
      event.preventDefault();
      handleSelect(activeItem);
    }
  };

  return (
    <div ref={fieldRef} className="suggest-field" onBlur={handleBlur}>
      <Input
        label={label}
        value={value}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onKeyDown={handleKeyDown}
        hint={hint}
        disabled={disabled}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={visible}
        aria-activedescendant={visible ? activeOptionId : undefined}
      />
      {focused && dismissedValue !== value && (
        <SuggestionMenu
          id={listboxId}
          result={result}
          pending={pending}
          error={error}
          visible={visible}
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
          getKey={getKey}
          getLabel={getLabel}
          onSelect={handleSelect}
        />
      )}
    </div>
  );
}
