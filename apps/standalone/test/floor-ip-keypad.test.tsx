import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IpKeypad } from "../src/floor/kit/IpKeypad.js";
import type { IpTarget } from "../src/floor/kit/ip-entry.js";

afterEach(cleanup);

function Harness({ start = "", target = "host" as IpTarget, onAction = () => undefined }) {
  const [value, setValue] = useState(start);
  const [now, setNow] = useState<IpTarget>(target);
  return (
    <>
      <output data-testid="value">{value}</output>
      <IpKeypad
        target={now}
        targets={[
          { value: "host", label: "Адрес" },
          { value: "port", label: "Порт" },
        ]}
        onTargetChange={setNow}
        value={value}
        onChange={setValue}
        ariaLabel="Клавиатура адреса"
        segmentLabel="Куда вводим"
        eraseLabel="Стереть"
        actionLabel={now === "host" ? "Далее: порт" : "Закрыть клавиатуру"}
        actionPrimary={now === "host"}
        onAction={onAction}
      />
    </>
  );
}

const key = (name: string) => screen.getByRole("button", { name });

describe("IpKeypad", () => {
  it("types digits and dots, and erases", () => {
    render(<Harness />);
    for (const k of ["1", "9", "2", ".", "1"]) fireEvent.click(key(k));
    expect(screen.getByTestId("value").textContent).toBe("192.1");
    fireEvent.click(key("Стереть"));
    expect(screen.getByTestId("value").textContent).toBe("192.");
  });

  it("offers the dot only to the address: the port's cell is empty and the keys stay put", () => {
    render(<Harness target="port" />);
    expect(screen.queryByRole("button", { name: "." })).toBeNull();
    expect(document.querySelectorAll(".floor-ipkeypad__keys > *")).toHaveLength(12);
    expect(key("0")).toBeTruthy();
  });

  it("moves the target with its segment, one tab stop with the arrows", () => {
    render(<Harness />);
    const address = screen.getByRole("radio", { name: "Адрес" });
    const port = screen.getByRole("radio", { name: "Порт" });
    expect(address.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(address, { key: "ArrowRight" });
    expect(port.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Закрыть клавиатуру" })).toBeTruthy();
  });

  it("presses the panel's action", () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Далее: порт" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("never takes the focus from the field it types into", () => {
    render(<Harness />);
    const down = createEvent.mouseDown(key("5"));
    fireEvent(key("5"), down);
    expect(down.defaultPrevented).toBe(true);
  });
});
