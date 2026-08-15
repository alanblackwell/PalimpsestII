import { Node } from '../core/Node.js'
import { Layer } from '../core/Layer.js'
import { VideoLayer, BAR_MARGIN, BAR_H, CBTN_H, CBTN_BAR_GAP } from '../layers/VideoLayer.js'
import { graph } from '../dataflow/Graph.js'
import { contentLeft } from './layout.js'
import { boundingBoxContains, type BoundingBox, type Ctx2D, type Point } from '../core/types.js'

// ------------------------------------------------------------
// videoRelinkPrompt — "reload the video" bar for layers whose visible
// content depends on a VideoLayer that's hidden (Background collection or
// DeletionLayer's archive) and needs relinking after a session reload.
// ------------------------------------------------------------
//
// VideoLayer already shows its own "Missing: ‹filename› — click File to
// relink" bar when it's the selected layer (see _renderControlBar in
// VideoLayer.ts) — but a hidden VideoLayer can never be selected directly,
// so anything downstream of it (e.g. a FilterLayer or ClipLayer bound to
// its image output) would otherwise give no clue that a relink is needed.
// This module finds that situation for whichever layer is currently
// selected, and renders/hit-tests a banner at exactly the same size and
// screen position as VideoLayer's own missing-file bar (bottom of the
// viewport, above where the Track/Event convenience-button row would sit),
// so a user recognises it as the same thing regardless of which layer
// happens to be selected when it appears.

// Finds a hidden VideoLayer that `layer`'s visible content transitively
// depends on (via ParameterSlot bindings) and that needs relinking, or null
// if none applies. Only *hidden* dependencies are reported — a VideoLayer
// still reachable on the main stack already shows its own bar directly when
// selected, so surfacing it here too would just be redundant clutter.
export function findMissingVideoDependency(layer: Layer): VideoLayer | null {
  for (const node of graph.topologicalOrder([layer])) {
    if (node instanceof VideoLayer && node.needsRelink && node.outsideStack) return node
  }
  return null
}

export function relinkBarBounds(canvasWidth: number): BoundingBox {
  const left = contentLeft(canvasWidth)
  const y    = Node.viewportHeight - BAR_H - BAR_MARGIN - CBTN_BAR_GAP - CBTN_H
  return { x: left, y, width: canvasWidth - left - BAR_MARGIN, height: BAR_H }
}

export function renderRelinkBar(ctx: Ctx2D, bounds: BoundingBox, video: VideoLayer): void {
  const { x, y, width, height } = bounds
  if (width <= 0) return
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.beginPath()
  ctx.roundRect(x, y, width, height, height / 2)
  ctx.fill()
  ctx.font         = '11px sans-serif'
  ctx.fillStyle    = 'rgba(255,255,255,0.75)'
  ctx.textAlign    = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(`Missing: ${video.filename || 'video'} — click to relink`, x + 12, y + height / 2)
  ctx.restore()
}

export function hitTestRelinkBar(bounds: BoundingBox, point: Point): boolean {
  return boundingBoxContains(bounds, point)
}
