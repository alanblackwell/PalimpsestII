import { Node } from '../core/Node.js'

// ------------------------------------------------------------
// downscaleForStorage — cap an image surface before it's embedded in a
// save file
// ------------------------------------------------------------
//
// Never upscales, only fits down (same rule ImageLayer's _adoptBitmap
// applies on the way in). A layer's live session copy keeps its full
// original resolution (so scaling up later, e.g. to inspect detail, stays
// sharp); this is only for what actually gets written to disk, so a save
// with many/large embedded images doesn't bloat the session JSON for no
// visible benefit. Used by ImageLayer (the acquired bitmap) and
// CaptureLayer (the captured composite) from their own serializeState.
//
// Standalone module (not part of Persistence.ts) because Persistence.ts
// already imports every layer class for its LAYER_CLASSES registry — a
// layer importing anything back from Persistence.ts would be circular.

export function downscaleForStorage(
  bitmap: OffscreenCanvas | ImageBitmap | null,
): OffscreenCanvas | ImageBitmap | null {
  if (bitmap === null) return null
  const scale = Math.min(1, Node.canvasWidth / bitmap.width, Node.canvasHeight / bitmap.height)
  if (scale >= 1) return bitmap
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h)
  return canvas
}
