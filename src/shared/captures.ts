/**
 * Local capture storage (IndexedDB). Service worker, preview, editor and history
 * all share the extension origin, so they all see the same database.
 * Nothing here ever leaves the machine.
 */
import { SnapflowError } from './errors';
import { TRANSIENT_TTL_MS } from './constants';
import type { CaptureRecord } from './types';

const DB_NAME = 'snapflow';
const DB_VERSION = 1;
const STORE = 'captures';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('IndexedDB unavailable'));
    };
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    let result: T;
    req.onsuccess = () => {
      result = req.result;
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function newCaptureId(): string {
  return crypto.randomUUID();
}

export async function putCapture(record: CaptureRecord): Promise<void> {
  try {
    await run('readwrite', (s) => s.put(record));
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      throw new SnapflowError('TOO_LARGE', 'Not enough local storage space to keep this screenshot.', { cause: err });
    }
    throw err;
  }
}

export async function getCapture(id: string): Promise<CaptureRecord | undefined> {
  return run<CaptureRecord | undefined>('readonly', (s) => s.get(id));
}

/** Read-modify-write of a record. Returns the updated record, or undefined when it no longer exists. */
export async function patchCapture(
  id: string,
  patch: Partial<CaptureRecord> | ((r: CaptureRecord) => Partial<CaptureRecord>),
): Promise<CaptureRecord | undefined> {
  const current = await getCapture(id);
  if (!current) return undefined;
  const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
  await putCapture(next);
  return next;
}

export async function deleteCapture(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}

export async function listCaptures(): Promise<CaptureRecord[]> {
  const all = await run<CaptureRecord[]>('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function clearCaptures(): Promise<void> {
  await run('readwrite', (s) => s.clear());
}

export function recordSize(r: CaptureRecord): number {
  return r.blob.size + (r.thumb?.size ?? 0) + (r.edited?.blob.size ?? 0);
}

export interface PurgeOptions {
  historyLimit: number;
  historyMaxBytes: number;
  now?: number;
}

/** Pure selection of which records should be deleted. Exported for unit tests. */
export function selectRecordsToPurge(records: CaptureRecord[], opts: PurgeOptions): string[] {
  const now = opts.now ?? Date.now();
  const doomed = new Set<string>();

  for (const r of records) {
    if (!r.keep && now - r.createdAt > TRANSIENT_TTL_MS) doomed.add(r.id);
  }

  // History: newest first; keep within count and total size budget.
  const history = records.filter((r) => r.keep && !doomed.has(r.id)).sort((a, b) => b.createdAt - a.createdAt);
  let bytes = 0;
  history.forEach((r, i) => {
    bytes += recordSize(r);
    if (i >= opts.historyLimit || bytes > opts.historyMaxBytes) doomed.add(r.id);
  });
  return [...doomed];
}

export async function purgeCaptures(opts: PurgeOptions): Promise<number> {
  const ids = selectRecordsToPurge(await listCaptures(), opts);
  await Promise.all(ids.map((id) => deleteCapture(id)));
  return ids.length;
}
