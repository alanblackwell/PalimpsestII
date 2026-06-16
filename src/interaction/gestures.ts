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

export const MIN_ZOOM      = 0.5  // pinch-in shrinks the canvas to half size, to bring
                                   // content beyond the screen edge into view
export const MAX_ZOOM      = 4
export const ZOOM_SNAP_EPS = 0.05     // snap to scale=1/pan=0 within this margin of scale 1

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

// Clamp `pan` for one axis. `base` is the box's natural (untransformed)
// position, `box` its scaled size, `viewport` the screen size.
//   - When the scaled box is larger than the viewport (zoomed in), the box
//     must always *cover* the viewport — pan is bounded so no background
//     gap appears at either edge.
//   - When the scaled box is smaller than the viewport (zoomed out), the
//     box must stay *contained within* the viewport — pan is bounded so the
//     whole (shrunk) box can be repositioned anywhere on screen, bringing
//     content that was previously off-screen into view.
// Both cases are the same two bounds, `-base` and `viewport - box - base`,
// just in opposite order — so take the min/max of the pair.
function clampPan(pan: number, base: number, box: number, viewport: number): number {
  const a = -base
  const b = viewport - box - base
  return Math.max(Math.min(pan, Math.max(a, b)), Math.min(a, b))
}

// Compute a new CSS transform (translate+scale) from a wheel event.
//   - Without ctrlKey: scroll/pan the canvas by (deltaX, deltaY) in CSS pixels,
//     clamped so the canvas always covers the viewport when zoomed in and stays
//     within it when zoomed out.
//   - With ctrlKey: zoom at the cursor position (trackpad pinch fires as
//     ctrl+wheel in all major browsers on macOS), snapping to identity near 1×.
// `canvasClientW/H` — the canvas's natural (un-transformed) CSS size.
export function computeWheelTransform(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  ctrlKey: boolean,
  clientX: number,
  clientY: number,
  currentScale: number,
  currentPanX: number,
  currentPanY: number,
  canvasClientW: number,
  canvasClientH: number,
  viewport: { width: number; height: number },
): { scale: number; panX: number; panY: number } {
  // Convert wheel delta to CSS pixels (trackpad: mode 0; mouse: mode 1 = lines).
  const lineH  = 14
  const lineW  = 14
  const pxY    = deltaMode === 1 ? deltaY * lineH : deltaMode === 2 ? deltaY * viewport.height : deltaY
  const pxX    = deltaMode === 1 ? deltaX * lineW : deltaMode === 2 ? deltaX * viewport.width  : deltaX

  if (ctrlKey) {
    // Zoom at cursor (trackpad pinch fires as ctrlKey+wheel on macOS).
    const factor   = Math.pow(2, -pxY / 100)
    let newScale   = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentScale * factor))
    if (Math.abs(newScale - 1) < ZOOM_SNAP_EPS) {
      return { scale: 1, panX: 0, panY: 0 }
    }
    // Keep the canvas-local point under the cursor fixed after the zoom.
    const lx       = (clientX - currentPanX) / currentScale
    const ly       = (clientY - currentPanY) / currentScale
    let panX       = clientX - lx * newScale
    let panY       = clientY - ly * newScale
    panX = clampPan(panX, 0, canvasClientW * newScale, viewport.width)
    panY = clampPan(panY, 0, canvasClientH * newScale, viewport.height)
    return { scale: newScale, panX, panY }
  } else {
    // Pan — subtract delta (positive scroll moves canvas opposite direction).
    let panX = clampPan(currentPanX - pxX, 0, canvasClientW * currentScale, viewport.width)
    let panY = clampPan(currentPanY - pxY, 0, canvasClientH * currentScale, viewport.height)
    return { scale: currentScale, panX, panY }
  }
}

// Given a pinch gesture's starting state and the two touch points' current
// positions (client coords), returns the canvas's new CSS transform
// (`translate(panX,panY) scale(scale)`, with transform-origin: 0 0):
//   - scale tracks the change in finger distance, clamped to [MIN_ZOOM,MAX_ZOOM]
//   - pan keeps the canvas-local point under the gesture's starting centroid
//     fixed under the *current* centroid (pinch-to-point + two-finger pan)
//   - pan is clamped per clampPan() above — cover the viewport when zoomed
//     in, stay contained within it when zoomed out
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

  if (Math.abs(scale - 1) < ZOOM_SNAP_EPS) {
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

  // Natural (untransformed) box position.
  const baseLeft = start.rectLeft - start.pan.x
  const baseTop  = start.rectTop  - start.pan.y
  const boxW = start.clientWidth  * scale
  const boxH = start.clientHeight * scale

  panX = clampPan(panX, baseLeft, boxW, viewport.width)
  panY = clampPan(panY, baseTop, boxH, viewport.height)

  return { scale, panX, panY }
}
