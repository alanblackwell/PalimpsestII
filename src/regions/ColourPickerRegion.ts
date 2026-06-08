import { Region } from '../core/Region.js'
import { ValueType, boundingBoxContains, type Colour, type Ctx2D, type Point, type BoundingBox } from '../core/types.js'
import type { Layer } from '../core/Layer.js'

// ------------------------------------------------------------
// ColourPickerRegion — HSV colour picker widget
// ------------------------------------------------------------
//
// Layout (top-to-bottom within bounds):
//
//   ┌─────────────────────────────────────────┐
//   │                                         │
//   │   Saturation / Value square             │
//   │   (horizontal = sat, vertical = val)    │
//   │                                         │
//   ├─────────────────────────────────────────┤ ← GAP
//   │ Hue strip (rainbow spectrum)            │
//   └─────────────────────────────────────────┘
//
// When isInteractive = false (bound), the picker shows the current
// colour but does not respond to pointer events.

const HUE_H  = 16   // height of the hue strip in px
const GAP    = 4    // gap between SV square and hue strip

type DragZone = 'hue' | 'sv' | null

// Promotion factory — set by ColourLayer at import time.
type LayerFactory = (initial: Colour) => Layer
export let promotionFactory: LayerFactory | null = null
export function registerPromotionFactory(f: LayerFactory): void {
  promotionFactory = f
}

// ------------------------------------------------------------------
// HSV ↔ RGB helpers
// ------------------------------------------------------------------

