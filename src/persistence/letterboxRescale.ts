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

// The rectangle (in the same coordinate space as Node.canvasWidth/
// canvasHeight) that a "fills the whole canvas" layer — TileLayer,
// FillLayer, NoiseLayer — should paint into. Outside Node.letterboxMode ===
// 'replay' (or when there's nothing to rescale against — see
// computeLetterboxRescale), this is just the full canvas, i.e. today's
// unconstrained behaviour ('debug' and 'reuse' both want this). In
// 'replay' it's the letterbox sub-rect instead, so a saved stack's
// generated backgrounds replay confined to the same proportion of the
// screen they occupied when saved — matching what Evaluator paints solid
// black around (see ui/letterboxDebug.ts's drawLetterboxReplayBars) — since
// consumers of these layers' getImage()/getMask() output (e.g. a
// CompositeLayer blending one in) never see that black overlay themselves.
export interface LetterboxFillRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export function letterboxFillRect(): LetterboxFillRect {
  const full = { x: 0, y: 0, width: Node.canvasWidth, height: Node.canvasHeight }
  if (Node.letterboxMode !== 'replay') return full
  const r = computeLetterboxRescale()
  if (r === null) return full
  const width  = r.savedCentre.x * 2 * r.scale
  const height = r.savedCentre.y * 2 * r.scale
  return { x: r.newCentre.x - width / 2, y: r.newCentre.y - height / 2, width, height }
}
