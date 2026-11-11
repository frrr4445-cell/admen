/** Privacy-aware cache: memory first, IndexedDB for explicitly public/non-sensitive data only. */
const DB_NAME = 'travel-touch-cache-v1';
const STORE = 'entries';
const memory = new Map();
const MAX_MEMORY_ENTRIES = 200;
let dbPromise;
function openDb() {
  if (!('indexedDB' in globalThis)) return Promise.resolve(null);
  if (!dbPromise) dbPromise = new Promise(resolve => {
    let request;
    try { request = indexedDB.open(DB_NAME, 1); } catch { resolve(null); return; }
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}
const validKey = key => typeof key === 'string' && /^[a-z0-9:_-]{1,180}$/i.test(key);
function remember(key, item) {
  // Map insertion order doubles as a tiny LRU: hot reads move to the newest slot.
  memory.delete(key); memory.set(key, item);
  while (memory.size > MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value);
}
export const TTCache = Object.freeze({
  async get(key) {
    if (!validKey(key)) return null;
    const local = memory.get(key);
    if (local && local.expiresAt > Date.now()) { remember(key, local); return local.value; }
    if (local) memory.delete(key);
    const db = await openDb(); if (!db) return null;
    return new Promise(resolve => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => { const item = req.result; if (!item || item.expiresAt <= Date.now()) { this.delete(key); resolve(null); return; } remember(key, item); resolve(item.value); };
      req.onerror = () => resolve(null);
    });
  },
  async set(key, value, ttlMs = 30000) {
    if (!validKey(key) || !Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > 86400000) return false;
    const item = { value, expiresAt: Date.now() + ttlMs }; remember(key, item);
    const db = await openDb(); if (!db) return true;
    return new Promise(resolve => { const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(item, key); req.onsuccess = () => resolve(true); req.onerror = () => resolve(false); });
  },
  async delete(key) {
    memory.delete(key); const db = await openDb(); if (!db || !validKey(key)) return;
    await new Promise(resolve => { const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key); req.onsuccess = req.onerror = () => resolve(); });
  },
  async clear() {
    memory.clear(); const db = await openDb(); if (!db) return;
    await new Promise(resolve => { const req = db.transaction(STORE, 'readwrite').objectStore(STORE).clear(); req.onsuccess = req.onerror = () => resolve(); });
  }
});

// Stable compatibility name used by the app architecture documentation.
export const TTStoreCache = TTCache;
