// Small promise wrapper around IndexedDB. Everything the app saves lives in one database on the phone.
const DB_NAME = 'alice-reader';
const DB_VERSION = 1;
const STORES = {
  meta: null,                    // key 'book': manifest, lexicon, glosses
  chapters: 'num',               // one record per chapter
  progress: 'num',               // reading position and status per chapter
  words: 'lemma',                // saved and known words
  daily: 'date',                 // reading seconds per day
  settings: null,                // key 'prefs'
};

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, keyPath ? { keyPath } : undefined);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('The database is blocked by another open copy of the app.'));
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get(store, key) {
  const db = await openDB();
  return wrap(db.transaction(store).objectStore(store).get(key));
}

export async function getAll(store) {
  const db = await openDB();
  return wrap(db.transaction(store).objectStore(store).getAll());
}

export async function put(store, value, key) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  if (key === undefined) os.put(value); else os.put(value, key);
  return done(tx);
}

export async function putMany(store, values) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  return done(tx);
}

export async function del(store, key) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

export async function clear(store) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  return done(tx);
}

// Replace the whole book (chapters and meta) in one transaction.
export async function replaceBook(meta, chapters) {
  const db = await openDB();
  const tx = db.transaction(['meta', 'chapters'], 'readwrite');
  const cs = tx.objectStore('chapters');
  cs.clear();
  for (const ch of chapters) cs.put(ch);
  tx.objectStore('meta').put(meta, 'book');
  return done(tx);
}
