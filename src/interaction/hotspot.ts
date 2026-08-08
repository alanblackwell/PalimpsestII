import type { Node } from '../core/Node.js'
import type { Ctx2D } from '../core/types.js'

// ------------------------------------------------------------
// Shared hotspot math + rendering — used by LayerStackWidget (on-stack
// layers), DeletionLayer (the Background collection), and BindingMapLayer
// (comparing one source against its consumers) — so every "notice"/"locate"
// signal in the app stays numerically and visually consistent regardless of
// what's actually costing the frame rate. evalCostMs lives on Node, not
// Layer, so the math here is expressed in terms of Node throughout — most
// callers happen to pass Layers, but BindingMapLayer's source/consumer
// references are plain Nodes. Full design rationale and revision history:
// spec/live-performance-hotspots.md.
// ------------------------------------------------------------

// Bright, saturated red shared by the strip's load bar and every glow —
// distinct from the strip's old (now-retired) dark/desaturated hue-ramp
// colour, which had to stay muted to avoid reading as a 12th ValueType
// accent; a bar/glow is load-encoded emphasis on top of existing content,
// not an identity colour, so it can afford to be punchier.
export const HOTSPOT_RGB = '255,50,50'
export const HOTSPOT_GLOW_BLUR = 24

// "Video looks very jerky" calibration for the strip's load bar (and, by
// the same scale, any Background-collection glow): 0 at a 30fps floor
// (cost this small isn't yet a visible smoothness concern), 1 at a 10fps
// ceiling. evalCostMs only measures recompute() self-time, not canvas
// rendering cost, so this is an approximation — see the spec doc's open
// questions.
export const HOTSPOT_BAR_START_FPS = 30
export const HOTSPOT_BAR_JERKY_FPS = 10
export const HOTSPOT_BAR_START_MS  = 1000 / HOTSPOT_BAR_START_FPS
export const HOTSPOT_BAR_JERKY_MS  = 1000 / HOTSPOT_BAR_JERKY_FPS

/** Sum of Node.evalCostMs across `nodes`. */
export function sumEvalCost(nodes: readonly Node[]): number {
  let total = 0
  for (const n of nodes) total += n.evalCostMs
  return total
}

/** 0 at/below HOTSPOT_BAR_START_MS, 1 at/above HOTSPOT_BAR_JERKY_MS. */
export function hotspotBarFraction(totalMs: number): number {
  if (totalMs <= HOTSPOT_BAR_START_MS) return 0
  return Math.max(0, Math.min(1,
    (totalMs - HOTSPOT_BAR_START_MS) / (HOTSPOT_BAR_JERKY_MS - HOTSPOT_BAR_START_MS)))
}

// Worst node among `nodes` by share of their combined evalCostMs, rescaled
// so an even split across all of them maps to load 0 and one node owning
// their entire combined cost maps to load 1. A lone node is trivially
// "worst" at load 1 (nothing to rank it against, but whatever cost exists
// is unambiguously its own); an empty list has no worst node.
export function hotspotWorst(nodes: readonly Node[]): { node: Node | null; load: number } {
  if (nodes.length === 0) return { node: null, load: 0 }
  if (nodes.length === 1) {
    const only = nodes[0]!
    return only.evalCostMs > 0 ? { node: only, load: 1 } : { node: null, load: 0 }
  }
  const n = nodes.length
  let total = 0
  let worst: Node | null = null
  let worstCost = 0
  for (const nd of nodes) {
    const c = nd.evalCostMs
    total += c
    if (c > worstCost) { worstCost = c; worst = nd }
  }
  if (total <= 0) return { node: null, load: 0 }
  const share    = worstCost / total
  const baseline = 1 / n
  const load     = Math.max(0, Math.min(1, (share - baseline) / (1 - baseline)))
  return { node: worst, load }
}

// Cast the standard glow halo into the current 0,0..w,h rect — a filled
// shape (rect, or rounded rect when `radius` is given) with shadowBlur set
// and shadowOffset zero, whose own fill is invisible once something opaque
// (a thumbnail) is drawn over the same footprint right after; only the
// blurred outward bleed past that shape remains visible, giving a true
// gaussian falloff with no crisp ring and an inner edge flush with
// whatever it's glowing. intensity <= 0 draws nothing.
export function drawHotspotGlow(
  ctx: Ctx2D, w: number, h: number, intensity: number, radius = 0,
): void {
  if (intensity <= 0) return
  ctx.save()
  ctx.shadowColor   = `rgba(${HOTSPOT_RGB},${(0.4 + intensity * 0.5).toFixed(2)})`
  ctx.shadowBlur    = HOTSPOT_GLOW_BLUR
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0
  ctx.fillStyle     = `rgba(${HOTSPOT_RGB},1)`
  if (radius > 0) {
    ctx.beginPath()
    ctx.roundRect(0, 0, w, h, radius)
    ctx.fill()
  } else {
    ctx.fillRect(0, 0, w, h)
  }
  ctx.restore()
}
