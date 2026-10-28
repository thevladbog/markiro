import type { NodeHttpHandler } from "@smithy/node-http-handler";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { ClientRequest, Agent } from "node:http";
import type { Socket } from "node:net";

type Observation =
  "new-before-response" | "reused-before-response" | "new-after-response" | "reused-after-response";
type Timing = `${"idle-lt-6000" | "idle-ge-6000"}:${"wait-lt-1000" | "wait-ge-1000"}`;
interface Frame {
  createdAt: number | undefined;
  idleAtAssignment: number | undefined;
  timingAtError: Timing | undefined;
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
  const stamp = (): number | undefined => {
    try {
      const value = performance.now();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const freeAt = new WeakMap<object, number>();
  const agents = new Map<Agent, (socket: Socket) => void>();
  const bindAgent = (agent: Agent) => {
    // One privately owned default agent is sufficient; configuration drift
    // degrades timing to the existing state-only witness instead of growing listeners.
    if (agents.size !== 0) return;
    const released = (socket: Socket) => {
      try {
        freeAt.delete(socket);
        const now = stamp();
        if (!destroyed && now !== undefined) freeAt.set(socket, now);
      } catch {
        /* An observation cannot affect the agent's free-socket handling. */
      }
    };
    agent.on("free", released);
    agents.set(agent, released);
  };
  const subscriber = (message: unknown) => {
    const frame = context.getStore();
    if (destroyed || (frame && (frame.invalid || !active.has(frame)))) return;
    try {
      if (frame && ++frame.notifications !== 1) {
        frame.invalid = true;
        frame.clean();
        return;
      }
      const descriptor = Object.getOwnPropertyDescriptor(message, "request");
      const request: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (!(request instanceof ClientRequest)) {
        if (frame) frame.invalid = true;
        return;
      }
      const agent = Object.getOwnPropertyDescriptor(request, "agent");
      const config = handler.httpHandlerConfigs();
      // Read the existing default agent; never supply or replace one. In the
      // pinned handler it is resolved before the native request is constructed.
      if (
        !agent ||
        !("value" in agent) ||
        !(config.httpAgent instanceof Agent) ||
        agent.value !== config.httpAgent
      ) {
        if (frame) frame.invalid = true;
        return;
      }
      bindAgent(config.httpAgent);
      if (!frame) return;
      frame.createdAt = stamp();
      const assigned = (socket: Socket) => {
        try {
          const released = freeAt.get(socket);
          const now = stamp();
          const elapsed = released === undefined || now === undefined ? undefined : now - released;
          if (elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0)
            frame.idleAtAssignment = elapsed;
        } catch {
          /* Missing timing leaves the original four-state witness available. */
        }
      };
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
          const now = stamp();
          const elapsed =
            frame.createdAt === undefined || now === undefined ? undefined : now - frame.createdAt;
          if (
            frame.idleAtAssignment !== undefined &&
            elapsed !== undefined &&
            Number.isFinite(elapsed) &&
            elapsed >= 0
          ) {
            const idle = frame.idleAtAssignment < 6000 ? "idle-lt-6000" : "idle-ge-6000";
            const wait = elapsed < 1000 ? "wait-lt-1000" : "wait-ge-1000";
            frame.timingAtError = `${idle}:${wait}`;
          }
        } catch {
          frame.invalid = true;
        }
      };
      frame.clean = () => {
        request.removeListener("socket", assigned);
        request.removeListener("response", response);
        request.removeListener("error", error);
      };
      request.once("socket", assigned);
      request.once("response", response);
      request.once("error", error);
    } catch {
      if (frame) frame.invalid = true;
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
  const consume = (
    token: object,
    error: unknown,
  ): { state: Observation; timing?: Timing } | undefined => {
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
    const state: Observation = frame.reused
      ? frame.responseAtError
        ? "reused-after-response"
        : "reused-before-response"
      : frame.responseAtError
        ? "new-after-response"
        : "new-before-response";
    return { state, ...(frame.timingAtError ? { timing: frame.timingAtError } : {}) };
  };
  return {
    run<T>(token: object, action: () => Promise<T>): Promise<T> {
      if (destroyed || active.size >= 64) return action();
      if (frames.has(token)) {
        finish(token);
        return action();
      }
      const frame: Frame = {
        createdAt: undefined,
        idleAtAssignment: undefined,
        timingAtError: undefined,
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
      return consume(token, error)?.state;
    },
    takeDetailed: consume,
    finish,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      created.unsubscribe(subscriber);
      for (const [agent, listener] of agents) {
        try {
          agent.removeListener("free", listener);
        } catch {
          /* Diagnostic cleanup cannot replace the caller's disposal result. */
        }
      }
      agents.clear();
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
