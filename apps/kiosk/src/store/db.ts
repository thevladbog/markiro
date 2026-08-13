const DB_NAME = "markiro-kiosk";
/**
 * Bumped only when the SHAPE below changes — a new store, a new index, a
 * different `keyPath`. Adding a field to a stored RECORD is not such a change
 * and must not bump it: `onupgradeneeded` would have nothing to do, while
 * every device would still be holding records written by older versions. The
 * reader that needs the new field is the one that has to cope, which is what
 * `countTakenToday` does with an entry from before the journal carried an
 * employee.
 */
const DB_VERSION = 3;

export const STORE_CONFIG = "config";
export const STORE_SNAPSHOT = "snapshot";
export const STORE_QUEUE = "queue";
export const STORE_JOURNAL = "journal";
/**
 * Where an order the server refused FOR GOOD goes — added in version 2, which
 * is the shape change that bumped the number above.
 *
 * A store rather than a flag on the queue record: `listQueue` is read by the
 * drain AND by the day count, and both want the same answer (a permanently
 * refused order is neither owed to the server nor charged to the worker), so
 * moving the record out of the queue answers both without either reader
 * learning a new state.
 */
export const STORE_QUARANTINE = "quarantine";
export const STORE_BOX_REGISTRY_ACTIVE = "boxRegistryActive";
export const STORE_BOX_REGISTRY_STAGING = "boxRegistryStaging";
export const STORE_BOX_REGISTRY_META = "boxRegistryMeta";

// Module-private: every caller reaches the database through `withStore` or
// `withCursor` below, which are the only two places that open a connection
// and are therefore the only two places responsible for closing it.
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Singleton stores: one row under a fixed key. Keeping them as object
      // stores (rather than one blob) lets a snapshot replacement and a queue
      // write proceed without contending on the same record.
      if (!db.objectStoreNames.contains(STORE_CONFIG)) db.createObjectStore(STORE_CONFIG);
      if (!db.objectStoreNames.contains(STORE_SNAPSHOT)) db.createObjectStore(STORE_SNAPSHOT);
      // `deviceSeq` is the queue's natural key, and IndexedDB iterates a key
      // range in ascending order — which is exactly the drain order the
      // server's idempotency contract requires.
      if (!db.objectStoreNames.contains(STORE_QUEUE))
        db.createObjectStore(STORE_QUEUE, { keyPath: "deviceSeq" });
      if (!db.objectStoreNames.contains(STORE_JOURNAL))
        db.createObjectStore(STORE_JOURNAL, { autoIncrement: true });
      // Keyed by `deviceSeq` like the queue it is fed from, so re-quarantining
      // the same order (a drain that parked it but crashed before the dequeue)
      // overwrites rather than duplicates.
      if (!db.objectStoreNames.contains(STORE_QUARANTINE))
        db.createObjectStore(STORE_QUARANTINE, { keyPath: "deviceSeq" });
      if (!db.objectStoreNames.contains(STORE_BOX_REGISTRY_ACTIVE))
        db.createObjectStore(STORE_BOX_REGISTRY_ACTIVE, { keyPath: "sscc" });
      if (!db.objectStoreNames.contains(STORE_BOX_REGISTRY_STAGING))
        db.createObjectStore(STORE_BOX_REGISTRY_STAGING, { keyPath: "sscc" });
      if (!db.objectStoreNames.contains(STORE_BOX_REGISTRY_META))
        db.createObjectStore(STORE_BOX_REGISTRY_META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    // A version upgrade waits for every older connection to close, and while it
    // waits this promise is simply pending — which on a kiosk looks exactly like
    // the store having died. Every connection here is opened and closed around a
    // single transaction, so this should be unreachable; it is logged rather
    // than rejected because the wait usually does resolve, and a line in the
    // console is the difference between a diagnosable stall and a silent one.
    request.onblocked = () =>
      console.warn("kiosk: the IndexedDB upgrade is waiting for another connection to close");
  });
}

