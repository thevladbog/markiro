import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { WorkstationSetup } from "../../src/floor/setup/WorkstationSetup.js";
import { fakeHardware } from "../support/hardware.js";
import { openLocalDb } from "../support/local-db.js";
import { fakeRender, manualRuntime } from "../support/printing.js";

describe("the scanner setup under late passive effects", () => {
  it("shows the heading before the focus lands on it, and the focus does land", async () => {
    const shell = fakeHardware();
    render(
      <ThemeProvider>
        <WorkstationSetup
          scope="scanners"
          local={openLocalDb().executor}
          hardware={shell.hardware}
          printing={manualRuntime(shell.hardware).runtime}
          source={{
            start: () => () => undefined,
            clearPendingInput: () => undefined,
            setManualTextEntryActive: () => undefined,
          }}
          render={fakeRender}
          onSaved={vi.fn()}
          onBack={vi.fn()}
        />
      </ThemeProvider>,
    );
    const heading = await screen.findByRole("heading", { name: "Сканеры" });
    // The old form of the check read the focus here: with the effect late, it was the body.
    expect(document.activeElement).not.toBe(heading);
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});
