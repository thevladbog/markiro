import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MonoBitmap } from "@markiro/domain";

import { loadBundledMarkiroLogo, logoToWire } from "../src/labels/logo.js";
import { createOfficeQueryClient, officeKeys } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { useLabelLogo } from "../src/office/use-label-logo.js";
import { fakeOfficeSession, type FakeOfficeSession } from "./support/office.js";

import type * as LogoModule from "../src/labels/logo.js";

vi.mock("../src/labels/logo.js", async (importActual) => {
  const actual = await importActual<typeof LogoModule>();
  return { ...actual, loadBundledMarkiroLogo: vi.fn() };
});

const MARKIRO: MonoBitmap = {
  width: 8,
  height: 2,
  stride: 1,
  pixels: new Uint8Array([0xf0, 0x0f]),
};
const OWN: MonoBitmap = { width: 16, height: 1, stride: 2, pixels: new Uint8Array([0xaa, 0x55]) };

/** A bitmap as the probe shows it: its size and rows, or `none`. */
function describeLogo(logo: MonoBitmap | null): string {
  return logo === null ? "none" : `${logo.width}x${logo.height}:${[...logo.pixels].join(",")}`;
}

function Probe() {
  return <output aria-label="logo">{describeLogo(useLabelLogo())}</output>;
}

function session(
  state: ReturnType<typeof logoToWire> | null | "failed" | "pending",
): FakeOfficeSession {
  const fake = fakeOfficeSession();
  if (state === "failed") fake.api.getOrgLogo.mockRejectedValue(new Error("host down"));
  else if (state === "pending") fake.api.getOrgLogo.mockReturnValue(new Promise(() => undefined));
  else {
    fake.api.getOrgLogo.mockResolvedValue({
      logo: state === null ? null : { ...state, updatedAt: "2026-10-11T09:00:00Z" },
    });
  }
  return fake;
}

function mount(fake: FakeOfficeSession, client = createOfficeQueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <OfficeSessionProvider value={fake}>
        <Probe />
      </OfficeSessionProvider>
    </QueryClientProvider>,
  );
}

const shown = () => screen.getByLabelText("logo").textContent;

beforeEach(() => {
  vi.mocked(loadBundledMarkiroLogo).mockReset().mockResolvedValue(MARKIRO);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the logo a label's logo box shows in the office", () => {
  it("is none while the organization's logo is being read, and loads no Markiro logo yet", async () => {
    mount(session("pending"));
    await act(async () => undefined);
    expect(shown()).toBe("none");
    expect(loadBundledMarkiroLogo).not.toHaveBeenCalled();
  });

  it("is the organization's own logo, bit for bit, and never loads the Markiro one", async () => {
    const fake = session(logoToWire(OWN));
    mount(fake);
    await waitFor(() => expect(shown()).toBe(describeLogo(OWN)));
    expect(loadBundledMarkiroLogo).not.toHaveBeenCalled();
    expect(fake.api.getOrgLogo).toHaveBeenCalledTimes(1);
  });

  it("is the Markiro logo when the organization has none, once it is loaded", async () => {
    let load: (bitmap: MonoBitmap) => void = () => undefined;
    vi.mocked(loadBundledMarkiroLogo).mockReturnValue(
      new Promise<MonoBitmap>((resolve) => {
        load = resolve;
      }),
    );
    mount(session(null));
    await waitFor(() => expect(loadBundledMarkiroLogo).toHaveBeenCalledTimes(1));
    expect(shown()).toBe("none");
    await act(async () => {
      load(MARKIRO);
    });
    expect(shown()).toBe(describeLogo(MARKIRO));
  });

  it("is the Markiro logo when the stored logo is one this build cannot read", async () => {
    // Not canonical base64: the wire reading refuses it, and so does a shift's snapshot.
    const unreadable = { width: 16, height: 1, pixelsBase64: "qlU" };
    mount(session(unreadable));
    await waitFor(() => expect(shown()).toBe(describeLogo(MARKIRO)));
  });

  it("stays none, without a failure, when the Markiro logo cannot be loaded", async () => {
    vi.mocked(loadBundledMarkiroLogo).mockRejectedValue(new Error("canvas unavailable"));
    mount(session(null));
    await waitFor(() => expect(loadBundledMarkiroLogo).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(shown()).toBe("none");
  });

  it("is none, and asks nothing of the Markiro logo, when the logo could not be read from the host", async () => {
    const fake = session("failed");
    mount(fake);
    await waitFor(() => expect(fake.api.getOrgLogo).toHaveBeenCalled());
    await act(async () => undefined);
    expect(shown()).toBe("none");
    expect(loadBundledMarkiroLogo).not.toHaveBeenCalled();
  });

  it("is none again while the organization's logo is being read anew, not the Markiro one of before", async () => {
    const fake = session(null);
    const client = createOfficeQueryClient();
    mount(fake, client);
    await waitFor(() => expect(shown()).toBe(describeLogo(MARKIRO)));
    fake.api.getOrgLogo.mockReturnValue(new Promise(() => undefined));
    // The new read never answers: not awaited.
    await act(async () => {
      void client.resetQueries({ queryKey: officeKeys.orgLogo });
    });
    await waitFor(() => expect(shown()).toBe("none"));
  });

  it("takes no part once gone: a Markiro logo that arrives after the unmount sets nothing", async () => {
    let load: (bitmap: MonoBitmap) => void = () => undefined;
    vi.mocked(loadBundledMarkiroLogo).mockReturnValue(
      new Promise<MonoBitmap>((resolve) => {
        load = resolve;
      }),
    );
    const { unmount } = mount(session(null));
    await waitFor(() => expect(loadBundledMarkiroLogo).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      load(MARKIRO);
    });
    expect(screen.queryByLabelText("logo")).toBeNull();
  });
});
