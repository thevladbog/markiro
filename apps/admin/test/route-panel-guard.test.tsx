import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { createMemoryRouter, Route, RouterProvider, Routes, useNavigate } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { useRoutePanelGuard } from "../src/lib/useRoutePanelGuard.js";

function GuardHarness({ busy = false }: { busy?: boolean }) {
  const navigate = useNavigate();
  const guard = useRoutePanelGuard(() => void navigate(-1), busy);
  const [value, setValue] = useState("");

  return (
    <div>
      <label>
        Name
        <input
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            guard.setDirty(true);
          }}
        />
      </label>
      <button type="button" onClick={guard.requestClose}>
        Close
      </button>
      <button type="button" onClick={guard.finish}>
        Finish
      </button>
      {guard.confirmOpen ? (
        <div role="alertdialog" aria-label="Discard changes">
          <button type="button" onClick={guard.cancelDiscard}>
            Continue editing
          </button>
          <button type="button" onClick={guard.confirmDiscard}>
            Discard
          </button>
        </div>
      ) : null}
    </div>
  );
}

function renderGuard(options: { busy?: boolean; initialEntries?: string[] } = {}) {
  const initialEntries = options.initialEntries ?? ["/list", "/list/new"];
  const router = createMemoryRouter(
    [
      { path: "/list", element: <p>List</p> },
      {
        path: "/list/new",
        element: (
          <Routes>
            <Route index element={<GuardHarness busy={options.busy ?? false} />} />
          </Routes>
        ),
      },
    ],
    { initialEntries, initialIndex: initialEntries.length - 1 },
  );
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup() };
}

afterEach(cleanup);

describe("useRoutePanelGuard", () => {
  it("closes a clean panel immediately", async () => {
    const { router, user } = renderGuard();

    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/list"));
  });

  it("keeps dirty input when dismissal is cancelled and closes after discard", async () => {
    const { router, user } = renderGuard();

    await user.type(screen.getByLabelText("Name"), "Milk");
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.getByRole("alertdialog", { name: "Discard changes" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Continue editing" }));
    expect(router.state.location.pathname).toBe("/list/new");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Milk");

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/list"));
  });

  it("blocks Back until dirty changes are discarded", async () => {
    const { router, user } = renderGuard();

    await user.type(screen.getByLabelText("Name"), "Milk");
    await router.navigate(-1);

    expect(router.state.location.pathname).toBe("/list/new");
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/list"));
  });

  it("resets Back and ignores explicit dismissal while busy, but finish can close", async () => {
    const { router, user } = renderGuard({ busy: true });

    await router.navigate(-1);
    expect(router.state.location.pathname).toBe("/list/new");
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(router.state.location.pathname).toBe("/list/new");

    await user.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/list"));
  });
});
