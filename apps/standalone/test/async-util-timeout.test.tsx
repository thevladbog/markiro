import { render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";

// `test/setup.ts` raises Testing Library's `asyncUtilTimeout` (1 s by default), so that a
// `findBy*` waits as long as its own test does. On a loaded machine the first paint of a heavy
// dialog takes longer than a second, and the default made such a test fail as "Unable to find"
// long before the test's own timeout. The wait is no assertion about speed.
function AppearsLate({ afterMs }: { afterMs: number }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), afterMs);
    return () => clearTimeout(timer);
  }, [afterMs]);
  return shown ? <p>Готово</p> : <p>Ждём</p>;
}

describe("the wait of a findBy* (test setup)", () => {
  it("lasts longer than Testing Library's own second", async () => {
    render(<AppearsLate afterMs={1_300} />);
    expect(await screen.findByText("Готово")).toBeTruthy();
  });
});
