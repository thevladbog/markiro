import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

type OverlayKind = "panel" | "dialog";
type InitialFocus = "first-editable" | "cancel";

export interface OverlayLayerProps {
  open: boolean;
  kind: OverlayKind;
  busy: boolean;
  initialFocus: InitialFocus;
  onEscape: () => void;
  children: (surfaceRef: RefObject<HTMLDivElement | null>) => ReactNode;
}

interface LayerRecord {
  id: symbol;
  element: HTMLDivElement;
  onEscape: () => void;
  busy: boolean;
  initialFocus: InitialFocus;
  surfaceRef: RefObject<HTMLDivElement | null>;
  previouslyFocused: HTMLElement | null;
}

const OverlayPortalContext = createContext<HTMLElement | undefined>(undefined);

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

const layers: LayerRecord[] = [];
const inertSnapshot = new Map<HTMLElement, boolean>();
let host: HTMLDivElement | null = null;
let restoreBodyOverflow: string | null = null;
let listenerInstalled = false;

function ensureHost() {
  if (host) return host;

  host = document.createElement("div");
  host.className = "mk-overlay-root";
  document.body.appendChild(host);
  return host;
}

function getFocusable(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

function applyInertness() {
  layers.forEach((layer, index) => {
    layer.element.inert = index !== layers.length - 1;
  });
}

function focusInitial(record: LayerRecord) {
  const container = record.element;
  const invalid = container.querySelector<HTMLElement>("[aria-invalid='true']");
  const editable = container.querySelector<HTMLElement>(
    "input:not([disabled]), textarea:not([disabled]), select:not([disabled])",
  );
  const cancel = container.querySelector<HTMLElement>("[data-overlay-cancel]");
  const target =
    (record.initialFocus === "cancel" ? cancel : invalid ?? editable) ??
    getFocusable(container)[0] ??
    record.surfaceRef.current;
  target?.focus();
}

function trapFocus(event: KeyboardEvent, record: LayerRecord) {
  if (event.key !== "Tab") return;

  const focusable = getFocusable(record.element);
  if (focusable.length === 0) {
    event.preventDefault();
    record.surfaceRef.current?.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first?.focus();
  }
}

function handleDocumentKeyDown(event: KeyboardEvent) {
  const record = layers.at(-1);
  if (!record) return;

  if (event.key === "Tab") {
    trapFocus(event, record);
    return;
  }

  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (event.target instanceof Element && event.target.closest("[data-mk-nested-overlay]")) return;
  if (record.busy) return;

  event.preventDefault();
  event.stopPropagation();
  record.onEscape();
}

function installListener() {
  if (listenerInstalled) return;
  document.addEventListener("keydown", handleDocumentKeyDown);
  listenerInstalled = true;
}

function removeListener() {
  if (!listenerInstalled) return;
  document.removeEventListener("keydown", handleDocumentKeyDown);
  listenerInstalled = false;
}

function register(record: LayerRecord) {
  if (layers.length === 0) {
    restoreBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    Array.from(document.body.children).forEach((child) => {
      if (child === host) return;
      inertSnapshot.set(child as HTMLElement, Boolean((child as HTMLElement).inert));
      (child as HTMLElement).inert = true;
    });
    installListener();
  }

  layers.push(record);
  applyInertness();
}

function unregister(id: symbol) {
  const index = layers.findIndex((layer) => layer.id === id);
  if (index === -1) return;

  const [record] = layers.splice(index, 1);
  record?.element.remove();

  if (layers.length > 0) {
    applyInertness();
    focusInitial(layers.at(-1)!);
  } else {
    inertSnapshot.forEach((wasInert, element) => {
      element.inert = wasInert;
    });
    inertSnapshot.clear();
    if (restoreBodyOverflow !== null) document.body.style.overflow = restoreBodyOverflow;
    restoreBodyOverflow = null;
    host?.remove();
    host = null;
    removeListener();
  }

  if (layers.length === 0 && record?.previouslyFocused?.isConnected) {
    record.previouslyFocused.focus();
  }
}

/** Internal only: supplies the owning overlay layer to nested Radix portals. */
export function useOverlayPortalContainer() {
  return useContext(OverlayPortalContext);
}

export function OverlayLayer({ open, kind, busy, initialFocus, onEscape, children }: OverlayLayerProps) {
  const idRef = useRef(Symbol("mk-overlay-layer"));
  const surfaceRef = useRef<HTMLDivElement>(null);
  const onEscapeRef = useRef(onEscape);
  const busyRef = useRef(busy);
  const initialFocusRef = useRef(initialFocus);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);

  onEscapeRef.current = onEscape;
  busyRef.current = busy;
  initialFocusRef.current = initialFocus;

  useLayoutEffect(() => {
    if (!open) return undefined;

    const id = idRef.current;
    const layerElement = document.createElement("div");
    layerElement.className = `mk-overlay-layer mk-overlay-layer--${kind}`;
    ensureHost().appendChild(layerElement);
    setLayer(layerElement);

    const record: LayerRecord = {
      id,
      element: layerElement,
      onEscape: () => onEscapeRef.current(),
      busy: busyRef.current,
      initialFocus: initialFocusRef.current,
      surfaceRef,
      previouslyFocused: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    register(record);

    return () => {
      setLayer(null);
      unregister(id);
    };
  }, [kind, open]);

  useLayoutEffect(() => {
    const record = layers.find((item) => item.id === idRef.current);
    if (!record) return;
    record.busy = busy;
  }, [busy]);

  useLayoutEffect(() => {
    const record = layers.find((item) => item.id === idRef.current);
    if (record && layer) focusInitial(record);
  }, [layer]);

  if (!open || !layer) return null;

  return createPortal(
    <OverlayPortalContext.Provider value={layer}>{children(surfaceRef)}</OverlayPortalContext.Provider>,
    layer,
  );
}
