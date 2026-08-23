export interface SsccSearchPadLabels {
  /** Accessible name for the whole pad, e.g. «Поиск по последним цифрам SSCC». */
  group: string;
  /** Placeholder shown while nothing is typed. */
  placeholder: string;
  backspace: string;
  clear: string;
}

export interface SsccSearchPadProps {
  value: string;
  onChange: (next: string) => void;
  labels: SsccSearchPadLabels;
  /** SSCC is 18 digits; more tail than that cannot narrow anything further. */
  maxLength?: number;
}

const KEY_ROWS: readonly (readonly string[])[] = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
];

/**
 * Touch-first digit entry for the box target picker. Deliberately NOT a text
 * input: a focusable field would swallow the keyboard-wedge scanner's
 * keystrokes, and the scanner must keep working while this pad is on screen.
 * Taps and scans are therefore two independent ways into the same list.
 */
export function SsccSearchPad({ value, onChange, labels, maxLength = 18 }: SsccSearchPadProps) {
  const append = (digit: string) => {
    if (value.length < maxLength) onChange(value + digit);
  };
  return (
    <div className="sscc-search" role="group" aria-label={labels.group}>
      <div className="sscc-search__field" data-empty={value === "" ? "true" : undefined}>
        <output className="sscc-search__value" data-testid="sscc-search-value" aria-live="polite">
          {value === "" ? labels.placeholder : `…${value}`}
        </output>
        {value !== "" ? (
          <button
            type="button"
            className="sscc-search__clear"
            aria-label={labels.clear}
            onClick={() => onChange("")}
          >
            ✕
          </button>
        ) : null}
      </div>
      <div className="sscc-search__pad">
        {KEY_ROWS.map((row) => (
          <div key={row[0]} className="sscc-search__row">
            {row.map((digit) => (
              <button
                key={digit}
                type="button"
                className="sscc-search__key"
                onClick={() => append(digit)}
              >
                {digit}
              </button>
            ))}
          </div>
        ))}
        <div className="sscc-search__row">
          <button
            type="button"
            className="sscc-search__key sscc-search__key--muted"
            aria-label={labels.backspace}
            onClick={() => onChange(value.slice(0, -1))}
          >
            ⌫
          </button>
          <button type="button" className="sscc-search__key" onClick={() => append("0")}>
            0
          </button>
          <button
            type="button"
            className="sscc-search__key sscc-search__key--muted"
            aria-label={labels.clear}
            onClick={() => onChange("")}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
