import { mkdirSync, writeFileSync } from "node:fs";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { OperatorSignIn, type OperatorSignInProps } from "../../../src/floor/OperatorSignIn.js";
import { createKeyboardWedgeSource } from "../../../src/floor/scan-source.js";
import type { ChangeItem } from "../../../src/host/protocol.js";
import { syncReferences } from "../../../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "../../support/fixtures.js";
import { openLocalDb } from "../../support/local-db.js";

/**
 * Gallery of the redesigned sign-in for the station audit (docs/design-briefs/station-visual-signoff-2026-10.md,
 * `shoot.mjs`): the real screen is rendered under jsdom in each state and its DOM written to
 * `OUT/<name>.json`; Chromium then shows it over the real built CSS. Not a CI test (it is not
 * matched by `vitest.config.ts`); run with `vitest run --config test/harness/sign-in-states/vitest.harness.config.ts`.
 * `OUT` is `SIGNIN_SHOTS_OUT` or `/tmp/claude/shots/signin-redesign/html/`.
 */
const OUT = process.env["SIGNIN_SHOTS_OUT"] ?? "/tmp/claude/shots/signin-redesign/html/";
mkdirSync(OUT, { recursive: true });

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const NOW = 1_790_000_000_000;
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
const SITE: ChangeItem = {
  entity: "site",
  id: "1",
  rev: 1,
  deleted: false,
  data: { badgeSalt: "AAECAwQFBgcICQoLDA0ODw==", boxBlockSize: 2000, palletBlockSize: 200 },
};
const people = [
  ["8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b", "0042", "Анна Кузнецова"],
  ["3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f", "0107", "Андрей Волков"],
  ["5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", "0233", "Антон Сидоров"],
] as const;
const OPERATORS: ChangeItem[] = people.map(([id, login, name], index) => ({
  entity: "operators",
  id,
  rev: 5 + index,
  deleted: false,
  data: { login, name, role: null, pinPhc: PIN_PHC },
}));
const BADGE: ChangeItem = {
  entity: "operator_badges",
  id: "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d",
  rev: 9,
  deleted: false,
  data: {
    operatorId: people[0][0],
    badgePhc:
      "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=",
    label: null,
  },
};

interface Options {
  items?: ChangeItem[];
  synced?: number;
  notice?: OperatorSignInProps["notice"];
  lock?: "station" | "operator";
  watchScanners?: OperatorSignInProps["watchScanners"];
  successHoldMs?: number;
}

async function mount(o: Options = {}) {
  const { executor } = openLocalDb();
  const items = o.items ?? [SITE, ...OPERATORS, BADGE];
  if (items.length > 0)
    await syncReferences({
      changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items }),
      local: executor,
      ...PAIRING,
    });
  const lock = (key: string, failures: number, at: number) =>
    executor.transaction([
      {
        sql: "INSERT INTO floor_sign_in_failures (key, failures, locked_at, last_failure_at) VALUES (?, ?, ?, ?)",
        values: [key, failures, at, at],
      },
    ]);
  if (o.lock === "station") await lock("station", 10, NOW - 28_000);
  if (o.lock === "operator") await lock(`operator:${people[0][0]}`, 5, NOW - 28_000);
  render(
    <ThemeProvider>
      <OperatorSignIn
        local={executor}
        pairing={PAIRING}
        lineId={null}
        sync={{ kind: "done", synced: o.synced ?? 1, failure: null, quarantined: 0 }}
        notice={o.notice ?? null}
        source={createKeyboardWedgeSource(window)}
        now={() => NOW}
        onSignedIn={vi.fn()}
        onSync={vi.fn()}
        onOffice={vi.fn()}
        {...(o.watchScanners === undefined ? {} : { watchScanners: o.watchScanners })}
        {...(o.successHoldMs === undefined ? {} : { successHoldMs: o.successHoldMs })}
      />
    </ThemeProvider>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 500));
  });
}

async function shot(name: string) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  const container = document.body.firstElementChild as HTMLElement;
  writeFileSync(
    `${OUT}${name}.json`,
    JSON.stringify({
      name,
      group: "signin-redesign",
      bar: "signin",
      sizes: ["1280x1024", "1280x800", "1024x768"],
      scroll: [],
      screen: container.innerHTML,
      overlay: "",
    }),
  );
}

const press = (...keys: string[]) => {
  for (const key of keys) fireEvent.click(screen.getByRole("button", { name: key }));
};
const scan = (text: string) => {
  for (const key of text) fireEvent.keyDown(window, { key });
  fireEvent.keyDown(window, { key: "Enter" });
};
const disconnected = ((
  onSnapshot: (s: {
    revision: number;
    scanners: { port: string; baud: number; status: "disconnected" }[];
  }) => void,
) => {
  onSnapshot({ revision: 1, scanners: [{ port: "COM3", baud: 9600, status: "disconnected" }] });
  return Promise.resolve(() => undefined);
}) as NonNullable<OperatorSignInProps["watchScanners"]>;

describe("sign-in gallery", () => {
  it("scan and manual entry, typing, a refused badge, a wrong PIN", async () => {
    await mount();
    await shot("si-entry-empty");
    press("0", "0", "4", "2");
    fireEvent.click(screen.getByRole("button", { name: "PIN" }));
    press("4", "8", "2");
    await shot("si-entry-typing");
    cleanup();
    await mount();
    act(() => scan("MRK-000743"));
    await screen.findByText("Бейдж не найден");
    await shot("si-badge-not-found");
    cleanup();
    await mount();
    press("0", "0", "4", "2");
    fireEvent.click(screen.getByRole("button", { name: "PIN" }));
    press("1", "1", "1", "1");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await screen.findByText("Ошибка · PIN очищен");
    await shot("si-wrong-pin");
    cleanup();
  }, 90000);
  it("scanner offline, no copies, notice", async () => {
    await mount({ watchScanners: disconnected });
    await screen.findByText("Бейдж сейчас не прочитать");
    await shot("si-scanner-offline");
    cleanup();
    await mount({ items: [], synced: 0 });
    await screen.findByText(/^Справочники ещё не загружены с хоста\./);
    await shot("si-no-copies");
    cleanup();
    await mount({ notice: "idle" });
    await shot("si-notice-idle");
    cleanup();
  }, 90000);
  it("name search", async () => {
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Найти по имени" }));
    await shot("si-search-empty");
    press("А", "Н");
    await screen.findByRole("button", { name: "Анна Кузнецова — 0042" });
    await shot("si-search-typed");
    cleanup();
  }, 90000);
  it("lockouts and an accepted scan", async () => {
    await mount({ lock: "operator" });
    await screen.findByRole("button", { name: "Найти по имени" });
    press("0", "0", "4", "2");
    fireEvent.click(screen.getByRole("button", { name: "PIN" }));
    press("4", "8", "2", "1");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await screen.findByRole("timer");
    await shot("si-lock-operator");
    cleanup();
    await mount({ lock: "station" });
    await screen.findByRole("button", { name: "Найти по имени" });
    act(() => scan("MRK-000742"));
    await screen.findByRole("timer");
    await shot("si-lock-station");
    cleanup();
    await mount({ successHoldMs: 60_000 });
    await screen.findByRole("button", { name: "Найти по имени" });
    act(() => scan("MRK-000742"));
    await screen.findByTestId("accepted-icon");
    await shot("si-accepted");
    cleanup();
  }, 90000);
});
