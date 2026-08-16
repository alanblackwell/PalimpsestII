import { Node } from '../core/Node.js'
import { computeLetterboxRescale } from '../persistence/letterboxRescale.js'

type AnyCtx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

// ------------------------------------------------------------
// letterboxDebug — visual overlays for Node.letterboxMode
// ------------------------------------------------------------
//
// Both overlays are keyed to the same letterbox rectangle — the saved
// *viewport* frame fit into the current viewport, preserving aspect ratio
// and centred (see persistence/letterboxRescale.ts for the shared
// scale/centre formula every layer's actual rescale policy also uses).
// Deliberately keyed to Node.viewportWidth/viewportHeight, not
// canvasWidth/canvasHeight: the canvas backing store is floored at 800x600
// and only ever grows, so on a small browser window it can be considerably
// larger than what's actually visible, which would draw part of the box
// off-screen. Both are drawn every frame, last, over every layer
// (Evaluator.render, both the display-mode and edit-mode paths), so they
// stay visible regardless of selection.
//
// Cycled by the 'l' hotkey (InteractionSystem._handleKey) via
// Node.letterboxMode:
//   'debug'  — drawLetterboxDebug: green dotted box + centre cross, purely
//              a visual aid, touches no layer's actual position/scale.
//   'replay' — drawLetterboxReplayBars: solid black over the bands outside
//              the box, so a saved stack replays as it was composed. The
//              *content* inside those bands is kept out by TileLayer/
//              FillLayer/NoiseLayer consulting
//              persistence/letterboxRescale.ts's letterboxFillRect()
//              themselves (this overlay alone wouldn't reach anything
//              consuming their getImage()/getMask() output downstream,
//              only what's on screen) — this is the belt-and-braces visual
//              guarantee for everything else.

const DEBUG_COLOUR = '#00ff00'
const DEBUG_DASH   = [8, 6]
const CROSS_R      = 16

function letterboxBox(): { x: number; y: number; width: number; height: number } | null {
  const r = computeLetterboxRescale()
  if (r === null) return null
  const width  = r.savedCentre.x * 2 * r.scale
  const height = r.savedCentre.y * 2 * r.scale
  return { x: r.newCentre.x - width / 2, y: r.newCentre.y - height / 2, width, height }
}

export function drawLetterboxDebug(ctx: AnyCtx2D): void {
  if (Node.letterboxMode !== 'debug') return
  const box = letterboxBox()
  if (box === null) return
  const cx = box.x + box.width  / 2
  const cy = box.y + box.height / 2

  ctx.save()
  ctx.strokeStyle = DEBUG_COLOUR
  ctx.lineWidth   = 2
  ctx.setLineDash(DEBUG_DASH)
  ctx.strokeRect(box.x, box.y, box.width, box.height)
  ctx.setLineDash([])

  ctx.beginPath()
  ctx.moveTo(cx - CROSS_R, cy); ctx.lineTo(cx + CROSS_R, cy)
  ctx.moveTo(cx, cy - CROSS_R); ctx.lineTo(cx, cy + CROSS_R)
  ctx.stroke()
  ctx.restore()
}

export function drawLetterboxReplayBars(ctx: AnyCtx2D): void {
  if (Node.letterboxMode !== 'replay') return
  const box = letterboxBox()
  if (box === null) return

  // Fill the full canvas black, punching out the letterbox box via the
  // evenodd rule (two overlapping subpaths cancel in their intersection) —
  // orientation-agnostic, so it doesn't matter whether the saved aspect
  // ratio leaves top/bottom or left/right bands.
  ctx.save()
  ctx.fillStyle = '#000'
  ctx.beginPath()
  ctx.rect(0, 0, Node.canvasWidth, Node.canvasHeight)
  ctx.rect(box.x, box.y, box.width, box.height)
  ctx.fill('evenodd')
  ctx.restore()
}
