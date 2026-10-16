import { Select } from "@markiro/ui";

import { FilterGroup } from "./ListCard.js";
import { Segmented } from "./Segmented.js";
import { filterControlKind } from "./segment-model.js";

export interface StateFilterProps<Value extends string> {
  /** The filter's name: the field's label, or the segments' group name. */
  label: string;
  options: readonly { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
}

/**
 * A filter of one value out of a few (a record's state, a status). The kit's rule (owner decision
 * 2026-10): up to three values are a segmented control, so every choice is in view; four and more
 * are a select. One component, so a page never picks by taste and the rule changes in one place.
 */
export function StateFilter<Value extends string>({
  label,
  options,
  value,
  onChange,
}: StateFilterProps<Value>) {
  if (filterControlKind(options.length) === "segments") {
    return (
      <FilterGroup label={label}>
        <Segmented
          label={label}
          value={value}
          options={options.map((option) => ({ id: option.value, label: option.label }))}
          onChange={onChange}
        />
      </FilterGroup>
    );
  }
  return (
    <Select
      label={label}
      options={options.map((option) => ({ value: option.value, label: option.label }))}
      value={value}
      onValueChange={onChange}
    />
  );
}
