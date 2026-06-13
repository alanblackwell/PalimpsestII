import { Layer } from '../core/Layer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type Colour, type ColourSource,
  type AmountSource, type PointSource,
  type ImageSource,
  type EventValue, type EventSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { ColourPickerRegion, registerPromotionFactory } from '../regions/ColourPickerRegion.js'
import { BindingLayer } from './BindingLayer.js'

// ------------------------------------------------------------
// ColourLayer — a layer that holds and exposes a Colour value
// ------------------------------------------------------------
//
// Operating modes:
//
//   Unbound  — the HSV picker is fully interactive; the user
//              drags the SV square and hue strip to set the colour.
//
//   Bound    — the colour is driven by a source layer (the slot);
//              the picker displays the incoming value read-only.
//
// Two further input slots provide independent control over part of
// the picker, and only apply when the Colour slot above is unbound:
//
//   hue slot (Amount) — drives the hue strip; amount [0, 1] -> [0, 360)
//   position slot (Point) — drives the SV cursor; canvas coordinates
//                            map onto the SV square (x -> saturation,
//                            y -> value, inverted)
//
// Dragging the hue strip or SV square while the corresponding slot
// is active suspends that binding, returning control to the user.
//
// Visual layout (within bounds):
//
//   ┌───────────────────────────────────┐
//   │ ╔═══════════════════════════════╗ │
//   │ ║  SV square (main area)        ║ │
//   │ ╚═══════════════════════════════╝ │
//   │ ████████████ hue strip ██████████ │
//   │ #ff6a2b                           │ ← hex label
//   └───────────────────────────────────┘

// ── Sample pill constants ────────────────────────────────────────
const IMG_ACCENT = '#7ecf7e'   // Image type accent
const PT_ACCENT  = '#cf7ecf'   // Point type accent
const EV_ACCENT  = '#e0e060'   // Event type accent

const SAMPLE_RADIUS_MIN = 2     // px
const SAMPLE_RADIUS_MAX = 100   // px
const SAMPLE_PAD        = 10
const SAMPLE_ROW_H      = 30
const SAMPLE_ROW_GAP    = 4
const SAMPLE_PILL_H     = SAMPLE_PAD * 2 + SAMPLE_ROW_H * 2 + SAMPLE_ROW_GAP
const SAMPLE_BTN_SZ     = SAMPLE_ROW_H - 8

registerPromotionFactory((initial: Colour) => new ColourLayer(initial))

