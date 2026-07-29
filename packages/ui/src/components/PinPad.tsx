import { Button } from "./Button.js";

export interface PinPadProps {
  value: string;
  onChange: (next: string) => void;
  /** Caps the entry length; omitted means unbounded (the station's PIN entry). */
  maxLength?: number;
}

// Floor-mode digit pad: 64px+ keys, digits only (design brief 04).
export function PinPad({ value, onChange, maxLength }: PinPadProps) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
  const press = (digit: string) => {
    if (maxLength !== undefined && value.length >= maxLength) return;
    onChange(value + digit);
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 96px)", gap: 12 }}>
      {keys.map((k) => (
        <Button
          key={k}
          style={{ minWidth: 96, minHeight: 96, fontSize: "2rem" }}
          onClick={() => press(k)}
        >
          {k}
        </Button>
      ))}
    </div>
  );
}