function hsvToRgb(h: number, s: number, v: number): Colour {
  // h: [0, 360), s: [0, 1], v: [0, 1]
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if      (h < 60)  { r = c; g = x; b = 0 }
  else if (h < 120) { r = x; g = c; b = 0 }
  else if (h < 180) { r = 0; g = c; b = x }
  else if (h < 240) { r = 0; g = x; b = c }
  else if (h < 300) { r = x; g = 0; b = c }
  else              { r = c; g = 0; b = x }
  return { r: r + m, g: g + m, b: b + m, a: 1 }
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d   = max - min
  const v   = max
  const s   = max === 0 ? 0 : d / max
  let h = 0
  if (d !== 0) {
    if      (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else                h = (r - g) / d + 4
    h = h * 60
    if (h < 0) h += 360
  }
  return [h, s, v]
}

function colourToCss(c: Colour): string {
  const r = Math.round(c.r * 255)
  const g = Math.round(c.g * 255)
  const b = Math.round(c.b * 255)
  return `rgb(${r},${g},${b})`
}

// ------------------------------------------------------------------
// ColourPickerRegion
// ------------------------------------------------------------------

export class ColourPickerRegion extends Region {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Colour])

  private _hue: number = 0    // [0, 360)
  private _sat: number = 1    // [0, 1]
  private _val: number = 1    // [0, 1]

  // Visual display colour (may differ from _hue/_sat/_val when bound).
  displayColour: Colour = { r: 1, g: 0, b: 0, a: 1 }

  private _interactive = true
  private _dragZone: DragZone = null

  constructor(parent: Layer, initial: Colour = { r: 1, g: 0, b: 0, a: 1 }) {
    super(parent)
    ;[this._hue, this._sat, this._val] = rgbToHsv(initial.r, initial.g, initial.b)
    this.displayColour = { ...initial }
    this.debugName = 'ColourPickerRegion'
  }

  // Current HSV-derived colour (always up to date with user drags).
  get colour(): Colour { return hsvToRgb(this._hue, this._sat, this._val) }

  // ----------------------------------------------------------
  // Interactive state
  // ----------------------------------------------------------

  set interactive(v: boolean) { this._interactive = v }
  override get isInteractive(): boolean { return this._interactive }

  // Called by parent layer to sync display when the slot is active.
  setDisplayColour(c: Colour): void {
    this.displayColour = c
    ;[this._hue, this._sat, this._val] = rgbToHsv(c.r, c.g, c.b)
  }

  // ----------------------------------------------------------
  // Zone geometry
  // ----------------------------------------------------------

  private _svBounds(): BoundingBox {
    const { x, y, width, height } = this.bounds
    return { x, y, width, height: Math.max(0, height - HUE_H - GAP) }
  }

  private _hueBounds(): BoundingBox {
    const { x, y, width, height } = this.bounds
    return { x, y: y + height - HUE_H, width, height: HUE_H }
  }

  // ----------------------------------------------------------
  // Pointer interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (!this._interactive) return false
    if (boundingBoxContains(this._hueBounds(), point)) {
      this._dragZone = 'hue'
      this._applyHueDrag(point.x)
    } else if (boundingBoxContains(this._svBounds(), point)) {
      this._dragZone = 'sv'
      this._applySvDrag(point.x, point.y)
    } else {
      return false
    }
    this.markDirty()
    return true
  }

  handlePointerMove(point: Point): void {
    if      (this._dragZone === 'hue') this._applyHueDrag(point.x)
    else if (this._dragZone === 'sv')  this._applySvDrag(point.x, point.y)
    else return
    this.markDirty()
  }

  handlePointerUp(): void {
    this._dragZone = null
    this.markDirty()
  }

  private _applyHueDrag(px: number): void {
    const { x, width } = this._hueBounds()
    if (width <= 0) return
    this._hue = Math.max(0, Math.min(359.99, ((px - x) / width) * 360))
    this._notifyParent()
  }

  private _applySvDrag(px: number, py: number): void {
    const sv = this._svBounds()
    if (sv.width <= 0 || sv.height <= 0) return
    this._sat = Math.max(0, Math.min(1, (px - sv.x) / sv.width))
    this._val = Math.max(0, Math.min(1, 1 - (py - sv.y) / sv.height))
    this._notifyParent()
  }

  private _notifyParent(): void {
    const c = hsvToRgb(this._hue, this._sat, this._val)
    this.displayColour = c
    const p = this.parentLayer as Record<string, unknown>
    if (typeof p['setColour'] === 'function') {
      (p['setColour'] as (c: Colour) => void)(c)
    }
  }

  // ----------------------------------------------------------
  // Promotion
  // ----------------------------------------------------------

  override promoteToLayer(): Layer {
    if (promotionFactory === null) {
      throw new Error(
        'ColourPickerRegion: promotionFactory not registered. ' +
        'Import ColourLayer before calling promoteToLayer().'
      )
    }
    return promotionFactory(this.colour)
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
    const sv = this._svBounds()
    const hb = this._hueBounds()
    if (sv.width <= 0 || hb.width <= 0) return

    ctx.save()

    // ── SV square ──────────────────────────────────────────
    if (sv.height > 0) {
      const pureHue = colourToCss(hsvToRgb(this._hue, 1, 1))

      // Horizontal: white → pure hue (saturation axis)
      const gradS = ctx.createLinearGradient(sv.x, sv.y, sv.x + sv.width, sv.y)
      gradS.addColorStop(0, '#ffffff')
      gradS.addColorStop(1, pureHue)
      ctx.fillStyle = gradS
      ctx.fillRect(sv.x, sv.y, sv.width, sv.height)

      // Vertical: transparent → black (value axis)
      const gradV = ctx.createLinearGradient(sv.x, sv.y, sv.x, sv.y + sv.height)
      gradV.addColorStop(0, 'rgba(0,0,0,0)')
      gradV.addColorStop(1, 'rgba(0,0,0,1)')
      ctx.fillStyle = gradV
      ctx.fillRect(sv.x, sv.y, sv.width, sv.height)

      // Cursor — small circle at (sat, 1-val)
      const cx = sv.x + this._sat * sv.width
      const cy = sv.y + (1 - this._val) * sv.height
      const cursorR = 5
      ctx.strokeStyle = this._val > 0.5 ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.8)'
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.arc(cx, cy, cursorR, 0, Math.PI * 2)
      ctx.stroke()
      if (this._dragZone === 'sv') {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)'
        ctx.lineWidth   = 1.5
        ctx.beginPath()
        ctx.arc(cx, cy, cursorR + 3, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // ── Hue strip ──────────────────────────────────────────
    {
      const gradHue = ctx.createLinearGradient(hb.x, hb.y, hb.x + hb.width, hb.y)
      for (let i = 0; i <= 6; i++) {
        gradHue.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`)
      }
      const r = Math.min(HUE_H / 2, 4)
      ctx.fillStyle = gradHue
      ctx.beginPath()
      ctx.roundRect(hb.x, hb.y, hb.width, hb.height, r)
      ctx.fill()

      // Hue thumb — vertical line with circle
      const tx = hb.x + (this._hue / 360) * hb.width
      const midY = hb.y + hb.height / 2
      const tR   = Math.min(hb.height / 2 - 1, 6)

      ctx.fillStyle   = '#ffffff'
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.arc(tx, midY, tR, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()

      if (this._dragZone === 'hue') {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)'
        ctx.lineWidth   = 1.5
        ctx.beginPath()
        ctx.arc(tx, midY, tR + 2.5, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    ctx.restore()
  }
}
