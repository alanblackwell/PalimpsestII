import { Node } from '../core/Node.js'
import type { Point } from '../core/types.js'

// ------------------------------------------------------------
// letterboxRescale — shared reload-time letterbox rescale math
// ------------------------------------------------------------
//
// When a saved session/collection is reloaded at a different browser-window
// size, a manually-positioned/scaled/pointed element should keep the same
// proportion of the letterbox's short side, and the same proportional
// offset from centre, that it had relative to the window it was saved at.
// See ui/letterboxDebug.ts for the identical visual debug overlay (the 'l'
// hotkey), and ImageLayer — the original implementation this was extracted
// from — for the full design rationale, including why this is keyed to
// Node.viewportWidth/viewportHeight rather than canvasWidth/canvasHeight.
//
// Every layer that wants this applies it from its own deserializeState:
// call computeLetterboxRescale() once, and if non-null, remap whatever
// manual position/scale/point fields it persists. Scale-type fields
// (display multipliers) should be multiplied by `scale` directly, clamped
// to the layer's own valid range; absolute canvas-space points (including
// a manual position) should go through rescalePoint().

export interface LetterboxRescale {
  readonly scale: number
  readonly savedCentre: Point
  readonly newCentre: Point
}

// null when there's nothing to rescale against: no save has been loaded
// yet this page-load, the save predates the viewport field, or the
// viewport hasn't actually changed since it was saved.
export function computeLetterboxRescale(): LetterboxRescale | null {
  const saved = Node.lastLoadedViewport
  if (saved === null || saved.width <= 0 || saved.height <= 0) return null
  const vw = Node.viewportWidth, vh = Node.viewportHeight
  if (vw === saved.width && vh === saved.height) return null
  return {
    scale: Math.min(vw / saved.width, vh / saved.height),
    savedCentre: { x: saved.width / 2, y: saved.height / 2 },
    newCentre:   { x: vw / 2, y: vh / 2 },
  }
}

// Remaps a single absolute canvas-space point: same proportional offset
// from centre, scaled by the letterbox factor.
export function rescalePoint(r: LetterboxRescale, p: Point): Point {
  return {
    x: r.newCentre.x + (p.x - r.savedCentre.x) * r.scale,
    y: r.newCentre.y + (p.y - r.savedCentre.y) * r.scale,
  }
}
