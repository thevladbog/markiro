import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { Button, Input, type InputProps } from "@markiro/ui";

import { SCAN_END_GAP_MS, SCAN_KEY_GAP_MS } from "./numeric-entry.js";
import "./text-keyboard.css";

const DIGITS = "1234567890";
const LETTER_ROWS = {
  ru: ["ЁЙЦУКЕНГШЩЗХЪ", "ФЫВАПРОЛДЖЭ", "ЯЧСМИТЬБЮ"],
  en: ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"],
};
const SYMBOL_ROWS = ["!\"#$%&'()*+", ",-./:;<=>?", "@[\\]^_`{|}~"];
const SCAN_BURST_MIN_KEYS = 3;

type Language = keyof typeof LETTER_ROWS;
type Layout = Language | "symbols";

interface Props extends Omit<InputProps, "size" | "value" | "onChange" | "onKeyDown" | "onPaste"> {
  value: string;
  onChange: (value: string) => void;
  initialLanguage?: Language;
  allowSymbols?: boolean;
  normalizePaste?: (text: string) => string | null;
}

/** Leave focus and the selection in the text field when a touch key is pressed. */
const keepFocus = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();

export function TextKeyboardInput({
  value,
  onChange,
  disabled = false,
  initialLanguage = "ru",
  allowSymbols = false,
  normalizePaste,
  id,
  ...fieldProps
}: Props) {
  const { t } = useTranslation();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const input = useRef<HTMLInputElement>(null);
  const pendingSelection = useRef<[number, number] | null>(null);
  const [layout, setLayout] = useState<Layout>(initialLanguage);
  const [upper, setUpper] = useState(true);
  const layouts: Layout[] = allowSymbols ? ["ru", "en", "symbols"] : ["ru", "en"];
  const rows = layout === "symbols" ? SYMBOL_ROWS : LETTER_ROWS[layout];
  const typing = useRef({
    at: Number.NEGATIVE_INFINITY,
    keys: 0,
    value: "",
    selection: [0, 0] as [number, number],
  });

  useLayoutEffect(() => {
    const field = document.getElementById(inputId);
    if (field instanceof HTMLInputElement) {
      input.current = field;
      field.focus();
    }
    return () => {
      input.current = null;
    };
  }, [inputId]);

  useLayoutEffect(() => {
    if (pendingSelection.current !== null) {
      input.current?.setSelectionRange(...pendingSelection.current);
      pendingSelection.current = null;
    }
  }, [value]);

  const changeAt = (next: string, start: number, end = start) => {
    input.current?.focus();
    if (next === value) {
      input.current?.setSelectionRange(start, end);
    } else {
      pendingSelection.current = [start, end];
      onChange(next);
    }
  };

  const replace = (text: string, erase = false) => {
    const from = input.current?.selectionStart ?? value.length;
    const to = input.current?.selectionEnd ?? from;
    const start = erase && from === to ? Math.max(0, from - 1) : from;
    changeAt(value.slice(0, start) + text + value.slice(to), start + text.length);
  };

  // Like the numeric keypad, roll back a rapid wedge burst and keep its Enter
  // from activating a control. Ordinary editing and keyboard shortcuts stay native.
  const onPhysicalKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const state = typing.current;
    const gap = event.timeStamp - state.at;
    const scan = state.keys >= SCAN_BURST_MIN_KEYS;
    if (event.key === "Enter") {
      if (scan && gap < SCAN_END_GAP_MS) event.preventDefault();
      state.at = Number.NEGATIVE_INFINITY;
      state.keys = 0;
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
    if (event.key.length !== 1) return;
    if (scan && gap < SCAN_END_GAP_MS) {
      event.preventDefault();
      state.at = event.timeStamp;
      return;
    }
    if (!event.repeat && gap < SCAN_KEY_GAP_MS) {
      state.keys += 1;
      state.at = event.timeStamp;
      // Keep a fast pair as native input. A third key confirms the burst and
      // restores the text and selection from before the first key.
      if (state.keys === SCAN_BURST_MIN_KEYS) {
        event.preventDefault();
        changeAt(state.value, ...state.selection);
      }
      return;
    }
    const start = event.currentTarget.selectionStart ?? value.length;
    state.selection = [start, event.currentTarget.selectionEnd ?? start];
    state.value = value;
    state.at = event.repeat ? Number.NEGATIVE_INFINITY : event.timeStamp;
    state.keys = event.repeat ? 0 : 1;
  };

  return (
    <>
      <Input
        id={inputId}
        size="floor"
        value={value}
        disabled={disabled}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        {...fieldProps}
        onKeyDown={onPhysicalKey}
        onChange={(event) => onChange(event.currentTarget.value)}
        onPaste={(event) => {
          if (normalizePaste === undefined) return;
          event.preventDefault();
          const pasted = normalizePaste(event.clipboardData.getData("text/plain"));
          if (pasted !== null) replace(pasted);
        }}
      />
      <div
        className="floor-text-keyboard"
        role="group"
        aria-label={t("floor.newShift.lotNumber.keyboard")}
      >
        {[DIGITS, ...rows].map((row, index) => (
          <div className="floor-text-keyboard__row" key={index}>
            {Array.from(row, (character) => {
              const key = upper ? character : character.toLowerCase();
              return (
                <Button
                  key={character}
                  size="floor"
                  variant="secondary"
                  className="floor-text-keyboard__key"
                  disabled={disabled}
                  onMouseDown={keepFocus}
                  onClick={() => replace(key)}
                >
                  {key}
                </Button>
              );
            })}
            {index === 0 &&
              layouts.map((next) => (
                <Button
                  key={next}
                  size="floor"
                  variant={next === layout ? "primary" : "secondary"}
                  aria-pressed={next === layout}
                  className="floor-text-keyboard__layout"
                  disabled={disabled}
                  onMouseDown={keepFocus}
                  onClick={() => setLayout(next)}
                >
                  {t(
                    next === "ru"
                      ? "floor.newShift.lotNumber.russian"
                      : next === "en"
                        ? "floor.newShift.lotNumber.english"
                        : "floor.warehouse.manualSymbols",
                  )}
                </Button>
              ))}
            {index === 2 && layout !== "symbols" && (
              <Button
                size="floor"
                variant="secondary"
                aria-pressed={upper}
                disabled={disabled}
                onMouseDown={keepFocus}
                onClick={() => setUpper((current) => !current)}
              >
                {t("floor.newShift.lotNumber.case")}
              </Button>
            )}
            {index === 2 && layout === "symbols" && (
              <Button
                size="floor"
                variant="secondary"
                aria-label={t("floor.warehouse.manualGroupSeparator")}
                disabled={disabled}
                onMouseDown={keepFocus}
                onClick={() => replace("\u001d")}
              >
                GS
              </Button>
            )}
            {index === 3 && (
              <>
                <Button
                  size="floor"
                  variant="secondary"
                  aria-label={t("floor.newShift.lotNumber.backspace")}
                  disabled={disabled}
                  onMouseDown={keepFocus}
                  onClick={() => replace("", true)}
                >
                  <span aria-hidden="true">⌫</span>
                </Button>
                <Button
                  size="floor"
                  variant="secondary"
                  disabled={disabled}
                  onMouseDown={keepFocus}
                  onClick={() => changeAt("", 0)}
                >
                  {t("floor.newShift.lotNumber.clear")}
                </Button>
              </>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
