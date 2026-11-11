import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { Button, Input } from "@markiro/ui";

import { optionalLotNumber } from "../../lib/lot-number.js";
import { SCAN_END_GAP_MS, SCAN_KEY_GAP_MS } from "../kit/numeric-entry.js";
import type { ScanSource } from "../scan-source.js";

const DIGITS = "1234567890";
const LETTER_ROWS = {
  ru: ["ЁЙЦУКЕНГШЩЗХЪ", "ФЫВАПРОЛДЖЭ", "ЯЧСМИТЬБЮ"],
  en: ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"],
};

interface Props {
  source: ScanSource;
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  disabled: boolean;
}

/** Leave focus and the selection in the text field when a touch key is pressed. */
const keepFocus = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();

export function LotNumberStep({ source, value, onChange, invalid, disabled }: Props) {
  const { t } = useTranslation();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const pendingSelection = useRef<[number, number] | null>(null);
  const [language, setLanguage] = useState<"ru" | "en">("ru");
  const [upper, setUpper] = useState(true);
  const typing = useRef({
    at: Number.NEGATIVE_INFINITY,
    scan: false,
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
      source.setManualTextEntryActive(false);
    };
  }, [inputId, source]);

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
    if (event.key === "Enter") {
      if (state.scan && gap < SCAN_END_GAP_MS) event.preventDefault();
      state.at = Number.NEGATIVE_INFINITY;
      state.scan = false;
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
    if (event.key.length !== 1) return;
    if (state.scan && gap < SCAN_END_GAP_MS) {
      event.preventDefault();
      state.at = event.timeStamp;
      return;
    }
    if (!event.repeat && gap < SCAN_KEY_GAP_MS) {
      event.preventDefault();
      state.scan = true;
      state.at = event.timeStamp;
      changeAt(state.value, ...state.selection);
      return;
    }
    const start = event.currentTarget.selectionStart ?? value.length;
    state.selection = [start, event.currentTarget.selectionEnd ?? start];
    state.value = value;
    state.at = event.timeStamp;
    state.scan = false;
  };

  return (
    <div className="new-shift__lot">
      <Input
        id={inputId}
        size="floor"
        label={t("floor.newShift.lotNumber.field")}
        hint={t("floor.newShift.lotNumber.hint")}
        value={value}
        disabled={disabled}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        {...(invalid ? { error: t("rules.lotNumber") } : {})}
        onFocus={() => source.setManualTextEntryActive(true)}
        onBlur={() => source.setManualTextEntryActive(false)}
        onKeyDown={onPhysicalKey}
        onChange={(event) => onChange(event.currentTarget.value)}
        onPaste={(event) => {
          event.preventDefault();
          const pasted = optionalLotNumber(event.clipboardData.getData("text/plain"));
          if (pasted !== null) replace(pasted);
        }}
      />
      <div
        className="new-shift__lot-keyboard"
        role="group"
        aria-label={t("floor.newShift.lotNumber.keyboard")}
      >
        {[DIGITS, ...LETTER_ROWS[language]].map((row, index) => (
          <div className="new-shift__lot-keys" key={row}>
            {Array.from(row, (character) => {
              const key = upper ? character : character.toLowerCase();
              return (
                <Button
                  key={character}
                  size="floor"
                  variant="secondary"
                  className="new-shift__lot-key"
                  disabled={disabled}
                  onMouseDown={keepFocus}
                  onClick={() => replace(key)}
                >
                  {key}
                </Button>
              );
            })}
            {index === 0 &&
              (["ru", "en"] as const).map((layout) => (
                <Button
                  key={layout}
                  size="floor"
                  variant={layout === language ? "primary" : "secondary"}
                  aria-pressed={layout === language}
                  disabled={disabled}
                  onMouseDown={keepFocus}
                  onClick={() => setLanguage(layout)}
                >
                  {t(
                    layout === "ru"
                      ? "floor.newShift.lotNumber.russian"
                      : "floor.newShift.lotNumber.english",
                  )}
                </Button>
              ))}
            {index === 2 && (
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
    </div>
  );
}
