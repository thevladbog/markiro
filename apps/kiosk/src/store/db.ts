const DB_NAME = "markiro-kiosk";
const DB_VERSION = 1;

export const STORE_CONFIG = "config";
export const STORE_SNAPSHOT = "snapshot";
export const STORE_QUEUE = "queue";
export const STORE_JOURNAL = "journal";

// Exported (not just used internally by `withStore`) so `journal.ts` can run
// its own cursor-driven transaction: `withStore`'s single-request wiring
// below only captures one `onsuccess` result, but a "last N entries" read
// needs `cursor.continue()` called repeatedly against the same transaction.
export function open(): Promise<IDBDatabase> {
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
    const request = run(tx.objectStore(name));
    if (request) request.onsuccess = () => (result = request.result);
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    };
  });
}
