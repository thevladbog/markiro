import { mkdirSync, writeFileSync } from "node:fs";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { OperatorSignIn } from "../../../src/floor/OperatorSignIn.js";
import { Reconfirm } from "../../../src/floor/Reconfirm.js";
import { createKeyboardWedgeSource } from "../../../src/floor/scan-source.js";
import type { ChangeItem } from "../../../src/host/protocol.js";
import { syncReferences } from "../../../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "../../support/fixtures.js";
import { openLocalDb } from "../../support/local-db.js";

/**
 * Gallery for the window-mode work (floor-window-mode): the sign-in and the identity
 * re-confirmation (the dialog shown on leaving the full-screen mode), rendered under jsdom in
 * each state; the DOM goes to `OUT/<name>.json` and Chromium shows it over the real built CSS
 * (`/tmp/claude/shots/floor-window-mode/shoot.mjs`). Not a CI test; run with
 * `vitest run --config test/harness/window-mode/vitest.harness.config.ts`.
 */
const OUT = process.env["WINDOW_MODE_OUT"] ?? "/tmp/claude/shots/floor-window-mode/html/";
mkdirSync(OUT, { recursive: true });

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const NOW = 1_790_000_000_000;
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
const ITEMS: ChangeItem[] = [
  {
    entity: "site",
    id: "1",
    rev: 1,
    deleted: false,
    data: { badgeSalt: "AAECAwQFBgcICQoLDA0ODw==", boxBlockSize: 2000, palletBlockSize: 200 },
  },
  {
    entity: "operators",
    id: ANNA,
    rev: 5,
    deleted: false,
    data: { login: "0042", name: "Анна Кузнецова", role: null, pinPhc: PIN_PHC },
  },
];

/** A stand-in for the status bar: a band with the rail's 64 px sync button. */
const BAR = `<section class="station-status-bar floor-status" aria-label="bar"><div class="station-status-actions"><button class="mk-btn mk-btn--floor station-rail-button station-rail-button--icon" aria-label="Синхронизация"></button></div></section>`;

async function mount(reconfirm: boolean) {
  const { executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items: ITEMS }),
    local: executor,
    ...PAIRING,
  });
  const source = createKeyboardWedgeSource(window);
  render(
    <ThemeProvider>
      <div className="floor-frame">
        <div dangerouslySetInnerHTML={{ __html: BAR }} />
        <OperatorSignIn
          local={executor}
          pairing={PAIRING}
          lineId={null}
          sync={{ kind: "done", synced: 1, failure: null, quarantined: 0 }}
          notice={null}
          source={source}
          now={() => NOW}
          onSignedIn={vi.fn()}
          onSync={vi.fn()}
          onOffice={vi.fn()}
        />
        {reconfirm && (
          <Reconfirm
            open
            title="Выйти из полноэкранного режима?"
            detail="Производство продолжится, изменится только режим окна. Оператор, смена и очередь отправки останутся на месте. Подтвердите, что это вы."
            confirmLabel="Подтвердить"
            local={executor}
            pairing={PAIRING}
            source={source}
            onMute={vi.fn()}
            expectedOperatorId={ANNA}
            onConfirmed={vi.fn()}
            onCancel={vi.fn()}
            now={() => NOW}
          />
        )}
      </div>
    </ThemeProvider>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
}

async function shot(name: string) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
  const container = document.body.firstElementChild as HTMLElement;
  writeFileSync(`${OUT}${name}.json`, JSON.stringify({ name, screen: container.innerHTML }));
}

const press = (...keys: string[]) => {
  const dialog = within(screen.getByRole("dialog"));
  for (const key of keys) fireEvent.click(dialog.getByRole("button", { name: key }));
};

describe("window-mode gallery", () => {
  it("the sign-in", async () => {
    await mount(false);
    await shot("signin");
    cleanup();
  }, 90000);
  it("the re-confirmation: badge, number and PIN, a refusal", async () => {
    await mount(true);
    await shot("reconfirm-badge");
    fireEvent.click(await screen.findByRole("button", { name: "Ввести табельный номер" }));
    press("0", "0", "4", "2");
    press("PIN");
    press("1", "1");
    await shot("reconfirm-entry");
    press("1", "1");
    press("Подтвердить");
    await screen.findByText("Ошибка · PIN очищен");
    await shot("reconfirm-error");
    cleanup();
  }, 90000);
});
