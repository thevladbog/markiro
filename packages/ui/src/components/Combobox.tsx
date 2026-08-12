import * as RadixPopover from "@radix-ui/react-popover";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "../cn.js";
import { useOverlayPortalContainer } from "./OverlayLayer.js";

export interface ComboboxOption<TValue extends string = string> {
  value: TValue;
  label: string;
  description?: string;
  group?: string;
  keywords?: readonly string[];
  disabled?: boolean;
}

export interface ComboboxProps<TValue extends string = string> {
  label: string;
  options: readonly ComboboxOption<TValue>[];
  value?: TValue;
  onValueChange: (value: TValue) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  loadingText: string;
  loading?: boolean;
  disabled?: boolean;
  error?: string;
  className?: string;
}

function matchesQuery(option: ComboboxOption, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;

  return [option.label, option.description, option.group, ...(option.keywords ?? [])]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLocaleLowerCase().includes(needle));
}

function groupOptions<TValue extends string>(options: readonly ComboboxOption<TValue>[]) {
  const groups = new Map<string, ComboboxOption<TValue>[]>();

  options.forEach((option) => {
    const group = option.group ?? "";
    const groupOptions = groups.get(group);
    if (groupOptions) {
      groupOptions.push(option);
    } else {
      groups.set(group, [option]);
    }
  });

  return Array.from(groups, ([label, groupOptions]) => ({ label, options: groupOptions }));
}

export function Combobox<TValue extends string = string>({
  label,
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  loadingText,
  loading = false,
  disabled = false,
  error,
  className,
}: ComboboxProps<TValue>) {
  const overlayPortalContainer = useOverlayPortalContainer();
  const autoId = useId();
  const triggerId = `mk-combobox-${autoId}`;
  const listboxId = `${triggerId}-listbox`;
  const errorId = `${triggerId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);

  const filteredOptions = useMemo(
    () => options.filter((option) => matchesQuery(option, query)),
    [options, query],
  );
  const enabledOptions = useMemo(
    () => filteredOptions.filter((option) => !option.disabled),
    [filteredOptions],
  );
  const groupedOptions = useMemo(() => groupOptions(filteredOptions), [filteredOptions]);
  const selectedOption = options.find((option) => option.value === value);
  const activeOption = enabledOptions[activeIndex];

  useEffect(() => {
    if (!open) return;
    setActiveIndex((current) => (current >= enabledOptions.length ? -1 : current));
  }, [enabledOptions.length, open]);

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  const close = () => {
    setOpen(false);
  };

  const selectOption = (option: ComboboxOption<TValue>) => {
    if (option.disabled) return;
    onValueChange(option.value);
    setQuery("");
    close();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (disabled) return;
    setOpen(nextOpen);
    if (!nextOpen) setQuery("");
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (enabledOptions.length > 0) {
        setActiveIndex((current) => (current + 1) % enabledOptions.length);
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (enabledOptions.length > 0) {
        setActiveIndex((current) => (current <= 0 ? enabledOptions.length - 1 : current - 1));
      }
      return;
    }

    if (event.key === "Enter" && activeOption) {
      event.preventDefault();
      selectOption(activeOption);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      close();
      triggerRef.current?.focus();
    }
  };

  return (
    <div className={cn("mk-combobox", className)}>
      <label className="mk-combobox__label" htmlFor={triggerId}>
        {label}
      </label>
      <RadixPopover.Root open={open} onOpenChange={handleOpenChange}>
        <RadixPopover.Trigger asChild>
          <button
            ref={triggerRef}
            id={triggerId}
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="mk-combobox__trigger"
            disabled={disabled}
          >
            <span className={selectedOption ? undefined : "mk-combobox__placeholder"}>
              {selectedOption?.label ?? placeholder}
            </span>
            <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none">
              <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        </RadixPopover.Trigger>
        <RadixPopover.Portal
          {...(overlayPortalContainer === undefined ? {} : { container: overlayPortalContainer })}
        >
          <RadixPopover.Content
            data-mk-nested-overlay=""
            className="mk-combobox__content"
            align="start"
            sideOffset={4}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              inputRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              triggerRef.current?.focus();
            }}
          >
            <input
              ref={inputRef}
              role="searchbox"
              aria-label={searchPlaceholder}
              aria-controls={listboxId}
              aria-activedescendant={
                activeOption ? `${listboxId}-${activeOption.value}` : undefined
              }
              className="mk-combobox__search"
              value={query}
              placeholder={searchPlaceholder}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(-1);
              }}
              onKeyDown={handleInputKeyDown}
            />
            <div id={listboxId} className="mk-combobox__listbox" role="listbox" aria-label={label}>
              {loading ? (
                <div className="mk-combobox__status" role="status">
                  {loadingText}
                </div>
              ) : groupedOptions.length === 0 ? (
                <div className="mk-combobox__status">{emptyText}</div>
              ) : (
                groupedOptions.map((group) => (
                  <div
                    key={group.label}
                    className="mk-combobox__group"
                    role={group.label ? "group" : undefined}
                    aria-label={group.label || undefined}
                  >
                    {group.label ? (
                      <div className="mk-combobox__group-label">{group.label}</div>
                    ) : null}
                    {group.options.map((option) => {
                      const optionIndex = enabledOptions.findIndex(
                        (enabledOption) => enabledOption.value === option.value,
                      );
                      const active = optionIndex === activeIndex;
                      return (
                        <button
                          key={option.value}
                          id={`${listboxId}-${option.value}`}
                          type="button"
                          role="option"
                          aria-selected={option.value === value}
                          className="mk-combobox__option"
                          data-active={active || undefined}
                          data-selected={option.value === value || undefined}
                          disabled={option.disabled}
                          onMouseMove={() => {
                            if (optionIndex >= 0) setActiveIndex(optionIndex);
                          }}
                          onClick={() => selectOption(option)}
                        >
                          <span className="mk-combobox__option-copy">
                            <span>{option.label}</span>
                            {option.description ? (
                              <span className="mk-combobox__option-description">
                                {option.description}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </RadixPopover.Content>
        </RadixPopover.Portal>
      </RadixPopover.Root>
      {error ? (
        <span id={errorId} className="mk-combobox__error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
