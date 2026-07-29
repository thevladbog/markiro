// jsdom ships no IndexedDB. Register the fake on globalThis first, before any
// store module opens a database at import time.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach } from "vitest";

// A fresh factory per test: `fake-indexeddb/auto` otherwise shares one
// instance across every test in a worker, so state leaks between them.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

// Initializes the i18next singleton (RU resources; a missing key throws in
// test mode) before any test renders a component that calls useTranslation.
import "../src/i18n/index.js";
