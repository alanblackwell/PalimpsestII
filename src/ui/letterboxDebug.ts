import { Node } from '../core/Node.js'
import { computeLetterboxRescale } from '../persistence/letterboxRescale.js'

type AnyCtx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

// ------------------------------------------------------------
// letterboxDebug — visual scaffolding for developing the reload-time
// image-repositioning/scaling policy: image position will be relative to
// the centre of the (possibly resized) canvas, and scale decided on a
// letterbox basis when the saved canvas's aspect ratio differs from the
// current one.
// ------------------------------------------------------------
//
// Draws the letterbox rectangle — the saved *viewport* frame fit into the
// current viewport, preserving aspect ratio and centred — plus a cross at
// the current-viewport centre point the policy scales/repositions
// relative to. Deliberately keyed to Node.viewportWidth/viewportHeight,
// not canvasWidth/canvasHeight: the canvas backing store is floored at
// 800x600 and only ever grows, so on a small browser window it can be
// considerably larger than what's actually visible, which would draw part
// of the box off-screen. Toggled by the 'l' hotkey
// (InteractionSystem._handleKey); while on, drawn every frame over every
// layer (Evaluator.render, both the display-mode and edit-mode paths) so
// it stays visible regardless of selection. Purely a debug aid — this
// module doesn't itself touch any layer's position/scale; see
// persistence/letterboxRescale.ts (shared by every layer that implements
// the actual policy) for the identical scale/centre formula this draws.

const COLOUR   = '#00ff00'
const DASH     = [8, 6]
const CROSS_R  = 16

export function drawLetterboxDebug(ctx: AnyCtx2D): void {
  if (!Node.showLetterboxDebug) return
  const r = computeLetterboxRescale()
  if (r === null) return

  const boxW = r.savedCentre.x * 2 * r.scale
  const boxH = r.savedCentre.y * 2 * r.scale
  const cx = r.newCentre.x
  const cy = r.newCentre.y
  const x = cx - boxW / 2
  const y = cy - boxH / 2

  ctx.save()
  ctx.strokeStyle = COLOUR
  ctx.lineWidth   = 2
  ctx.setLineDash(DASH)
  ctx.strokeRect(x, y, boxW, boxH)
  ctx.setLineDash([])

  ctx.beginPath()
  ctx.moveTo(cx - CROSS_R, cy); ctx.lineTo(cx + CROSS_R, cy)
  ctx.moveTo(cx, cy - CROSS_R); ctx.lineTo(cx, cy + CROSS_R)
  ctx.stroke()
  ctx.restore()
}
