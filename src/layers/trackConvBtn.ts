// Shared helpers for Track* layer replacement buttons and slider rendering.
// All Track* layers import from here to keep visual style consistent.

import type { Ctx2D } from '../core/types.js'
import { Node }       from '../core/Node.js'
import { contentLeft } from '../interaction/layout.js'

// ── Replace-button constants ───────────────────────────────────────────────

export const TRK_BTN_H   = 30
export const TRK_BTN_GAP = 14
export const TRK_BTN_SEP = 8
export const TRK_COL          = '#cf7ecf'   // Point accent
export const TRK_OUTLINE_COL  = '#e8944a'   // orange region outline

/** Width for each button label (sized to fit the text at 11px monospace + padding) */
export const TRK_W: Record<'rect' | 'ellipse' | 'path' | 'draw', number> = {
  rect: 55, ellipse: 72, path: 55, draw: 55,
}

// ── Replace-button rendering ───────────────────────────────────────────────

export function renderTrackRepBtn(
  ctx: Ctx2D, x: number, y: number, w: number, label: string,
): void {
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.beginPath(); ctx.roundRect(x, y, w, TRK_BTN_H, 5); ctx.fill()
  ctx.fillStyle = TRK_COL + 'cc'
  ctx.beginPath(); ctx.roundRect(x, y, 3, TRK_BTN_H, [5, 0, 0, 5]); ctx.fill()
  ctx.save()
  ctx.beginPath(); ctx.rect(x, y, w, TRK_BTN_H); ctx.clip()
  ctx.fillStyle    = 'rgba(255,255,255,0.85)'
  ctx.font         = '11px monospace'
  ctx.textAlign    = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + 10, y + TRK_BTN_H / 2)
  ctx.restore(); ctx.restore()
}

/**
 * Lay out a row of Track replacement buttons, centred within the content
 * area, at the standard viewport-bottom position. Returns an array of
 * `{ x, y, w, label }` in left-to-right order matching the input defs.
 */
export function trackRepBtnLayout(
  defs: { w: number; label: string }[],
): { x: number; y: number; w: number; label: string }[] {
  const left  = contentLeft(Node.canvasWidth)
  const total = defs.reduce((s, d, i) => s + d.w + (i > 0 ? TRK_BTN_SEP : 0), 0)
  let x = left + Math.max(0, (Node.viewportWidth - left - total) / 2)
  const y = Node.viewportHeight - TRK_BTN_H - TRK_BTN_GAP
  return defs.map(d => { const r = { x, y, w: d.w, label: d.label }; x += d.w + TRK_BTN_SEP; return r })
}

// ── Shared slider renderer ─────────────────────────────────────────────────
// Mirrors ShapeLayer._drawSlider (protected), usable by TrackDrawingLayer
// which extends MaskLayer, not ShapeLayer.

export function drawSliderTrack(
  ctx: Ctx2D, midY: number, x0: number, x1: number, v: number, colour: string,
): void {
  const thumbR = 5
  const lo = x0 + thumbR
  const hi = x1 - thumbR
  const range  = Math.max(0, hi - lo)
  const thumbX = lo + Math.max(0, Math.min(1, v)) * range

  ctx.lineCap     = 'round'
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.lineWidth   = 3
  ctx.beginPath(); ctx.moveTo(lo, midY); ctx.lineTo(hi, midY); ctx.stroke()

  ctx.strokeStyle = colour
  ctx.beginPath(); ctx.moveTo(lo, midY); ctx.lineTo(thumbX, midY); ctx.stroke()

  ctx.fillStyle = colour
  ctx.beginPath(); ctx.arc(thumbX, midY, thumbR, 0, Math.PI * 2); ctx.fill()
}

/**
 * Compute the x position of the slider thumb from a pointer x, given the
 * same sld0/sldR bounds used when rendering.
 */
export function smoothValueFromPointer(px: number, sld0: number, sldR: number, max: number): number {
  const thumbR = 5
  const lo = sld0 + thumbR, hi = sldR - thumbR
  const frac = Math.max(0, Math.min(1, (px - lo) / Math.max(1, hi - lo)))
  return Math.max(1, Math.round(1 + frac * (max - 1)))
}
