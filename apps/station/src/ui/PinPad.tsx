import { Button } from "@markiro/ui";

export interface PinPadProps {
  value: string;
  onChange: (next: string) => void;
}

// Floor-mode digit pad: 64px+ keys, digits only (design brief 04).
export function PinPad({ value, onChange }: PinPadProps) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 96px)", gap: 12 }}>
      {keys.map((k) => (
        <Button
          key={k}
          style={{ minWidth: 96, minHeight: 96, fontSize: "2rem" }}
          onClick={() => onChange(value + k)}
        >
          {k}
        </Button>
      ))}
    </div>
  );
}
