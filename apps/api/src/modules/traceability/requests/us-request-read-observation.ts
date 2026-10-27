import type { NodeHttpHandler } from "@smithy/node-http-handler";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { ClientRequest } from "node:http";

type Observation =
  "new-before-response" | "reused-before-response" | "new-after-response" | "reused-after-response";
interface Frame {
  notifications: number;
  invalid: boolean;
  response: boolean;
  responseAtError: boolean | undefined;
  error: unknown;
  reused: boolean | undefined;
  taken: boolean;
  clean(): void;
}

/** Observational only: native channel origin and Node intrinsics are trusted.
 * Public channel publishers are not authenticated by this diagnostic. Nothing
 * here controls requests, retries, authorization or error propagation.
 */
export function createUsRequestReadObservation(handler: NodeHttpHandler) {
  const context = new AsyncLocalStorage<Frame>();
  const frames = new WeakMap<object, Frame>();
  const active = new Set<Frame>();
  const created = channel("http.client.request.created");
  let destroyed = false;
  const subscriber = (message: unknown) => {
    const frame = context.getStore();
    if (!frame || frame.invalid || !active.has(frame)) return;
    try {
      if (++frame.notifications !== 1) {
        frame.invalid = true;
        frame.clean();
        return;
      }
      const descriptor = Object.getOwnPropertyDescriptor(message, "request");
      const request: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (!(request instanceof ClientRequest)) {
        frame.invalid = true;
        return;
      }
      const agent = Object.getOwnPropertyDescriptor(request, "agent");
      const config = handler.httpHandlerConfigs();
      // Read the existing default agent; never supply or replace one. In the
      // pinned handler it is resolved before the native request is constructed.
      if (!agent || !("value" in agent) || !config.httpAgent || agent.value !== config.httpAgent) {
        frame.invalid = true;
        return;
      }
      const response = () => {
        frame.response = true;
      };
      const error = (value: unknown) => {
        try {
          const reused = Object.getOwnPropertyDescriptor(request, "reusedSocket");
          if (
            frame.invalid ||
            !active.has(frame) ||
            !reused ||
            !("value" in reused) ||
            typeof reused.value !== "boolean"
          )
            return;
          frame.responseAtError = frame.response;
          frame.error = value;
          frame.reused = reused.value;
        } catch {
          frame.invalid = true;
        }
      };
      frame.clean = () => {
        request.removeListener("response", response);
        request.removeListener("error", error);
      };
      request.once("response", response);
      request.once("error", error);
    } catch {
      frame.invalid = true;
    }
  };
  created.subscribe(subscriber);
  const finish = (token: object) => {
    const frame = frames.get(token);
    if (!frame) return;
    frames.delete(token);
    active.delete(frame);
    frame.invalid = true;
    frame.error = undefined;
    try {
      frame.clean();
    } catch {
      /* Diagnostics must not replace a result. */
    }
    frame.clean = () => {};
  };
  return {
    run<T>(token: object, action: () => Promise<T>): Promise<T> {
      if (destroyed || active.size >= 64) return action();
      if (frames.has(token)) {
        finish(token);
        return action();
      }
      const frame: Frame = {
        notifications: 0,
        invalid: false,
        response: false,
        responseAtError: undefined,
        error: undefined,
        reused: undefined,
        taken: false,
        clean: () => {},
      };
      frames.set(token, frame);
      active.add(frame);
      return context.run(frame, action);
    },
    take(token: object, error: unknown): Observation | undefined {
      const frame = frames.get(token);
      if (
        !frame ||
        frame.invalid ||
        frame.taken ||
        frame.notifications !== 1 ||
        frame.reused === undefined ||
        frame.responseAtError === undefined ||
        frame.error !== error
      )
        return undefined;
      frame.taken = true;
      if (frame.reused)
        return frame.responseAtError ? "reused-after-response" : "reused-before-response";
      return frame.responseAtError ? "new-after-response" : "new-before-response";
    },
    finish,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      created.unsubscribe(subscriber);
      for (const frame of active) {
        frame.invalid = true;
        frame.error = undefined;
        try {
          frame.clean();
        } catch {
          /* Diagnostics must not replace disposal. */
        }
        frame.clean = () => {};
      }
      active.clear();
      context.disable();
    },
  };
}
