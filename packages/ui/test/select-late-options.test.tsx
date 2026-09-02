import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Select } from "../src/components/index.js";

afterEach(() => {
  cleanup();
});

describe("Select with options that arrive after the value", () => {
  it("does not report an empty change while the selected option has not rendered yet", () => {
    const onValueChange = vi.fn();
    const empty = { value: "", label: "Not selected" };
    const { rerender } = render(
      <Select label="Template" options={[empty]} value="tpl-1" onValueChange={onValueChange} />,
    );
    // The options load later, and the previously saved value is among them.
    rerender(
      <Select
        label="Template"
        options={[empty, { value: "tpl-1", label: "Box 58×40" }]}
        value="tpl-1"
        onValueChange={onValueChange}
      />,
    );
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
