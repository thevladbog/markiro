import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NetworkPairing, type NetworkPairingProps } from "../src/app/NetworkPairing.js";
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import { DeviceError } from "../src/host/device.js";
import { HostProbeError, type HelloObservation, type HostProbe } from "../src/host/probe.js";
import { observation } from "./support/fixtures.js";

const FINGERPRINT = "ab".repeat(32);
const PAYLOAD = `markiro-host:1?h=172.20.0.1,192.168.1.10&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`;
/** `PAYLOAD` typed by a keyboard-wedge scanner while the Russian layout is on. */
const PAYLOAD_IN_RUSSIAN =
  "ьфклшкщ-рщыеЖ1,р=172ю20ю0ю1б192ю168ю1ю10?з=45710?а=" + "фи".repeat(32) + "?с=7Л3ЬЙ9ЧМ2В";

function seen(fingerprint: string): HelloObservation {
  return { ...observation(true), fingerprint };
}

/** Only 192.168.1.10 answers, with the certificate of the payload. */
function lanProbe() {
  return {
    hello: vi.fn<HostProbe["hello"]>(async (address) => {
      if (address !== "https://192.168.1.10:45710") throw new HostProbeError("unreachable", "down");
      return seen(FINGERPRINT);
    }),
  };
}

function renderPairing(overrides: Partial<NetworkPairingProps> = {}) {
  const props: NetworkPairingProps = {
    probe: lanProbe(),
    onClaim: vi.fn<NetworkPairingProps["onClaim"]>(async () => undefined),
    onBack: vi.fn<NetworkPairingProps["onBack"]>(),
    ...overrides,
  };
  render(<NetworkPairing {...props} />);
  return props;
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Types the address and code, confirms, and lets the host refuse the claim. */
async function refuseManual(onClaim: NetworkPairingProps["onClaim"]): Promise<NetworkPairingProps> {
  const props = renderPairing({ onClaim });
  fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
  type("Адрес хоста", "192.168.1.10");
  type("Код подключения", "7K3MQ9XV2D");
  fireEvent.click(screen.getByRole("button", { name: "Далее" }));
  await screen.findByText("Отпечаток хоста https://192.168.1.10:45710");
  fireEvent.click(screen.getByRole("button", { name: "Отпечаток совпадает" }));
  // Waits for the claim's rejection to settle (inside `waitFor`'s own act()
  // wrapping) before returning, so the caller's assertions never race it.
  await waitFor(() => expect(onClaim).toHaveBeenCalledTimes(1));
  return props;
}

function scan(text: string): void {
  type("Код с экрана офиса", text);
  const button = screen.getByRole("button", { name: "Подключить" });
  // jsdom does not move focus on click: focus the button first, as a mouse
  // click would in a real browser, so a regression that leaves focus there
  // after a notice (item D) is actually visible to the assertions below.
  act(() => button.focus());
  fireEvent.click(button);
}

describe("NetworkPairing", () => {
  it("waits for the scanner in a focused field", () => {
    renderPairing();
    expect(document.activeElement).toBe(screen.getByLabelText("Код с экрана офиса"));
  });

  it("returns focus to the scan field after visiting the manual form and back", () => {
    renderPairing();
    const manualButton = screen.getByRole("button", { name: "Ввести адрес и код вручную" });
    // jsdom's fireEvent.click alone does not move focus: without it, this
    // test would pass even if the scan field never got focus back. The
    // native focus() call is wrapped in act() because it blurs the
    // previously-focused Input outside fireEvent's own act() batching.
    act(() => manualButton.focus());
    fireEvent.click(manualButton);
    const scanInsteadButton = screen.getByRole("button", { name: "Отсканировать код" });
    act(() => scanInsteadButton.focus());
    fireEvent.click(scanInsteadButton);
    expect(document.activeElement).toBe(screen.getByLabelText("Код с экрана офиса"));
  });

  it("moves focus to the fingerprint block after confirming the manual form, never to the confirm button", async () => {
    renderPairing();
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    type("Адрес хоста", "192.168.1.10");
    type("Код подключения", "7K3MQ9XV2D");
    const nextButton = screen.getByRole("button", { name: "Далее" });
    // jsdom does not move focus on click: focus "Далее" first, so leaving
    // focus there (or dropping it to <body>) would actually show up below.
    act(() => nextButton.focus());
    fireEvent.click(nextButton);
    await screen.findByText("Отпечаток хоста https://192.168.1.10:45710");
    const fingerprintBlock = screen
      .getByText(
        "Сверьте отпечаток ниже с отпечатком хоста на экране офиса. Код уйдёт на хост, только если они совпадают.",
      )
      .closest('[tabindex="-1"]');
    expect(fingerprintBlock).toBeTruthy();
    expect(document.activeElement).toBe(fingerprintBlock);
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: "Отпечаток совпадает" }),
    );
    expect(document.activeElement).not.toBe(document.body);
  });

  it("pairs with a scanned code: every address at once, the code's certificate, no question", async () => {
    const props = renderPairing();
    scan(PAYLOAD);
    await waitFor(() =>
      expect(props.onClaim).toHaveBeenCalledWith({
        address: "https://192.168.1.10:45710",
        fingerprint: FINGERPRINT,
        code: "7K3MQ9XV2D",
        name: "Станция",
      }),
    );
    expect(props.probe.hello).toHaveBeenCalledWith("https://172.20.0.1:45710");
    expect(props.probe.hello).toHaveBeenCalledWith("https://192.168.1.10:45710");
    expect(screen.getByLabelText("Код с экрана офиса")).toHaveProperty("value", "");
  });

  it("reads a code the scanner typed under the Russian layout", async () => {
    const props = renderPairing();
    type("Имя устройства", "  Станция на линии 2 ");
    scan(PAYLOAD_IN_RUSSIAN);
    await waitFor(() =>
      expect(props.onClaim).toHaveBeenCalledWith({
        address: "https://192.168.1.10:45710",
        fingerprint: FINGERPRINT,
        code: "7K3MQ9XV2D",
        name: "Станция на линии 2",
      }),
    );
  });

  it("explains a scan that is not a pairing code, without probing", async () => {
    const props = renderPairing();
    scan("4600682000013");
    expect(
      await screen.findByText("Это не код подключения Markiro. Отсканируйте код с экрана офиса."),
    ).toBeTruthy();
    expect(props.probe.hello).not.toHaveBeenCalled();
    // Focus returns to the scan field, not left on the disabled-while-busy
    // "Подключить" button, so the next scanner input is not lost.
    expect(document.activeElement).toBe(screen.getByLabelText("Код с экрана офиса"));
  });

  it("warns when the code carries no host address", async () => {
    const props = renderPairing();
    scan(PAYLOAD.replace("172.20.0.1,192.168.1.10", ""));
    expect(
      await screen.findByText(
        "В коде нет адреса хоста: у ПК-хоста нет адреса в локальной сети. Проверьте его сеть или введите адрес вручную.",
      ),
    ).toBeTruthy();
    expect(props.probe.hello).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText("Код с экрана офиса"));
  });

  it("names the addresses when none answers with the code's certificate", async () => {
    const probe = {
      hello: vi.fn<HostProbe["hello"]>(async () => {
        throw new HostProbeError("unreachable", "down");
      }),
    };
    const props = renderPairing({ probe });
    scan(PAYLOAD);
    expect(
      await screen.findByText(
        "Хост из кода не отвечает ни по одному адресу (172.20.0.1, 192.168.1.10). Проверьте, что ПК-хост включён и в той же сети.",
      ),
    ).toBeTruthy();
    expect(props.onClaim).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText("Код с экрана офиса"));
  });

  it("keeps the code from a host with another certificate", async () => {
    const probe = { hello: vi.fn<HostProbe["hello"]>(async () => seen("cd".repeat(32))) };
    const props = renderPairing({ probe });
    scan(PAYLOAD);
    expect(
      await screen.findByText(
        "По адресу из кода отвечает другой хост: отпечаток не совпадает. Код не отправлен.",
      ),
    ).toBeTruthy();
    expect(props.onClaim).not.toHaveBeenCalled();
  });

  it("shows the version-mismatch text when the scan search finds an old host", async () => {
    const probe = {
      hello: vi.fn<HostProbe["hello"]>(async () => {
        throw new HostProbeError("host_too_old", "old host");
      }),
    };
    const props = renderPairing({ probe });
    scan(PAYLOAD);
    expect(
      await screen.findByText("Служба «Markiro Хост» старее этого приложения. Обновите службу."),
    ).toBeTruthy();
    expect(props.onClaim).not.toHaveBeenCalled();
  });

  it("explains a refused code and never sends it again on its own", async () => {
    const onClaim = vi.fn<NetworkPairingProps["onClaim"]>(async () => {
      throw new DeviceError("pairing_code_invalid", "refused");
    });
    renderPairing({ onClaim });
    scan(PAYLOAD);
    expect(
      await screen.findByText(
        "Код подключения неверен или больше не действует. Получите новый код в офисе.",
      ),
    ).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onClaim).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByLabelText("Код с экрана офиса"));
  });

  it("does not probe or claim again with a code the host already refused on this screen (scan path)", async () => {
    const onClaim = vi.fn<NetworkPairingProps["onClaim"]>(async () => {
      throw new DeviceError("pairing_code_invalid", "refused");
    });
    const props = renderPairing({ onClaim });
    scan(PAYLOAD);
    await screen.findByText(
      "Код подключения неверен или больше не действует. Получите новый код в офисе.",
    );
    // Both addresses were probed once each for this first, genuine attempt.
    expect(props.probe.hello).toHaveBeenCalledTimes(2);
    expect(onClaim).toHaveBeenCalledTimes(1);

    // The very same payload, scanned again: the code is remembered as
    // refused, so it must not spend another of the host's five attempts.
    scan(PAYLOAD);
    expect(
      await screen.findByText(
        "Код подключения неверен или больше не действует. Получите новый код в офисе.",
      ),
    ).toBeTruthy();
    expect(props.probe.hello).toHaveBeenCalledTimes(2);
    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  it.each(["invalid_response", "host_changed", "storage"] as const)(
    "asks for a new code when the host may already have taken this one (%s)",
    async (code) => {
      const onClaim = vi.fn<NetworkPairingProps["onClaim"]>(async () => {
        throw new DeviceError(code, "could not save the pairing");
      });
      renderPairing({ onClaim });
      scan(PAYLOAD);
      expect(
        await screen.findByText(
          "Подключение не завершилось, а хост мог уже принять код. Получите в офисе новый код и подключитесь снова.",
        ),
      ).toBeTruthy();
      expect(onClaim).toHaveBeenCalledTimes(1);
    },
  );

  it("asks for a device name before anything reaches the network", async () => {
    const props = renderPairing();
    type("Имя устройства", "   ");
    scan(PAYLOAD);
    expect(await screen.findByText("Укажите имя, до 100 символов")).toBeTruthy();
    expect(props.probe.hello).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["over 100 characters", "с".repeat(101)],
  ])("keeps the length message for a device name that is %s", async (_what, name) => {
    const props = renderPairing();
    type("Имя устройства", name);
    scan(PAYLOAD);
    expect(await screen.findByText("Укажите имя, до 100 символов")).toBeTruthy();
    expect(props.probe.hello).not.toHaveBeenCalled();
    expect(props.onClaim).not.toHaveBeenCalled();
  });

  it.each([
    ["a tab inside it", "Станция\t2"],
    ["an unpaired surrogate", "Станция\ud800"],
  ])("names %s in a device name in its own words, not as a wrong length", async (_what, name) => {
    const props = renderPairing();
    type("Имя устройства", name);
    scan(PAYLOAD);
    expect(
      await screen.findByText("Уберите табуляцию, перенос строки или другой служебный символ"),
    ).toBeTruthy();
    expect(screen.queryByText("Укажите имя, до 100 символов")).toBeNull();
    expect(props.probe.hello).not.toHaveBeenCalled();
    expect(props.onClaim).not.toHaveBeenCalled();
  });

  it("says the same on the manual form, where the name is checked too", async () => {
    const props = renderPairing();
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    type("Имя устройства", "Станция\t2");
    type("Адрес хоста", "192.168.1.10");
    type("Код подключения", "7K3MQ9XV2D");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(
      await screen.findByText("Уберите табуляцию, перенос строки или другой служебный символ"),
    ).toBeTruthy();
    expect(screen.queryByText("Укажите имя, до 100 символов")).toBeNull();
    expect(props.probe.hello).not.toHaveBeenCalled();
  });

  it("pairs by hand after a person confirms the host's fingerprint", async () => {
    const props = renderPairing();
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    type("Адрес хоста", "192.168.1.10");
    type("Код подключения", "7k3mq-9xv2d");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("Отпечаток хоста https://192.168.1.10:45710")).toBeTruthy();
    expect(screen.getByText("ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB")).toBeTruthy();
    expect(props.onClaim).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Отпечаток совпадает" }));
    await waitFor(() =>
      expect(props.onClaim).toHaveBeenCalledWith({
        address: "https://192.168.1.10:45710",
        fingerprint: FINGERPRINT,
        code: "7K3MQ9XV2D",
        name: "Станция",
      }),
    );
  });

  it("returns to the manual form with the refusal after a confirmed claim fails", async () => {
    const onClaim = vi.fn<NetworkPairingProps["onClaim"]>(async () => {
      throw new DeviceError("pairing_code_invalid", "refused");
    });
    renderPairing({ onClaim });
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    type("Адрес хоста", "192.168.1.10");
    type("Код подключения", "7K3MQ9XV2D");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("Отпечаток хоста https://192.168.1.10:45710");
    fireEvent.click(screen.getByRole("button", { name: "Отпечаток совпадает" }));
    expect(
      await screen.findByText(
        "Код подключения неверен или больше не действует. Получите новый код в офисе.",
      ),
    ).toBeTruthy();
    // Back on the manual form, not stuck on the confirmation screen, and the
    // typed address is still there.
    expect(screen.getByLabelText("Адрес хоста")).toHaveProperty("value", "192.168.1.10");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  it("does not probe or claim again with a code the host already refused on this screen (manual path)", async () => {
    const onClaim = vi.fn<NetworkPairingProps["onClaim"]>(async () => {
      throw new DeviceError("pairing_code_invalid", "refused");
    });
    const props = renderPairing({ onClaim });
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    type("Адрес хоста", "192.168.1.10");
    type("Код подключения", "7K3MQ9XV2D");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("Отпечаток хоста https://192.168.1.10:45710");
    fireEvent.click(screen.getByRole("button", { name: "Отпечаток совпадает" }));
    await screen.findByText(
      "Код подключения неверен или больше не действует. Получите новый код в офисе.",
    );
    expect(props.probe.hello).toHaveBeenCalledTimes(1);
    expect(onClaim).toHaveBeenCalledTimes(1);

    // Back on the manual form with the same refused code still in the field
    // (item H says it stays); submitting again must not probe or claim again.
    expect(screen.getByLabelText("Код подключения")).toHaveProperty("value", "7K3MQ9XV2D");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(
      await screen.findByText(
        "Код подключения неверен или больше не действует. Получите новый код в офисе.",
      ),
    ).toBeTruthy();
    expect(props.probe.hello).toHaveBeenCalledTimes(1);
    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "pairing_code_invalid",
      "Код подключения неверен или больше не действует. Получите новый код в офисе.",
    ],
    ["pairing_code_expired", "Срок кода подключения истёк. Получите новый код в офисе."],
    [
      "invalid_response",
      "Подключение не завершилось, а хост мог уже принять код. Получите в офисе новый код и подключитесь снова.",
    ],
    [
      "host_changed",
      "Подключение не завершилось, а хост мог уже принять код. Получите в офисе новый код и подключитесь снова.",
    ],
    [
      "storage",
      "Подключение не завершилось, а хост мог уже принять код. Получите в офисе новый код и подключитесь снова.",
    ],
  ] as const)(
    "remembers a %s refusal: a second submit of the same code neither probes nor claims again",
    async (code, text) => {
      const onClaim = vi.fn<NetworkPairingProps["onClaim"]>(async () => {
        throw new DeviceError(code, "refused");
      });
      const props = await refuseManual(onClaim);
      await screen.findByText(text);
      expect(props.probe.hello).toHaveBeenCalledTimes(1);
      expect(onClaim).toHaveBeenCalledTimes(1);

      // Same code still in the field; submitting again must not reach the
      // network at all — a wrong code counts against every live code.
      fireEvent.click(screen.getByRole("button", { name: "Далее" }));
      expect(await screen.findByText(text)).toBeTruthy();
      expect(props.probe.hello).toHaveBeenCalledTimes(1);
      expect(onClaim).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["rate_limited", "Слишком много попыток подключения. Подождите минуту и попробуйте снова."],
    ["unreachable", "Хост не отвечает по этому адресу. Проверьте адрес и что ПК-хост включён."],
  ] as const)(
    "does not remember a %s refusal: a second submit of the same code probes and claims again",
    async (code, text) => {
      const onClaim = vi.fn<NetworkPairingProps["onClaim"]>(async () => {
        throw new DeviceError(code, "refused");
      });
      const props = await refuseManual(onClaim);
      await screen.findByText(text);
      expect(props.probe.hello).toHaveBeenCalledTimes(1);
      expect(onClaim).toHaveBeenCalledTimes(1);

      // Neither code judges the code itself (a rate limit, or a transport
      // failure that never reached the host): the same code must still be
      // usable, so submitting again goes through the full flow again.
      fireEvent.click(screen.getByRole("button", { name: "Далее" }));
      await screen.findByText("Отпечаток хоста https://192.168.1.10:45710");
      fireEvent.click(screen.getByRole("button", { name: "Отпечаток совпадает" }));
      expect(await screen.findByText(text)).toBeTruthy();
      expect(props.probe.hello).toHaveBeenCalledTimes(2);
      expect(onClaim).toHaveBeenCalledTimes(2);
    },
  );

  it("goes back without the code when the fingerprint differs", async () => {
    const props = renderPairing();
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    type("Адрес хоста", "192.168.1.10");
    type("Код подключения", "7K3MQ9XV2D");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    fireEvent.click(await screen.findByRole("button", { name: "Не совпадает" }));
    expect(
      await screen.findByText("Отпечаток не совпал, код не отправлен. Проверьте адрес хоста."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Адрес хоста")).toHaveProperty("value", "192.168.1.10");
    expect(props.onClaim).not.toHaveBeenCalled();
  });

  it("checks the typed code and address before asking the host anything", async () => {
    const props = renderPairing();
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    type("Адрес хоста", "https://192.168.1.10");
    type("Код подключения", "12345");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("Проверьте код: 10 символов")).toBeTruthy();
    expect(screen.getByText("Укажите адрес: 192.168.1.10 или 192.168.1.10:45710")).toBeTruthy();
    expect(props.probe.hello).not.toHaveBeenCalled();
  });

  it("asks to switch the layout for a code typed in Russian letters", async () => {
    const props = renderPairing();
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    // The keypad's decimal key types a comma under the Russian layout.
    type("Адрес хоста", "192,168,1,10");
    // «7k3mq-9xv2d» typed on the same keys under the Russian layout.
    type("Код подключения", "7л3ьй-9чм2в");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(
      await screen.findByText("Код набран русскими буквами — переключите раскладку на английскую"),
    ).toBeTruthy();
    expect(screen.queryByText("Проверьте код: 10 символов")).toBeNull();
    expect(screen.queryByText("Укажите адрес: 192.168.1.10 или 192.168.1.10:45710")).toBeNull();
    expect(props.probe.hello).not.toHaveBeenCalled();
  });

  it("explains a host that does not answer in network words", async () => {
    renderPairing();
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    type("Адрес хоста", "192.168.1.20");
    type("Код подключения", "7K3MQ9XV2D");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(
      await screen.findByText(
        "Хост не отвечает по этому адресу. Проверьте адрес и что ПК-хост включён.",
      ),
    ).toBeTruthy();
  });

  it("names a non-Markiro host in network words on the manual path", async () => {
    const probe = {
      hello: vi.fn<HostProbe["hello"]>(async () => {
        throw new HostProbeError("not_markiro_host", "wrong service");
      }),
    };
    renderPairing({ probe });
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    type("Адрес хоста", "192.168.1.10");
    type("Код подключения", "7K3MQ9XV2D");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("По этому адресу отвечает не служба Markiro.")).toBeTruthy();
  });

  it("goes back", () => {
    const props = renderPairing();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });
});

