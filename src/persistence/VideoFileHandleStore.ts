// IndexedDB-backed store for FileSystemFileHandles captured when a video is
// picked via VideoLayer's File button (see src/types/file-system-access.d.ts).
// A separate DB from MobileStore's save gallery, so their onupgradeneeded/
// version bumps never interact with each other. Keyed by VideoLayer's own
// persisted `fileHandleId` (a crypto.randomUUID() minted on first capture,
// not a Node/LayerRecord id — see VideoLayer.ts).

const DB_NAME    = 'PalimpsestII-video-handles'
const STORE_NAME = 'handles'
const DB_VERSION = 1

export const fileSystemAccessSupported = typeof window.showOpenFilePicker === 'function'

interface StoredHandle {
  id:     string
  handle: FileSystemFileHandle
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

export async function getHandle(id: string): Promise<FileSystemFileHandle | null> {
  const found = await storeOp('readonly', s => s.get(id)) as StoredHandle | undefined
  return found?.handle ?? null
}

export function putHandle(id: string, handle: FileSystemFileHandle): Promise<IDBValidKey> {
  return storeOp('readwrite', s => s.put({ id, handle } satisfies StoredHandle))
}

export function deleteHandle(id: string): Promise<undefined> {
  return storeOp('readwrite', s => s.delete(id))
}
