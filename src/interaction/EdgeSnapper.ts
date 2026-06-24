// EdgeSnapper — shared utilities for snapping drag handles to edges of nearby layers.
//
// Snap candidates come from up to `maxCount` non-hidden layers immediately below
// the dragging layer. For each target layer, three x and three y candidates are
// collected: left/center/right and top/center/bottom of its AABB.
//
// Snap is applied independently on x and y with a simple distance threshold
// (no dwell). The snapped coordinate is returned together with the candidate it
// latched to, which is used to draw a guide line across the canvas.
//
// For position/move handles (which move the whole layer) the caller should pass
// own-edge offsets so that any edge of the dragged layer can align with any edge
// of a target layer, not just the center. For boundary handles (which move a
// single edge or point) pass [0] for both offsetsX and offsetsY.

import { Layer } from '../core/Layer.js'
import { type Point, type Ctx2D } from '../core/types.js'

export const EDGE_SNAP_THRESHOLD = 10  // pixels

export interface SnapEdges {
  xs: number[]  // candidate x values (positions for vertical guide lines)
  ys: number[]  // candidate y values (positions for horizontal guide lines)
}

/** Collect edge candidates from up to maxCount non-hidden layers below `from`. */
export function collectSnapEdges(from: Layer, maxCount = 3): SnapEdges {
  const xs: number[] = []
  const ys: number[] = []
  let layer = from.layerBelow
  let found = 0
  while (layer !== null && found < maxCount) {
    if (!layer.isHiddenHelper && !layer.outsideStack) {
      const b = layer.getSnapBounds()
      if (b !== null) {
        xs.push(b.minX, (b.minX + b.maxX) / 2, b.maxX)
        ys.push(b.minY, (b.minY + b.maxY) / 2, b.maxY)
        found++
      }
    }
    layer = layer.layerBelow
  }
  return { xs, ys }
}

/** Snap a single coordinate to the nearest candidate within threshold.
 *  offsetsToTest: for position-handle snap, own edge offsets from the dragged
 *  coordinate. E.g. if the layer is 100px wide, pass [-50, 0, 50] so any of its
 *  three x-edges can align with any candidate.
 *  Returns the snapped output and the candidate coordinate it latched to (for the
 *  guide line), or null if nothing is within threshold. */
export function snapCoord(
  value:          number,
  candidates:     number[],
  threshold:      number,
  offsetsToTest:  number[] = [0],
): { out: number; snapLine: number | null } {
  let bestDist  = threshold + 1
  let out       = value
  let snapLine: number | null = null

  for (const c of candidates) {
    for (const off of offsetsToTest) {
      const d = Math.abs(value - (c - off))
      if (d < bestDist) {
        bestDist = d
        out      = c - off
        snapLine = c
      }
    }
  }
  return { out, snapLine }
}

/** Snap a point's x and y independently. Convenience wrapper around snapCoord. */
export function snapPointToEdges(
  pt:          Point,
  edges:       SnapEdges,
  threshold =  EDGE_SNAP_THRESHOLD,
  offsetsX:    number[] = [0],
  offsetsY:    number[] = [0],
): { x: number; y: number; snapLineX: number | null; snapLineY: number | null } {
  const rx = snapCoord(pt.x, edges.xs, threshold, offsetsX)
  const ry = snapCoord(pt.y, edges.ys, threshold, offsetsY)
  return { x: rx.out, y: ry.out, snapLineX: rx.snapLine, snapLineY: ry.snapLine }
}

/** Draw thin dashed guide lines through snapped edge positions. */
export function drawSnapGuides(
  ctx:          Ctx2D,
  snapLineX:    number | null,
  snapLineY:    number | null,
  canvasWidth:  number,
  canvasHeight: number,
): void {
  if (snapLineX === null && snapLineY === null) return
  ctx.save()
  ctx.strokeStyle = '#7ecfcf'
  ctx.lineWidth   = 1
  ctx.globalAlpha = 0.55
  ctx.setLineDash([4, 4])
  if (snapLineX !== null) {
    ctx.beginPath()
    ctx.moveTo(snapLineX, 0)
    ctx.lineTo(snapLineX, canvasHeight)
    ctx.stroke()
  }
  if (snapLineY !== null) {
    ctx.beginPath()
    ctx.moveTo(0,           snapLineY)
    ctx.lineTo(canvasWidth, snapLineY)
    ctx.stroke()
  }
  ctx.restore()
}