/**
 * Runs several object stores under one transaction. The callback must remain
 * synchronous: awaiting inside it would let IndexedDB auto-commit before the
 * next request is queued. Callers may queue dependent work from request event
 * handlers, which are part of the same transaction.
 */
export async function withTransaction(
  names: readonly string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => void,
): Promise<void> {
  const db = await open();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...names], mode);
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      db.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      db.close();
      resolve();
    };
    tx.onerror = () => fail(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => fail(tx.error ?? new Error("IndexedDB transaction aborted"));
    try {
      run(tx);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // The transaction may already have aborted because the synchronous
        // operation threw. `fail` below still owns closing the connection.
      }
      fail(error);
    }
  });
}

export async function withStore<T>(
  name: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await open();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(name, mode);
    let result: T | undefined;
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    };
    try {
      const request = run(tx.objectStore(name));
      if (request) request.onsuccess = () => (result = request.result);
    } catch (err) {
      // `run` can throw synchronously (e.g. a write method called against a
      // "readonly" transaction) before any request ever reaches `tx.onerror`
      // or `tx.oncomplete` — close the handle explicitly here so it can't leak.
      db.close();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Rewrites records IN PLACE: `apply` is called for every record in the store
 * and returns its replacement, or `null` to leave it alone. Resolves with how
 * many were replaced. (The return type is plain `unknown` because `null` is
 * already one of its inhabitants — no record here is ever `null`, so the
 * sentinel costs nothing.)
 *
 * A CURSOR RATHER THAN read-then-`put`, and the difference is an order. `put`
 * on a key that no longer exists RE-CREATES it, so a record the drain deleted
 * between the read and the write would come back — resurrecting a delivered
 * order under a `deviceSeq` the server has already spent, which is the silent
 * failure `quarantineQueue` documents: the server answers a repeated
 * `(tenantId, kioskId, deviceSeq)` with the FIRST order, so a later worker's
 * whole cart evaporates under a stranger's number. A cursor only visits what
 * is there when its transaction runs, and IndexedDB serialises overlapping
 * transactions on the same store, so a concurrent dequeue either happens
 * wholly before this walk (the record is not visited) or wholly after it (the
 * record is deleted, rewrite and all).
 *
 * `apply` is therefore SYNCHRONOUS by contract, not by accident: an IndexedDB
 * transaction commits as soon as its microtask queue drains, so awaiting
 * anything inside the walk would close the transaction under it. Callers that
 * need async work (deriving a digest, say) must do it before calling this.
 */
export async function updateEach(
  name: string,
  apply: (value: unknown) => unknown,
): Promise<number> {
  const db = await open();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(name, "readwrite");
    let updated = 0;
    tx.oncomplete = () => {
      db.close();
      resolve(updated);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    };
    try {
      const request = tx.objectStore(name).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const next = apply(cursor.value);
        if (next !== null) {
          cursor.update(next);
          updated += 1;
        }
        cursor.continue();
      };
    } catch (err) {
      db.close();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Like `withStore`, but drives a cursor: `onCursor` fires once per step (most
 * recent first with `direction: "prev"`), and its `stop` callback ends the
 * walk by simply not calling `cursor.continue()` again. Every value the
 * cursor visits before `stop()` is called is collected, in visit order, into
 * the resolved array — this and `updateEach` above are the only places in
 * `src/store/` allowed to drive a multi-step request against a single
 * transaction, exactly as `withStore` is the only place allowed to drive a
 * single-request one.
 */
export async function withCursor<T>(
  name: string,
  direction: IDBCursorDirection,
  onCursor: (cursor: IDBCursorWithValue, stop: () => void) => void,
): Promise<T[]> {
  const db = await open();
  return new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(name, "readonly");
    const results: T[] = [];
    let stopped = false;
    const stop = () => {
      stopped = true;
    };
    tx.oncomplete = () => {
      db.close();
      resolve(results);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    };
    try {
      const request = tx.objectStore(name).openCursor(null, direction);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || stopped) return;
        results.push(cursor.value as T);
        onCursor(cursor, stop);
      };
    } catch (err) {
      db.close();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
