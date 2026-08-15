// Ambient declarations for the Chromium-only parts of the File System
// Access API that TypeScript's bundled "dom" lib doesn't type: the picker
// entry point and the permission-query extension on FileSystemFileHandle.
// (lib.dom.d.ts already types FileSystemFileHandle.getFile()/.name/.kind
// and FileSystemHandle.isSameEntry() — those come from the base File
// System API used for drag-and-drop, not this extension.)
//
// All members are optional so `typeof window.showOpenFilePicker ===
// 'function'` / `handle.queryPermission?.(...)` serve as feature detection
// on browsers where this global simply doesn't exist.

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

interface FileSystemFileHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
}

type WellKnownDirectory = 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'

interface OpenFilePickerOptions {
  types?: { description?: string; accept: Record<string, string[]> }[]
  multiple?: boolean
  // Hints where the picker dialog should open. A FileSystemHandle (even one
  // whose permission has lapsed — this is a UI hint only, no read access
  // required) opens the picker in that entry's containing folder.
  startIn?: FileSystemHandle | WellKnownDirectory
}

interface Window {
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>
}
