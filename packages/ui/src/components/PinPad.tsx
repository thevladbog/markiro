import { Button } from "./Button.js";

export type PinPadSize = "md" | "floor";

export interface PinPadProps {
  value: string;
  onChange: (next: string) => void;
  /** Caps the entry length; omitted means unbounded (the station's PIN entry). */
  maxLength?: number;
  size?: PinPadSize;
  disabled?: boolean;
  ariaLabel?: string;
  backspaceLabel?: string;
  clearLabel?: string;
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

// Controlled numeric keypad. The bottom row is always correction / zero / clear,
// so key positions stay predictable under a glove.
export function PinPad({
  value,
  onChange,
  maxLength,
  size = "floor",
  disabled = false,
  ariaLabel = "Numeric keypad",
  backspaceLabel = "Backspace",
  clearLabel = "Clear",
}: PinPadProps) {
  const atLimit = maxLength !== undefined && value.length >= maxLength;
  const press = (digit: string) => {
    if (disabled || atLimit) return;
    onChange(value + digit);
  };
  const keySize = size === "floor" ? "var(--control-keypad)" : "var(--control-floor)";
  const keyStyle = {
    minWidth: keySize,
    minHeight: keySize,
    padding: "0 8px",
    font: size === "floor" ? "var(--floor-lg)" : undefined,
    fontSize: size === "floor" ? 22 : undefined,
  } as const;

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(3, ${keySize})`,
        gap: 12,
      }}
    >
      {DIGITS.map((digit) => (
        <Button
          key={digit}
          size={size === "floor" ? "floor" : "md"}
          disabled={disabled || atLimit}
          style={keyStyle}
          onClick={() => press(digit)}
        >
          {digit}
        </Button>
      ))}
      <Button
        size={size === "floor" ? "floor" : "md"}
        variant="secondary"
        disabled={disabled || value.length === 0}
        style={{ ...keyStyle, fontSize: size === "floor" ? 18 : undefined }}
        onClick={() => onChange(value.slice(0, -1))}
      >
        {backspaceLabel}
      </Button>
      <Button
        size={size === "floor" ? "floor" : "md"}
        disabled={disabled || atLimit}
        style={keyStyle}
        onClick={() => press("0")}
      >
        0
      </Button>
      <Button
        size={size === "floor" ? "floor" : "md"}
        variant="secondary"
        disabled={disabled || value.length === 0}
        style={{ ...keyStyle, fontSize: size === "floor" ? 18 : undefined }}
        onClick={() => onChange("")}
      >
        {clearLabel}
      </Button>
    </div>
  );
}
