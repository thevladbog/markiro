/**
 * The call form sits at the bottom of the home pages. Its script chain (form
 * runtime plus consent) used to load with the page and pushed the mobile
 * Lighthouse score under the gate, so it is fetched only when the visitor gets
 * near the form or starts using it. A submit that arrives before the script is
 * held and replayed once the form is wired.
 */

/** How far below the fold the form may be before its script starts loading. */
export const DEMO_FORM_ROOT_MARGIN = "800px 0px";

type ObserverConstructor = new (
  callback: (entries: Array<{ isIntersecting: boolean }>) => void,
  options: { rootMargin: string },
) => { observe(element: Element): void; disconnect(): void };

export interface DemoFormLoaderEnvironment {
  readonly IntersectionObserver?: ObserverConstructor;
}

export type DemoFormInit = (form: HTMLFormElement) => void;

export function loadDemoFormWhenNeeded(
  form: HTMLFormElement,
  environment: DemoFormLoaderEnvironment,
  load: () => Promise<DemoFormInit>,
): void {
  let requested = false;
  let ready = false;
  let pendingSubmit = false;
  let disconnect: () => void = () => undefined;

  const holdSubmit = (event: Event): void => {
    if (ready) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pendingSubmit = true;
    request();
  };

  const request = (): void => {
    if (requested) return;
    requested = true;
    disconnect();
    form.removeEventListener("focusin", request);
    form.removeEventListener("pointerdown", request);
    void load().then((init) => {
      init(form);
      ready = true;
      form.removeEventListener("submit", holdSubmit, true);
      if (pendingSubmit) form.requestSubmit();
    });
  };

  form.addEventListener("submit", holdSubmit, true);
  form.addEventListener("focusin", request);
  form.addEventListener("pointerdown", request);

  const Observer = environment.IntersectionObserver;
  if (Observer === undefined) {
    request();
    return;
  }
  const observer = new Observer(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) request();
    },
    { rootMargin: DEMO_FORM_ROOT_MARGIN },
  );
  observer.observe(form);
  disconnect = () => observer.disconnect();
}
