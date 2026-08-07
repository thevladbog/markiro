import { Button } from "@markiro/ui";

export interface ReasonPickerProps {
  reasons: string[];
  otherLabel: string;
  onSelect: (reason: string) => void;
  onOther: () => void;
}

export function ReasonPicker({ reasons, otherLabel, onSelect, onOther }: ReasonPickerProps) {
  return (
    <div className="exception-reasons">
      {reasons.map((reason) => (
        <Button
          key={reason}
          type="button"
          size="floor"
          variant="secondary"
          fullWidth
          onClick={() => onSelect(reason)}
        >
          {reason}
        </Button>
      ))}
      <Button type="button" size="floor" variant="secondary" fullWidth onClick={onOther}>
        {otherLabel}
      </Button>
    </div>
  );
}
