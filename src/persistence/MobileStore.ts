// IndexedDB-backed save store for the mobile web app.
// Saves are self-contained objects: the full session JSON plus a JPEG preview
// data URL captured at save time. Desktop uses download/upload instead.

const DB_NAME    = 'PalimpsestII'
const STORE_NAME = 'saves'
const DB_VERSION = 1

export interface MobileSave {
  id:      string    // crypto.randomUUID()
  name:    string    // user-editable label
  savedAt: number    // Date.now()
  preview: string    // JPEG data URL
  session: unknown   // Persistence.SaveFile (kept as plain object)
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

function storeOp<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, mode)
    const req = fn(tx.objectStore(STORE_NAME))
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  }))
}

export async function listSaves(): Promise<MobileSave[]> {
  const all = await storeOp('readonly', s => s.getAll()) as MobileSave[]
  return all.sort((a, b) => b.savedAt - a.savedAt)
}

export function writeSave(save: MobileSave): Promise<IDBValidKey> {
  return storeOp('readwrite', s => s.put(save))
}

export function deleteSave(id: string): Promise<undefined> {
  return storeOp('readwrite', s => s.delete(id))
}

export async function renameSave(id: string, name: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const get   = store.get(id)
    get.onsuccess = () => {
      const save = get.result as MobileSave | undefined
      if (!save) { reject(new Error('save not found')); return }
      save.name = name
      const put = store.put(save)
      put.onsuccess = () => resolve()
      put.onerror   = () => reject(put.error)
    }
    get.onerror = () => reject(get.error)
  })
}
