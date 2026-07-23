import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import i18n from "../src/i18n/index.js";
import { Enrollment } from "../src/pages/Enrollment.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  invokeMock.mockReset();
});

describe("Enrollment", () => {
  it("validates, persists config, and calls onEnrolled on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    invokeMock.mockResolvedValue(undefined); // write_config
    const onEnrolled = vi.fn();

    render(<Enrollment machineId="m1" onEnrolled={onEnrolled} />);
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "http://localhost:3000" },
    });
    fireEvent.change(screen.getByLabelText("Device key"), { target: { value: "mk_key" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(onEnrolled).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith("write_config", expect.anything());
  });

  it("shows an error and does not persist on a failed probe", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    const onEnrolled = vi.fn();

    render(<Enrollment machineId="m1" onEnrolled={onEnrolled} />);
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "http://localhost:3000" },
    });
    fireEvent.change(screen.getByLabelText("Device key"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(screen.getByText("Could not connect. Check the URL and key.")).toBeDefined(),
    );
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("write_config", expect.anything());
  });
});