export class ColourLayer extends Layer implements ColourSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Colour])

  private readonly _slot:    ParameterSlot   // Colour input
  private readonly _hueSlot: ParameterSlot   // Amount → hue
  private readonly _posSlot: ParameterSlot   // Point  → SV position

  private readonly _picker: ColourPickerRegion
  private _colour: Colour

  // ── Image-sample pill ────────────────────────────────────────
  private readonly _sampleImageSlot:  ParameterSlot   // Image input for sampling
  private readonly _samplePointSlot:  ParameterSlot   // Point input for sample location
  private readonly _sampleEnableSlot: ParameterSlot   // Event → toggle sampling on/off

  private _sampleEnabled = false
  private _sampleRadius  = 20   // px
  private _lastSampleEventTime: EventValue = null

  private _sampleSliderDrag  = false
  private _sampleToggleBounds: { x: number; y: number; width: number; height: number } | null = null

  private static readonly PAD_X    = 10
  private static readonly PAD_Y    = 8
  private static readonly LABEL_H  = 18  // space reserved at bottom for hex label

  constructor(initial: Colour = { r: 1, g: 0.42, b: 0.17, a: 1 }) {
    super()
    this._colour  = { ...initial }
    this._slot    = new ParameterSlot(ValueType.Colour, this)
    this._hueSlot = new ParameterSlot(ValueType.Amount, this, 'hue')
    this._posSlot = new ParameterSlot(ValueType.Point,  this, 'position')
    this._picker  = new ColourPickerRegion(this, initial)
    this._sampleImageSlot  = new ParameterSlot(ValueType.Image, this, 'sample image')
    this._samplePointSlot  = new ParameterSlot(ValueType.Point, this, 'sample point')
    this._sampleEnableSlot = new ParameterSlot(ValueType.Event, this, 'sample enable')
    this.slots.push(this._slot, this._hueSlot, this._posSlot,
                    this._sampleImageSlot, this._samplePointSlot, this._sampleEnableSlot)
    this._picker.setOnHueDragStart(() => this._suspendSlot(this._hueSlot))
    this._picker.setOnSvDragStart(() => this._suspendSlot(this._posSlot))
    this.debugName = 'ColourLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ColourSource
  // ----------------------------------------------------------

  getColour(): Colour { return { ...this._colour } }

  // ----------------------------------------------------------
  // Value
  // ----------------------------------------------------------

  // Called by the embedded picker when the user drags.
  setColour(c: Colour): void {
    this._colour = { ...c }
    this.markDirty()
  }

  get slot(): ParameterSlot { return this._slot }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._slot.isActive) {
      const src = this._slot.source as ColourSource
      this._colour = src.getColour()
      this._picker.setDisplayColour(this._colour)
      this._picker.interactive = false
    } else {
      this._picker.interactive = true

      const hueActive = this._hueSlot.isActive
      const posActive = this._posSlot.isActive

      if (hueActive) {
        const amt = (this._hueSlot.source as AmountSource).getAmount()
        this._picker.setHue(amt * 360)
      }
      if (posActive) {
        const pt  = (this._posSlot.source as PointSource).getPoint()
        const sat = pt.x / Node.canvasWidth
        const val = 1 - pt.y / Node.canvasHeight
        this._picker.setSatVal(sat, val)
      }

      this._picker.hueInteractive = !hueActive
      this._picker.svInteractive  = !posActive

      this._colour = { ...this._picker.colour }
      this._picker.displayColour = this._colour
    }

    // Rising edge on sampleEnableSlot flips _sampleEnabled.
    if (this._sampleEnableSlot.isActive) {
      const t = (this._sampleEnableSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastSampleEventTime) {
        this._lastSampleEventTime = t
        this._sampleEnabled = !this._sampleEnabled
      }
    }

    // When enabled, an image sample overrides the colour computed above.
    // If sampling is unavailable (no source bound, or fully transparent
    // sample area), fall back to the colour already computed.
    if (this._sampleEnabled) {
      const sampled = this._sampleFromImage()
      if (sampled !== null) {
        this._colour = sampled
        this._picker.setDisplayColour(this._colour)
        this._picker.interactive = false
      }
    }

    this._syncPickerBounds()
  }

  // Suspend an active binding so the picker can take over that zone.
  private _suspendSlot(slot: ParameterSlot): void {
    if (slot.isActive) BindingLayer.findForSlot(slot)?.toggle()
  }

  // Alpha-weighted average colour of pixels within _sampleRadius of the
  // bound sample point, read from the bound sample image. Returns null if
  // either slot is unbound, the image is unavailable, or the sampled area
  // is fully transparent.
  private _sampleFromImage(): Colour | null {
    if (!this._sampleImageSlot.isActive || !this._samplePointSlot.isActive) return null

    const img = (this._sampleImageSlot.source as ImageSource).getImage()
    if (img === null) return null

    const pt = (this._samplePointSlot.source as PointSource).getPoint()

    const sw = img.width
    const sh = img.height
    if (sw <= 0 || sh <= 0) return null

    let data: Uint8ClampedArray
    if (img instanceof OffscreenCanvas) {
      data = img.getContext('2d')!.getImageData(0, 0, sw, sh).data
    } else {
      const tmp  = new OffscreenCanvas(sw, sh)
      const tctx = tmp.getContext('2d')!
      tctx.drawImage(img, 0, 0)
      data = tctx.getImageData(0, 0, sw, sh).data
    }

    const r  = this._sampleRadius
    const r2 = r * r
    const cx = Math.round(pt.x)
    const cy = Math.round(pt.y)
    const x0 = Math.max(0, cx - r)
    const x1 = Math.min(sw - 1, cx + r)
    const y0 = Math.max(0, cy - r)
    const y1 = Math.min(sh - 1, cy + r)

    let sumR = 0, sumG = 0, sumB = 0, sumA = 0, count = 0

    for (let y = y0; y <= y1; y++) {
      const dy = y - cy
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx
        if (dx * dx + dy * dy > r2) continue
        const i = (y * sw + x) * 4
        const a = data[i + 3]! / 255
        sumR += data[i]!     * a
        sumG += data[i + 1]! * a
        sumB += data[i + 2]! * a
        sumA += a
        count++
      }
    }

    if (count === 0 || sumA === 0) return null

    return {
      r: (sumR / sumA) / 255,
      g: (sumG / sumA) / 255,
      b: (sumB / sumA) / 255,
      a: sumA / count,
    }
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width <= 0 || this.bounds.height <= 0) return
    this._drawPill(ctx, { x: 300, y: 50, width: 260, height: this.bounds.height })
    this._drawSamplePill(ctx)
  }

  // Slot rows are drawn below the sample pill, not directly below the
  // main colour-picker pill.
  override get panelBottom(): number {
    const sb = this._samplePillBounds()
    return sb.y + sb.height + 8
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b

    // Update picker bounds to this pill's position
    const px = ColourLayer.PAD_X
    const py = ColourLayer.PAD_Y
    const lh = ColourLayer.LABEL_H
    this._picker.bounds = {
      x:      x + px,
      y:      y + py,
      width:  Math.max(0, width  - px * 2),
      height: Math.max(0, height - py * 2 - lh),
    }

    const r = Math.min(height / 2, 10)
    ctx.save()

    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.50)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, r)
    ctx.fill()

    // Picker widget
    this._picker.renderSelf(ctx)

    // Hex label at the bottom
    const c = this._colour
    const hex = '#' +
      byteHex(c.r) +
      byteHex(c.g) +
      byteHex(c.b)
    const labelY = y + height - ColourLayer.LABEL_H / 2 - 2

    // Colour swatch dot next to label
    const dotR  = 5
    const dotX  = x + ColourLayer.PAD_X + dotR
    const dotY  = labelY
    ctx.fillStyle = `rgb(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)})`
    ctx.beginPath()
    ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth   = 1
    ctx.stroke()

    ctx.font         = '11px monospace'
    ctx.fillStyle    = this._slot.isActive ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.80)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(hex, dotX + dotR + 6, labelY)

    // Slot indicators — right to left: position, hue
    const indicators = [
      { slot: this._posSlot, label: 'P', colour: '#cf7ecf' },
      { slot: this._hueSlot, label: 'H', colour: '#4a8fe8' },
    ]
    let dx = x + width - ColourLayer.PAD_X
    ctx.font = '9px monospace'
    for (const { slot, label, colour } of indicators) {
      const state = slot.state
      let dot: string, dotColour: string, labelColour: string
      if (state === SlotState.Bound) {
        dot = '●'; dotColour = colour; labelColour = 'rgba(255,255,255,0.55)'
      } else if (state === SlotState.SuspendedBound) {
        dot = '◐'; dotColour = colour + '88'; labelColour = 'rgba(255,255,255,0.40)'
      } else {
        dot = '○'; dotColour = 'rgba(255,255,255,0.22)'; labelColour = 'rgba(255,255,255,0.28)'
      }
      ctx.fillStyle    = dotColour
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(dot, dx, labelY)
      dx -= 11
      ctx.fillStyle = labelColour
      ctx.fillText(label, dx, labelY)
      dx -= ctx.measureText(label).width + 5
    }

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Image-sample pill
  // ----------------------------------------------------------

  private _samplePillBounds(): { x: number; y: number; width: number; height: number } {
    const cb = this.canvasBounds
    return { x: cb.x, y: cb.y + cb.height + 8, width: cb.width, height: SAMPLE_PILL_H }
  }

  private _sampleSliderGeom() {
    const b      = this._samplePillBounds()
    const row2Y  = b.y + SAMPLE_PAD + SAMPLE_ROW_H + SAMPLE_ROW_GAP
    const midY   = row2Y + SAMPLE_ROW_H / 2
    const labelX = b.x + SAMPLE_PAD
    const labelW = 46  // "radius"
    const valueRight = b.x + b.width - SAMPLE_PAD
    const valueW = 36
    const sld0   = labelX + labelW
    const sldR   = valueRight - valueW - 6
    return { b, row2Y, midY, labelX, sld0, sldR, valueRight }
  }

  private _drawSamplePill(ctx: Ctx2D): void {
    const b = this._samplePillBounds()
    if (b.width <= 0 || b.height <= 0) return

    ctx.save()

    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.50)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, Math.min(b.height / 2, 10))
    ctx.fill()

    // Row 1 — label, slot indicators, enable toggle
    const row1Y = b.y + SAMPLE_PAD
    const midY1 = row1Y + SAMPLE_ROW_H / 2

    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = this._sampleEnabled ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.45)'
    ctx.fillText('sample', b.x + SAMPLE_PAD, midY1)

    const btnX = b.x + b.width - SAMPLE_PAD - SAMPLE_BTN_SZ

    // Slot indicators — right to left: point, image
    const indicators = [
      { slot: this._samplePointSlot, label: 'pt', colour: PT_ACCENT },
      { slot: this._sampleImageSlot, label: 'I',  colour: IMG_ACCENT },
    ]
    let dx = btnX - 8
    ctx.font = '9px monospace'
    for (const { slot, label, colour } of indicators) {
      const state = slot.state
      let dot: string, dotColour: string, labelColour: string
      if (state === SlotState.Bound) {
        dot = '●'; dotColour = colour; labelColour = 'rgba(255,255,255,0.55)'
      } else if (state === SlotState.SuspendedBound) {
        dot = '◐'; dotColour = colour + '88'; labelColour = 'rgba(255,255,255,0.40)'
      } else {
        dot = '○'; dotColour = 'rgba(255,255,255,0.22)'; labelColour = 'rgba(255,255,255,0.28)'
      }
      ctx.fillStyle    = dotColour
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(dot, dx, midY1)
      dx -= 11
      ctx.fillStyle = labelColour
      ctx.fillText(label, dx, midY1)
      dx -= ctx.measureText(label).width + 8
    }

    // Enable/disable toggle button
    const btnY = row1Y + (SAMPLE_ROW_H - SAMPLE_BTN_SZ) / 2
    this._sampleToggleBounds = { x: btnX, y: btnY, width: SAMPLE_BTN_SZ, height: SAMPLE_BTN_SZ }

    const state       = this._sampleEnableSlot.state
    const isActive    = state === SlotState.Bound
    const isSuspended = state === SlotState.SuspendedBound

    if (isActive) {
      ctx.fillStyle = EV_ACCENT + '33'
    } else if (isSuspended) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)'
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.08)'
    }
    ctx.beginPath()
    ctx.roundRect(btnX, btnY, SAMPLE_BTN_SZ, SAMPLE_BTN_SZ, 3)
    ctx.fill()

    ctx.strokeStyle = isActive ? EV_ACCENT + '99' : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    if (isSuspended) ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.roundRect(btnX + 0.5, btnY + 0.5, SAMPLE_BTN_SZ - 1, SAMPLE_BTN_SZ - 1, 3)
    ctx.stroke()
    ctx.setLineDash([])

    const iconCol = isActive
      ? EV_ACCENT
      : isSuspended ? 'rgba(255,255,255,0.35)'
      : this._sampleEnabled ? 'rgba(180,255,180,0.85)' : 'rgba(255,255,255,0.55)'

    ctx.font         = '11px monospace'
    ctx.fillStyle    = iconCol
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(this._sampleEnabled ? '●' : '○', btnX + SAMPLE_BTN_SZ / 2, btnY + SAMPLE_BTN_SZ / 2)

    // Row 2 — radius slider
    const g = this._sampleSliderGeom()
    ctx.font         = '10px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = 'rgba(255,255,255,0.50)'
    ctx.fillText('radius', g.labelX, g.midY)

    const norm = (this._sampleRadius - SAMPLE_RADIUS_MIN) / (SAMPLE_RADIUS_MAX - SAMPLE_RADIUS_MIN)
    this._drawSlider(ctx, g.midY, g.sld0, g.sldR, norm,
      this._sampleEnabled ? IMG_ACCENT : 'rgba(255,255,255,0.30)')

    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.textAlign = 'right'
    ctx.fillText(`${Math.round(this._sampleRadius)}px`, g.valueRight, g.midY)

    ctx.restore()
  }

  // Track + filled portion + thumb, FilterLayer/NoiseLayer/FillLayer slider style.
  private _drawSlider(ctx: Ctx2D, midY: number, x0: number, x1: number, v: number, colour: string): void {
    const thumbR = 5
    const lo     = x0 + thumbR
    const hi     = x1 - thumbR
    const range  = Math.max(0, hi - lo)
    const thumbX = lo + Math.max(0, Math.min(1, v)) * range

    ctx.lineCap = 'round'

    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth   = 3
    ctx.beginPath()
    ctx.moveTo(lo, midY)
    ctx.lineTo(hi, midY)
    ctx.stroke()

    ctx.strokeStyle = colour
    ctx.beginPath()
    ctx.moveTo(lo, midY)
    ctx.lineTo(thumbX, midY)
    ctx.stroke()

    ctx.fillStyle = colour
    ctx.beginPath()
    ctx.arc(thumbX, midY, thumbR, 0, Math.PI * 2)
    ctx.fill()
  }

  setSampleRadius(norm: number): void {
    const t = Math.max(0, Math.min(1, norm))
    this._sampleRadius = SAMPLE_RADIUS_MIN + t * (SAMPLE_RADIUS_MAX - SAMPLE_RADIUS_MIN)
    this.markDirty()
  }

  private _handleSampleToggle(): void {
    if (this._sampleEnableSlot.state === SlotState.Bound) {
      this._sampleEnableSlot.suspend()
    } else if (this._sampleEnableSlot.state === SlotState.SuspendedBound) {
      this._sampleEnableSlot.resume()
    } else {
      this._sampleEnabled = !this._sampleEnabled
      this.markDirty()
    }
  }

  private _sliderHit(point: Point): boolean {
    const g = this._sampleSliderGeom()
    return point.x >= g.sld0 - 6 && point.x <= g.sldR + 6 &&
           point.y >= g.row2Y    && point.y <= g.row2Y + SAMPLE_ROW_H
  }

  private _setSampleRadiusFromPointer(px: number): void {
    const g      = this._sampleSliderGeom()
    const thumbR = 5
    const lo     = g.sld0 + thumbR
    const hi     = g.sldR - thumbR
    const range  = Math.max(1e-6, hi - lo)
    this.setSampleRadius((px - lo) / range)
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point) {
    if (this._sampleToggleBounds !== null && boundingBoxContains(this._sampleToggleBounds, point)) return this
    if (this._sliderHit(point)) return this
    return this._picker.hitTest(point)
  }

  handlePointerDown(point: Point): boolean {
    if (this._sampleToggleBounds !== null && boundingBoxContains(this._sampleToggleBounds, point)) {
      this._handleSampleToggle()
      return true
    }
    if (this._sliderHit(point)) {
      this._sampleSliderDrag = true
      this._setSampleRadiusFromPointer(point.x)
      return true
    }
    return false
  }

  handlePointerMove(point: Point): void {
    if (!this._sampleSliderDrag) return
    this._setSampleRadiusFromPointer(point.x)
  }

  handlePointerUp(): void {
    this._sampleSliderDrag = false
  }

  // ----------------------------------------------------------
  // Private
  // ----------------------------------------------------------

  private _syncPickerBounds(): void {
    const { x, y, width, height } = this.bounds
    const px = ColourLayer.PAD_X
    const py = ColourLayer.PAD_Y
    const lh = ColourLayer.LABEL_H
    this._picker.bounds = {
      x:      x + px,
      y:      y + py,
      width:  Math.max(0, width  - px * 2),
      height: Math.max(0, height - py * 2 - lh),
    }
  }
}

function byteHex(v: number): string {
  return Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0')
}
