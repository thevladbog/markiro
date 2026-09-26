import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App } from "../src/app/App.js";
import { HostProbeError, type HelloObservation, type HostProbe } from "../src/host/probe.js";

const OBSERVATION: HelloObservation = {
  hello: {
    product: "markiro-host",
    protocol: 1,
    minProtocol: 1,
    hostId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    version: "0.1.0",
    time: "2026-09-26T09:15:00Z",
    initialized: false,
  },
  fingerprint: "ab".repeat(32),
};

describe("App shell", () => {
  it("explains a missing host and finds it after a retry", async () => {
    const hello = vi
      .fn<HostProbe["hello"]>()
      .mockRejectedValueOnce(new HostProbeError("unreachable", "down"))
      .mockResolvedValueOnce(OBSERVATION);
    render(<App probe={{ hello }} address="https://127.0.0.1:45710" />);

    expect(await screen.findByText("Служба хоста не отвечает")).toBeTruthy();
    expect(screen.getByText("Нет соединения.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));

    expect(await screen.findByText("Служба хоста найдена")).toBeTruthy();
    expect(screen.getByTestId("host-fingerprint").textContent).toBe(
      "ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB",
    );
    expect(screen.getByText(/Хост ещё не настроен/)).toBeTruthy();
    expect(hello).toHaveBeenCalledTimes(2);
    expect(hello).toHaveBeenCalledWith("https://127.0.0.1:45710");
  });

  it("names a foreign service instead of a missing one", async () => {
    const hello = vi
      .fn<HostProbe["hello"]>()
      .mockRejectedValue(new HostProbeError("not_markiro_host", "foreign"));
    render(<App probe={{ hello }} />);
    expect(await screen.findByText("По этому адресу отвечает не служба Markiro.")).toBeTruthy();
  });

  it("explains a version mismatch instead of a missing host", async () => {
    const hello = vi
      .fn<HostProbe["hello"]>()
      .mockRejectedValue(new HostProbeError("app_too_old", "old"));
    render(<App probe={{ hello }} />);
    expect(await screen.findByText("Версии не совпадают")).toBeTruthy();
    expect(
      screen.getByText("Это приложение старее службы «Markiro Хост». Обновите приложение."),
    ).toBeTruthy();
  });
});
