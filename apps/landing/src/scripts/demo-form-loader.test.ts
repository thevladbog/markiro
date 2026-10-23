// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEMO_FORM_ROOT_MARGIN,
  loadDemoFormWhenNeeded,
  type DemoFormInit,
  type DemoFormLoaderEnvironment,
} from "./demo-form-loader";

type Entries = Array<{ isIntersecting: boolean }>;

/** An IntersectionObserver stand-in whose callback the test fires by hand. */
function fakeObserver() {
  const state = {
    callback: undefined as ((entries: Entries) => void) | undefined,
    observed: [] as Element[],
    options: undefined as { rootMargin: string } | undefined,
    disconnects: 0,
  };
  class Observer {
    constructor(callback: (entries: Entries) => void, options: { rootMargin: string }) {
      state.callback = callback;
      state.options = options;
    }
    observe(element: Element): void {
      state.observed.push(element);
    }
    disconnect(): void {
      state.disconnects += 1;
    }
  }
  const environment: DemoFormLoaderEnvironment = { IntersectionObserver: Observer };
  return { state, environment, fire: (entries: Entries) => state.callback?.(entries) };
}

function renderForm(): HTMLFormElement {
  document.body.innerHTML = `
    <form data-demo-form>
      <input name="name" />
      <button type="submit">Send</button>
    </form>`;
  const form = document.querySelector<HTMLFormElement>("form");
  if (form === null) throw new Error("no form");
  return form;
}

/** A loader whose promise the test resolves; `init` records the form it wired. */
function deferredLoader() {
  const init = vi.fn<DemoFormInit>();
  let resolve: (value: DemoFormInit) => void = () => undefined;
  const load = vi.fn(
    () =>
      new Promise<DemoFormInit>((done) => {
        resolve = done;
      }),
  );
  return { init, load, finish: () => resolve(init) };
}

async function flush(): Promise<void> {
  await new Promise((done) => setTimeout(done, 0));
}

function submit(form: HTMLFormElement): Event {
  const event = new Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("loadDemoFormWhenNeeded", () => {
  it("does not load the form script before the form nears the viewport", () => {
    const form = renderForm();
    const { state, environment, fire } = fakeObserver();
    const { load } = deferredLoader();

    loadDemoFormWhenNeeded(form, environment, load);
    fire([{ isIntersecting: false }]);

    expect(load).not.toHaveBeenCalled();
    expect(state.observed).toEqual([form]);
    expect(state.options).toEqual({ rootMargin: DEMO_FORM_ROOT_MARGIN });
  });

  it("loads once on intersection, wires the form and stops observing", async () => {
    const form = renderForm();
    const { state, environment, fire } = fakeObserver();
    const { init, load, finish } = deferredLoader();

    loadDemoFormWhenNeeded(form, environment, load);
    fire([{ isIntersecting: true }]);
    fire([{ isIntersecting: true }]);
    finish();
    await flush();

    expect(load).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledExactlyOnceWith(form);
    expect(state.disconnects).toBe(1);
  });

  it.each(["focusin", "pointerdown"])(
    "loads exactly once when the visitor starts with %s before the form is near",
    async (type) => {
      const form = renderForm();
      const { environment, fire } = fakeObserver();
      const { init, load, finish } = deferredLoader();

      loadDemoFormWhenNeeded(form, environment, load);
      form.querySelector("input")?.dispatchEvent(new Event(type, { bubbles: true }));
      form.dispatchEvent(new Event("focusin", { bubbles: true }));
      form.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      fire([{ isIntersecting: true }]);
      finish();
      await flush();

      expect(load).toHaveBeenCalledTimes(1);
      expect(init).toHaveBeenCalledExactlyOnceWith(form);
    },
  );

  it("holds an early submit and replays it once the form is wired", async () => {
    const form = renderForm();
    const { environment } = fakeObserver();
    const { init, load, finish } = deferredLoader();
    const requestSubmit = vi.spyOn(form, "requestSubmit").mockImplementation(() => undefined);
    const laterListener = vi.fn();
    form.addEventListener("submit", laterListener);

    loadDemoFormWhenNeeded(form, environment, load);
    const early = submit(form);

    expect(early.defaultPrevented).toBe(true);
    expect(laterListener).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(requestSubmit).not.toHaveBeenCalled();

    finish();
    await flush();

    expect(init).toHaveBeenCalledExactlyOnceWith(form);
    expect(requestSubmit).toHaveBeenCalledTimes(1);

    const next = submit(form);
    expect(next.defaultPrevented).toBe(false);
    expect(laterListener).toHaveBeenCalledTimes(1);
  });

  it("does not replay a submit when none was held", async () => {
    const form = renderForm();
    const { environment, fire } = fakeObserver();
    const { load, finish } = deferredLoader();
    const requestSubmit = vi.spyOn(form, "requestSubmit").mockImplementation(() => undefined);

    loadDemoFormWhenNeeded(form, environment, load);
    fire([{ isIntersecting: true }]);
    finish();
    await flush();

    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it("loads at once without IntersectionObserver", async () => {
    const form = renderForm();
    const { init, load, finish } = deferredLoader();

    loadDemoFormWhenNeeded(form, {}, load);
    expect(load).toHaveBeenCalledTimes(1);
    finish();
    await flush();

    expect(init).toHaveBeenCalledExactlyOnceWith(form);
  });
});
