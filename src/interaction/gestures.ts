import type { Point } from '../core/types.js'

// ------------------------------------------------------------
// gestures.ts — pure helper math for touch gesture recognition
// ------------------------------------------------------------
//
// Used by InteractionSystem to classify single-finger swipes and to
// compute the canvas's CSS transform for the pinch-to-zoom magnifier.
// No DOM access and no mutable state, so the logic can be read (and
// tuned) independently of the pointer-tracking plumbing.

export const SWIPE_DISTANCE    = 40   // px, min displacement to count as a swipe
export const SWIPE_AXIS_RATIO  = 1.5  // dominant axis must exceed the other by this factor
export const TAP_MAX_MOVEMENT  = 10   // px, max movement to still count as a tap
export const TWO_FINGER_TAP_MS = 300  // max duration for a two-finger tap

// A deferred single-finger touch held for this long without lifting (and
// without a second touch arriving) is "promoted" to a drag — a node
// handle/slider/mask-paint drag, or the stack widget's reorder drag. A fast
// swipe released before this elapses keeps swipe priority over either.
export const PROMOTE_MS = 150

export const MIN_ZOOM      = 1
export const MAX_ZOOM      = 4
export const ZOOM_SNAP_EPS = 0.05     // snap back to scale=1/pan=0 within this margin

export type SwipeDir = 'up' | 'down' | 'left' | 'right' | null

// Classify a single-finger gesture's total displacement as a swipe in one
// of the four cardinal directions, or null if it's too short or too
// diagonal to be unambiguous (and should be treated as a tap/click instead).
export function classifySwipe(dx: number, dy: number): SwipeDir {
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  if (adx < SWIPE_DISTANCE && ady < SWIPE_DISTANCE) return null
  if (adx > ady * SWIPE_AXIS_RATIO) return dx > 0 ? 'right' : 'left'
  if (ady > adx * SWIPE_AXIS_RATIO) return dy > 0 ? 'down' : 'up'
  return null
}

// State captured at the moment a second touch lands on the main canvas,
// used as the baseline for computePinchTransform.
export interface PinchStart {
  distance: number      // distance between the two touch points (client px)
  centroid: Point        // midpoint between the two touch points (client px)
  scale: number          // canvas CSS transform scale at gesture start
  pan: Point             // canvas CSS transform translate at gesture start (px)
  rectLeft: number       // canvas.getBoundingClientRect().left at gesture start
  rectTop: number        // canvas.getBoundingClientRect().top at gesture start
  clientWidth: number    // canvas.clientWidth (unscaled)
  clientHeight: number   // canvas.clientHeight (unscaled)
}

// Given a pinch gesture's starting state and the two touch points' current
// positions (client coords), returns the canvas's new CSS transform
// (`translate(panX,panY) scale(scale)`, with transform-origin: 0 0):
//   - scale tracks the change in finger distance, clamped to [MIN_ZOOM,MAX_ZOOM]
//   - pan keeps the canvas-local point under the gesture's starting centroid
//     fixed under the *current* centroid (pinch-to-point + two-finger pan)
//   - pan is clamped so the scaled canvas box still covers the viewport
//   - snaps to the identity transform (scale=1, pan=0) near scale=1
export function computePinchTransform(
  start: PinchStart,
  current: [Point, Point],
  viewport: { width: number; height: number },
): { scale: number; panX: number; panY: number } {
  const distNow = Math.hypot(current[1].x - current[0].x, current[1].y - current[0].y)
  const centroidNow: Point = {
    x: (current[0].x + current[1].x) / 2,
    y: (current[0].y + current[1].y) / 2,
  }

  let scale = start.scale * (distNow / Math.max(1, start.distance))
  scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale))

  if (scale < MIN_ZOOM + ZOOM_SNAP_EPS) {
    return { scale: 1, panX: 0, panY: 0 }
  }

  // Canvas-local point under the gesture's starting centroid.
  const lx = (start.centroid.x - start.rectLeft) / start.scale
  const ly = (start.centroid.y - start.rectTop)  / start.scale

  // Keep that point under the current centroid.
  const newLeft = centroidNow.x - lx * scale
  const newTop  = centroidNow.y - ly * scale

  let panX = start.pan.x + (newLeft - start.rectLeft)
  let panY = start.pan.y + (newTop  - start.rectTop)

  // Natural (untransformed) box position — clamp pan so the scaled box
  // still covers the viewport (no gaps to the page background).
  const baseLeft = start.rectLeft - start.pan.x
  const baseTop  = start.rectTop  - start.pan.y
  const boxW = start.clientWidth  * scale
  const boxH = start.clientHeight * scale

  const maxPanX = -baseLeft
  const minPanX = viewport.width  - boxW - baseLeft
  const maxPanY = -baseTop
  const minPanY = viewport.height - boxH - baseTop

  panX = Math.max(Math.min(panX, maxPanX), minPanX)
  panY = Math.max(Math.min(panY, maxPanY), minPanY)

  return { scale, panX, panY }
}
