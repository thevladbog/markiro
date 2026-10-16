import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";

interface TriggerProps {
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  "aria-describedby"?: string | undefined;
}

export interface TooltipProps {
  /** The text. It also names the control for a screen reader when the control has no other name: the control keeps its own `aria-label`. */
  label: string;
  /** The one control the tooltip is for. */
  children: ReactElement<TriggerProps>;
}

interface Placement {
  top: number;
  right: number;
  below: boolean;
}

/**
 * A tooltip for an icon control: shown while the pointer is over it or it has the keyboard focus
 * (not on a plain click), dismissed with Escape (WCAG 1.4.13) and when the pointer or the focus
 * leaves. The text sits in `role="tooltip"` and the control points at it with `aria-describedby`;
 * the control keeps its own accessible name. It is drawn in the body, above a table's scroll
 * region and a drawer, aligned to the control's right edge. L2: the only shadowed layer.
 */
export function Tooltip({ label, children }: TooltipProps) {
  const id = useId();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  // A press focuses the control too, and that focus does not show the tooltip (the pointer is on it anyway).
  const pressed = useRef(false);
  const bubble = useRef<HTMLDivElement | null>(null);
  const open = (hover || focus) && !dismissed;

  const place = useCallback(() => {
    const node = trigger.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    const height = bubble.current?.offsetHeight ?? 40;
    // Above the control unless the window has no room there.
    const below = rect.top < height + 16;
    setPlacement({
      top: below ? rect.bottom + 8 : rect.top - 8,
      right: Math.max(8, window.innerWidth - rect.right),
      below,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, label]);

  useEffect(() => {
    if (!open) return;
    // A scroll under the pointer moves the control away from the tooltip.
    const close = () => {
      setHover(false);
      setFocus(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const props = children.props;
  const enhanced = cloneElement(children, {
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      trigger.current = event.currentTarget;
      setDismissed(false);
      setHover(true);
      props.onMouseEnter?.(event);
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      setHover(false);
      setDismissed(false);
      props.onMouseLeave?.(event);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      trigger.current = event.currentTarget;
      setDismissed(false);
      if (!pressed.current) setFocus(true);
      props.onFocus?.(event);
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      pressed.current = true;
      props.onPointerDown?.(event);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      pressed.current = false;
      setFocus(false);
      setDismissed(false);
      props.onBlur?.(event);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape" && open) {
        // The tooltip goes; a drawer or a dialog around the control stays.
        event.stopPropagation();
        setDismissed(true);
      }
      props.onKeyDown?.(event);
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      pressed.current = false;
      setHover(false);
      props.onClick?.(event);
    },
    "aria-describedby": open ? id : (props["aria-describedby"] ?? undefined),
  });

  return (
    <>
      {enhanced}
      {open &&
        createPortal(
          <div
            ref={bubble}
            id={id}
            role="tooltip"
            className="office-tooltip"
            data-below={placement?.below ? "true" : undefined}
            style={
              placement === null
                ? { visibility: "hidden" }
                : { top: placement.top, right: placement.right }
            }
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}