/** A COM scanner as the shell delivers it: `emit` hands one frame to every listener. */
function comScanner() {
  const listeners = new Set<ScanListener>();
  const source: ScanSource = {
    start: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clearPendingInput: () => undefined,
    setManualTextEntryActive: () => undefined,
  };
  return {
    source,
    listening: () => listeners.size,
    emit: (raw: string) => {
      act(() => {
        for (const listener of [...listeners]) listener(raw);
      });
    },
  };
}

describe("NetworkPairing on a station before pairing (owner feedback, first Windows test)", () => {
  it("pairs with a code a COM scanner sent, though no field took it", async () => {
    const com = comScanner();
    const props = renderPairing({ comScans: com.source });
    com.emit(PAYLOAD);
    await waitFor(() =>
      expect(props.onClaim).toHaveBeenCalledWith({
        address: "https://192.168.1.10:45710",
        fingerprint: FINGERPRINT,
        code: "7K3MQ9XV2D",
        name: "Станция",
      }),
    );
  });

  it("explains a COM scan that is not a pairing code, as a typed one", async () => {
    const com = comScanner();
    const props = renderPairing({ comScans: com.source });
    com.emit("4600682000013");
    expect(
      await screen.findByText("Это не код подключения Markiro. Отсканируйте код с экрана офиса."),
    ).toBeTruthy();
    expect(props.probe.hello).not.toHaveBeenCalled();
  });

  it("drops a COM scan while the manual form or the fingerprint check is on screen", async () => {
    const com = comScanner();
    const props = renderPairing({ comScans: com.source });
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    com.emit(PAYLOAD);
    type("Адрес хоста", "192.168.1.10");
    type("Код подключения", "7K3MQ9XV2D");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("Отпечаток хоста https://192.168.1.10:45710");
    com.emit(PAYLOAD);
    // Only the manual form's own probe: the scans went nowhere.
    expect(props.probe.hello).toHaveBeenCalledTimes(1);
    expect(props.onClaim).not.toHaveBeenCalled();
  });

  it("stops listening to the COM scanner when the screen goes", () => {
    const com = comScanner();
    renderPairing({ comScans: com.source });
    expect(com.listening()).toBe(1);
    cleanup();
    expect(com.listening()).toBe(0);
  });

  it("opens the scanner settings from the scan form, with a 64 px button, and keeps the typed code", () => {
    const onScannerSetup = vi.fn();
    renderPairing({ onScannerSetup });
    const button = screen.getByRole("button", { name: "Настройки сканера" });
    expect(button.style.height).toBe("var(--control-floor)");
    fireEvent.click(button);
    expect(onScannerSetup).toHaveBeenCalledTimes(1);
    // Typing the code stays open next to it.
    expect(screen.getByRole("button", { name: "Ввести адрес и код вручную" })).toBeTruthy();
  });

  it("makes every button of the screen a 64 px floor control", () => {
    renderPairing({ onScannerSetup: vi.fn() });
    for (const button of screen.getAllByRole("button")) {
      expect(button.style.height, button.textContent ?? "").toBe("var(--control-floor)");
    }
    fireEvent.click(screen.getByRole("button", { name: "Ввести адрес и код вручную" }));
    for (const button of screen.getAllByRole("button")) {
      expect(button.style.height, button.textContent ?? "").toBe("var(--control-floor)");
    }
  });

  it("offers no scanner settings where the app gives none", () => {
    renderPairing();
    expect(screen.queryByRole("button", { name: "Настройки сканера" })).toBeNull();
  });
});
