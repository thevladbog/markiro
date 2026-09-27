import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NetworkPairing, type NetworkPairingProps } from "../src/app/NetworkPairing.js";
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

function scan(text: string): void {
  type("Код с экрана офиса", text);
  fireEvent.click(screen.getByRole("button", { name: "Подключить" }));
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
