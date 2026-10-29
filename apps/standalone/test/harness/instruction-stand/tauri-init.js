/* global window */
// Init script of the instruction stand: what @tauri-apps/api 2 needs from the Tauri runtime
// (`window.__TAURI_INTERNALS__`, the event plugin's internals), with every command sent to the
// Node shell (`shell.mjs`) through the `__standShell` binding. Node raises events through
// `window.__standEmit(event, payload)`.
(() => {
  const callbacks = new Map();
  const listeners = new Map();
  let next = 1;

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    transformCallback(callback, once) {
      const id = next++;
      callbacks.set(id, (payload) => {
        if (once) callbacks.delete(id);
        return callback?.(payload);
      });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc(path) {
      return path;
    },
    async invoke(command, args = {}) {
      if (command === "plugin:event|listen") {
        const id = next++;
        const list = listeners.get(args.event) ?? [];
        list.push({ id, handler: args.handler });
        listeners.set(args.event, list);
        return id;
      }
      if (command === "plugin:event|unlisten") {
        window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(args.event, args.eventId);
        return null;
      }
      const answer = await window.__standShell(command, args);
      if ("error" in answer) throw answer.error;
      return answer.value;
    },
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, id) {
      const list = listeners.get(event) ?? [];
      listeners.set(
        event,
        list.filter((listener) => listener.id !== id),
      );
    },
  };

  window.__standEmit = (event, payload) => {
    for (const listener of listeners.get(event) ?? []) {
      callbacks.get(listener.handler)?.({ event, id: listener.id, payload });
    }
  };
})();
