import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { RadioCard } from "../src/index.js";

afterEach(cleanup);

function Choices() {
  const [value, setValue] = useState("left");
  const [selections, setSelections] = useState(0);
  return (
    <>
      {["left", "right"].map((side) => (
        <RadioCard
          key={side}
          name="field"
          label={side}
          title="Name"
          caption={side}
          checked={value === side}
          disabled={false}
          onSelect={() => {
            setValue(side);
            setSelections((n) => n + 1);
          }}
        >
          {side === "left" ? "Local value" : "Incoming value"}
        </RadioCard>
      ))}
      <output>
        {value}:{selections}
      </output>
    </>
  );
}

it("selects by value text and emits exactly one selection even for the checked cell", async () => {
  render(<Choices />);
  const user = userEvent.setup();
  await user.click(screen.getByText("Incoming value"));
  expect(screen.getByRole("status").textContent).toBe("right:1");
  expect((screen.getByRole("radio", { name: "left" }) as HTMLInputElement).checked).toBe(false);
  await user.click(screen.getByText("Incoming value"));
  expect(screen.getByRole("status").textContent).toBe("right:2");
});

it("announces the value and reason and refuses disabled selections", async () => {
  let selected = false;
  render(
    <RadioCard
      name="field"
      label="Incoming"
      title="Name"
      caption="Provider"
      checked={false}
      disabled
      onSelect={() => {
        selected = true;
      }}
      description="Category required"
    >
      Milk
    </RadioCard>,
  );
  const radio = screen.getByRole("radio", {
    name: "Incoming",
    description: /Provider Milk Category required/,
  });
  await userEvent.setup().click(screen.getByText("Milk"));
  expect(radio.hasAttribute("disabled")).toBe(true);
  expect(selected).toBe(false);
});
