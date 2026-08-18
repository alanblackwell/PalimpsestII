// Ambient declarations for the non-standard directory-selection extension
// to <input type="file"> that TypeScript's bundled "dom" lib doesn't type:
// setting `webkitdirectory` switches the native picker into folder-select
// mode, and each resulting File then carries its path within that folder
// via `webkitRelativePath` (e.g. "MyFolder/subdir/photo.jpg"). Supported by
// Chromium and Firefox; Safari support is inconsistent — feature-detected
// at the call site by checking `files.length === 0` after a pick rather
// than by testing for the property here.

interface HTMLInputElement {
  webkitdirectory: boolean
}

interface File {
  readonly webkitRelativePath: string
}
