const DB_NAME = "markiro-kiosk";
const DB_VERSION = 1;

export const STORE_CONFIG = "config";
export const STORE_SNAPSHOT = "snapshot";
export const STORE_QUEUE = "queue";
export const STORE_JOURNAL = "journal";

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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
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
 * Like `withStore`, but drives a cursor: `onCursor` fires once per step (most
 * recent first with `direction: "prev"`), and its `stop` callback ends the
 * walk by simply not calling `cursor.continue()` again. Every value the
 * cursor visits before `stop()` is called is collected, in visit order, into
 * the resolved array — this is the only place in `src/store/` allowed to
 * drive a multi-step request against a single transaction, exactly as
 * `withStore` is the only place allowed to drive a single-request one.
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
