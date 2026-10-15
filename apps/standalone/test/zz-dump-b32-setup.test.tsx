// Not committed: dumps the setup screen's real DOM for a browser look.
import { mkdirSync, writeFileSync } from "node:fs";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { WorkstationSetup } from "../src/floor/setup/WorkstationSetup.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { manualRuntime } from "./support/printing.js";

const DIR = process.env["DUMP_DIR"];
const run = DIR === undefined ? describe.skip : describe;
function dump(name: string) {
  if (DIR === undefined) return;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/${name}.html`, document.body.innerHTML);
}

run("dump", () => {
  it("setup", async () => {
    const shell = fakeHardware();
    render(
      <ThemeProvider>
        <WorkstationSetup
          local={openLocalDb().executor}
          hardware={shell.hardware}
          printing={manualRuntime(shell.hardware).runtime}
          source={{
            start: () => () => undefined,
            clearPendingInput: () => undefined,
            setManualTextEntryActive: () => undefined,
          }}
          onSaved={vi.fn()}
          onBack={vi.fn()}
        />
      </ThemeProvider>,
    );
    await screen.findByRole("heading", { name: "Принтеры" });
    fireEvent.click(screen.getByRole("tab", { name: "Сканер" }));
    dump("setup-scanner");
    const check = screen.queryByRole("tab", { name: "Проверка сканера" });
    if (check) {
      fireEvent.click(check);
      dump("setup-check");
    }
  });
});
