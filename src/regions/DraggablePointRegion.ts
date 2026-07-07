import { Region } from '../core/Region.js'
import { ValueType, type Point, type Ctx2D } from '../core/types.js'
import type { Layer } from '../core/Layer.js'

// ------------------------------------------------------------
// DraggablePointRegion — a freely draggable point handle
// ------------------------------------------------------------
//
// Unlike SliderRegion, whose value is a proportion within fixed
// track bounds, DraggablePointRegion lives at the point value
// itself.  Its hit-test bounding box is a small square centred
// on the current point position; this box is re-centred after
// every move so hit-testing always finds the handle.
//
// Rendered appearance:
//
//          |               thin crosshair ticks
//        --⊙--             circle + centre dot
//          |
//
// Interactive (user-draggable): adaptive — bright lavender on dark bg, dark purple on light bg
// Bound (read-only display):    adaptive — light grey on dark bg, near-black on light bg
// Both modes add a contrasting shadow/glow around each element for legibility.

// Radius of the visual circle (px).
const CIRCLE_R = 8

// Length of the crosshair ticks beyond the circle (px).
const TICK_LEN = 7

// Radius of the invisible hit-test zone centred on the point (px).
// Larger than CIRCLE_R so the handle is easy to grab.
const HIT_R = 16

// Promotion factory — set by PointLayer at import time.
type LayerFactory = (initial: Point) => Layer
export let promotionFactory: LayerFactory | null = null
export function registerPromotionFactory(f: LayerFactory): void {
  promotionFactory = f
}

// ------------------------------------------------------------------

export class DraggablePointRegion extends Region {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point])

  private _point: Point

  // Visual display position (may differ from _point when driven by slot).
  displayPoint: Point

  private _interactive = true
  private _dragging    = false

  constructor(parent: Layer, initial: Point = { x: 200, y: 200 }) {
    super(parent)
    this._point      = { ...initial }
    this.displayPoint = { ...initial }
    this._syncBounds()
    this.debugName = 'DraggablePointRegion'
  }

  // ----------------------------------------------------------
  // Value
  // ----------------------------------------------------------

  get point(): Point { return { ...this._point } }

  set interactive(v: boolean) { this._interactive = v }
  override get isInteractive(): boolean { return this._interactive }

  // Called by the parent layer to sync the handle position
  // (either from a slot source or to reflect the layer's own state).
  setPoint(p: Point): void {
    this._point      = { ...p }
    this.displayPoint = { ...p }
    this._syncBounds()
  }

  // ----------------------------------------------------------
  // Pointer interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (!this._interactive) return false
    this._dragging = true
    this._applyPointer(point)
    this.markDirty()
    return true
  }

  handlePointerMove(point: Point): void {
    if (!this._dragging) return
    this._applyPointer(point)
    this.markDirty()
  }

  handlePointerUp(): void {
    this._dragging = false
    this.markDirty()
  }

  private _applyPointer(point: Point): void {
    this.setPoint(point)
    // Notify the parent layer so it propagates the change.
    const p = this.parentLayer as Record<string, unknown>
    if (typeof p['setPoint'] === 'function') {
      (p['setPoint'] as (pt: Point) => void)(point)
    }
  }

  // ----------------------------------------------------------
  // Promotion
  // ----------------------------------------------------------

  override promoteToLayer(): Layer {
    if (promotionFactory === null) {
      throw new Error(
        'DraggablePointRegion: promotionFactory not registered. ' +
        'Import PointLayer before calling promoteToLayer().'
      )
    }
    return promotionFactory(this._point)
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    // Value is set externally (by parent layer or user interaction).
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    const { x, y } = this.displayPoint

    // Sample the single pixel under the handle centre for adaptive contrast.
    // Perceptual luminance; alpha-composite over black (transparent = dark).
    let brightness = 0.2
    try {
      const d  = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data
      const a  = d[3]! / 255
      brightness = (d[0]! * 0.299 + d[1]! * 0.587 + d[2]! * 0.114) / 255 * a
    } catch { /* cross-origin or out-of-bounds — keep default */ }

    const lightBg = brightness > 0.5

    // Dark background → bright accent + dark shadow (separates from textures).
    // Light background → dark accent + white glow (reads against brightness).
    const markCol = this._interactive
      ? (lightBg ? '#5c1a5c' : '#e0a0e0')
      : (lightBg ? '#2a1a2a' : '#a89aa8')
    const haloCol = lightBg ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)'

    ctx.save()
    ctx.lineCap = 'round'

    // Drag highlight ring
    if (this._dragging) {
      ctx.strokeStyle = lightBg ? 'rgba(0,0,0,0.30)' : 'rgba(255,255,255,0.45)'
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.arc(x, y, CIRCLE_R + 4.5, 0, Math.PI * 2)
      ctx.stroke()
    }

    // All marker elements share the same halo (shadow/glow behind each stroke).
    ctx.shadowColor   = haloCol
    ctx.shadowBlur    = 3.5
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0

    // Circle
    ctx.strokeStyle = markCol
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.arc(x, y, CIRCLE_R, 0, Math.PI * 2)
    ctx.stroke()

    // Crosshair ticks (N / S / W / E)
    const gap = CIRCLE_R + 2
    const tip = CIRCLE_R + 2 + TICK_LEN
    ;[
      [x, y - gap, x, y - tip],
      [x, y + gap, x, y + tip],
      [x - gap, y, x - tip, y],
      [x + gap, y, x + tip, y],
    ].forEach(([x0, y0, x1, y1]) => {
      ctx.beginPath(); ctx.moveTo(x0!, y0!); ctx.lineTo(x1!, y1!); ctx.stroke()
    })

    // Centre dot
    ctx.fillStyle = markCol
    ctx.beginPath()
    ctx.arc(x, y, 2.5, 0, Math.PI * 2)
    ctx.fill()

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Private
  // ----------------------------------------------------------

  private _syncBounds(): void {
    this.bounds = {
      x:      this._point.x - HIT_R,
      y:      this._point.y - HIT_R,
      width:  HIT_R * 2,
      height: HIT_R * 2,
    }
  }
}
