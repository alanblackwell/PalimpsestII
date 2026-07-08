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
import { contentLeft, panelWidth } from '../interaction/layout.js'
import { ColourPickerRegion, registerPromotionFactory } from '../regions/ColourPickerRegion.js'
import { BindingLayer } from './BindingLayer.js'
import { drawIcon } from '../ui/icons.js'

// ------------------------------------------------------------
// ColourLayer — a layer that holds and exposes a Colour value
// ------------------------------------------------------------
//
// Two input slots provide independent control over part of the picker:
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
const EV_ACCENT     = '#e0e060'   // Event type accent (enable toggle)
const SAMPLE_ACCENT = '#e8944a'   // Colour type accent — groups the sample controls

const SAMPLE_RADIUS_MIN = 1     // px
const SAMPLE_RADIUS_MAX = 30    // px

// Layout for the sample pill — mirrors PointLayer's wander pill conventions.
const SLOT_H         = 30
const SLOT_GAP       = 4
const PILL_PAD       = 4
const LABEL_W        = 78
const SLIDER_VALUE_W = 40
const N_SAMPLE_ROWS  = 4   // enable, image, point, radius
const SAMPLE_PILL_H  = PILL_PAD * 2 + N_SAMPLE_ROWS * SLOT_H + (N_SAMPLE_ROWS - 1) * SLOT_GAP

const SAMPLE_SLOT_TC: Partial<Record<ValueType, string>> = {
  [ValueType.Event]: EV_ACCENT,
  [ValueType.Image]: '#7ecf7e',
  [ValueType.Point]: '#cf7ecf',
}

registerPromotionFactory((initial: Colour) => new ColourLayer(initial))

export class ColourLayer extends Layer implements ColourSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Colour])

  private readonly _hueSlot: ParameterSlot   // Amount → hue
  private readonly _posSlot: ParameterSlot   // Point  → SV position

  private readonly _picker: ColourPickerRegion
  private _colour: Colour

  // ── Image-sample pill ────────────────────────────────────────
  private readonly _sampleImageSlot:  ParameterSlot   // Image input for sampling
  private readonly _samplePointSlot:  ParameterSlot   // Point input for sample location
  private readonly _sampleEnableSlot: ParameterSlot   // Event → toggle sampling on/off

  private _sampleEnabled = false
  private _sampleRadius  = 5   // px
  private _lastSampleEventTime: EventValue = null

  private _sampleSliderDrag  = false
  private _sampleToggleBounds: { x: number; y: number; width: number; height: number } | null = null
  private _sampleRadiusRowBounds: { x: number; y: number; width: number; height: number } | null = null

  // Transition detection: fires _onSampleImageBound once when the image slot
  // goes from inactive to active while the point slot is still unbound.
  private _prevSampleImageActive = false
  private _onSampleImageBound: (() => void) | null = null

  // Fill convenience button
  private _addFillDone = false
  private _onAddFill: (() => void) | null = null

  private static readonly PAD_X    = 10
  private static readonly PAD_Y    = 8
  private static readonly LABEL_H  = 18  // space reserved at bottom for hex label

  constructor(initial: Colour = { r: 1, g: 0.42, b: 0.17, a: 1 }) {
    super()
    this._colour  = { ...initial }
    this._hueSlot = new ParameterSlot(ValueType.Amount, this, 'hue')
    this._posSlot = new ParameterSlot(ValueType.Point,  this, 'sat/val')
    this._picker  = new ColourPickerRegion(this, initial)
    this._sampleImageSlot  = new ParameterSlot(ValueType.Image, this, 'image')
    this._samplePointSlot  = new ParameterSlot(ValueType.Point, this, 'point')
    this._sampleEnableSlot = new ParameterSlot(ValueType.Event, this, 'sample')
    this.slots.push(this._hueSlot, this._posSlot,
                    this._sampleEnableSlot, this._sampleImageSlot, this._samplePointSlot)
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

  get sampleImageSlot(): ParameterSlot { return this._sampleImageSlot }
  get samplePointSlot(): ParameterSlot { return this._samplePointSlot }

  enableSampling(): void { this._sampleEnabled = true; this.markDirty() }
  setOnSampleImageBound(fn: () => void): void { this._onSampleImageBound = fn }
  setOnAddFill(fn: () => void): void { this._onAddFill = fn }

  // Seed a newly-created layer (via slot-click-to-create) with the value
  // currently shown by the picker, so the binding starts as a no-op.
  override getSlotDefault(slot: ParameterSlot): Point | number | null {
    if (slot === this._hueSlot) return this._picker.hue / 360
    if (slot === this._posSlot) {
      return {
        x: this._picker.sat * Node.canvasWidth,
        y: (1 - this._picker.val) * Node.canvasHeight,
      }
    }
    return null
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      colour:        this._colour,
      sampleEnabled: this._sampleEnabled,
      sampleRadius:  this._sampleRadius,
      addFillDone:   this._addFillDone,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (state.colour) {
      this._colour = state.colour as Colour
      this._picker.setDisplayColour(this._colour)
    }
    if (typeof state.sampleEnabled === 'boolean') this._sampleEnabled = state.sampleEnabled
    if (typeof state.sampleRadius  === 'number')  this._sampleRadius  = state.sampleRadius
    if (typeof state.addFillDone   === 'boolean') this._addFillDone   = state.addFillDone
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
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

    // Rising edge: image slot just became active while point slot is still
    // unbound → ask main.ts to create and wire a PointLayer for the sample
    // location. Deferred via queueMicrotask so it runs after evaluate() returns.
    const nowImageActive = this._sampleImageSlot.isActive
    if (nowImageActive && !this._prevSampleImageActive && !this._samplePointSlot.isActive) {
      const cb = this._onSampleImageBound
      if (cb !== null) queueMicrotask(() => cb())
    }
    this._prevSampleImageActive = nowImageActive
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
    const x0 = Math.max(0, Math.ceil(cx - r))
    const x1 = Math.min(sw - 1, Math.floor(cx + r))
    const y0 = Math.max(0, Math.ceil(cy - r))
    const y1 = Math.min(sh - 1, Math.floor(cy + r))

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
    this._drawPill(ctx, this.canvasBounds)
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
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
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
  // Fill convenience button
  // ----------------------------------------------------------

  private _fillBtnRect() {
    const left = contentLeft(Node.canvasWidth)
    const w    = 50
    const x    = left + Math.max(0, (Node.viewportWidth - left - w) / 2)
    const y    = Node.viewportHeight - 30 - 14
    return { x, y, w, h: 30 }
  }

  override renderOverlay(ctx: Ctx2D): void {
    super.renderOverlay(ctx)
    if (this._addFillDone || this._onAddFill === null) return
    const { x, y, w, h } = this._fillBtnRect()
    const midY = y + h / 2
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 5); ctx.fill()
    ctx.fillStyle = SAMPLE_ACCENT + 'cc'
    ctx.beginPath(); ctx.roundRect(x, y, 3, h, [5, 0, 0, 5]); ctx.fill()
    ctx.save()
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.font = '11px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText('Fill', x + 10, midY)
    ctx.restore()
    ctx.restore()
  }

  // ----------------------------------------------------------
  // Image-sample pill
  // ----------------------------------------------------------

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const stdBottom = this.renderSlotGroup(
      ctx, [this._hueSlot, this._posSlot], this.panelBottom,
    )
    this._renderSamplePill(ctx, stdBottom + 8)
  }

  private _samplePillBounds(topY: number) {
    return { x: contentLeft(Node.canvasWidth), y: topY, width: panelWidth(Node.canvasWidth), height: SAMPLE_PILL_H }
  }

  private _sampleRow(i: number, pb: { x: number; y: number; width: number; height: number }) {
    return { x: pb.x, y: pb.y + PILL_PAD + i * (SLOT_H + SLOT_GAP), width: pb.width, height: SLOT_H }
  }

  private _renderSamplePill(ctx: Ctx2D, topY: number): void {
    const pb = this._samplePillBounds(topY)

    // Pill background + accent stripe
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath(); ctx.roundRect(pb.x, pb.y, pb.width, pb.height, 8); ctx.fill()
    ctx.fillStyle = SAMPLE_ACCENT
    ctx.beginPath(); ctx.roundRect(pb.x, pb.y, 4, pb.height, [4, 0, 0, 4]); ctx.fill()
    ctx.restore()

    // Row 0 — sample enable binding + toggle button
    this._renderSampleSlotRow(ctx, this._sampleEnableSlot, this._sampleRow(0, pb))
    this._renderEnableButton(ctx, this._sampleRow(0, pb))

    // Row 1 — image binding
    this._renderSampleSlotRow(ctx, this._sampleImageSlot, this._sampleRow(1, pb))

    // Row 2 — point binding
    this._renderSampleSlotRow(ctx, this._samplePointSlot, this._sampleRow(2, pb))

    // Row 3 — radius slider
    const row3 = this._sampleRow(3, pb)
    this._sampleRadiusRowBounds = row3
    this._renderRadiusSliderRow(ctx, row3)
  }

  private _renderSampleSlotRow(
    ctx: Ctx2D, slot: ParameterSlot,
    b: { x: number; y: number; width: number; height: number },
  ): void {
    const drag     = Node.bindDrag
    const isCompat = (drag.active && drag.source !== null && slot.type !== null
                      && drag.source.types.has(slot.type))
                  || (Node.fileDragActive && slot.type === ValueType.Image
                      && slot.state === SlotState.Unbound)

    this._slotBounds.set(slot, b)

    const midY = b.y + b.height / 2
    const tc   = (slot.type !== null ? SAMPLE_SLOT_TC[slot.type] : undefined) ?? '#888888'
    const vx   = b.x + LABEL_W
    const vw   = b.width - LABEL_W - 2
    const by   = b.y + 3
    const bh   = b.height - 6

    ctx.save()
    ctx.font         = '10px monospace'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = 'rgba(255,255,255,0.62)'
    ctx.textAlign    = 'left'
    ctx.fillText(slot.label, b.x + 6, midY)

    if (slot.isActive && !isCompat) {
      const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
      ctx.fillStyle = tc + '22'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = tc + 'cc'; ctx.lineWidth = 1; ctx.setLineDash([])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.textAlign = 'left'
      ctx.fillText(srcName, vx + 6, midY)
    } else if (isCompat) {
      ctx.fillStyle = 'rgba(50,200,70,0.18)'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = 'rgba(50,200,70,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.fillStyle = 'rgba(100,255,120,0.75)'; ctx.textAlign = 'left'
      ctx.fillText(slot.isActive ? 'replace binding' : 'drop to bind', vx + 6, midY)
    } else if (slot.state === SlotState.SuspendedBound) {
      const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
      ctx.fillStyle = tc + '11'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.40)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.60)'; ctx.textAlign = 'left'
      ctx.fillText('⏸ ' + srcName, vx + 6, midY)
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.textAlign = 'left'
      ctx.fillText('unbound', vx + 6, midY)
    }

    ctx.restore()
  }

  private _renderEnableButton(ctx: Ctx2D, row: { x: number; y: number; width: number; height: number }): void {
    const btnSz = row.height - 6
    const btnX  = row.x + row.width - btnSz - 3
    const btnY  = row.y + 3
    const midY  = row.y + row.height / 2

    this._sampleToggleBounds = { x: btnX, y: btnY, width: btnSz, height: btnSz }

    const state       = this._sampleEnableSlot.state
    const isActive    = state === SlotState.Bound
    const isSuspended = state === SlotState.SuspendedBound

    ctx.save()

    ctx.fillStyle = isActive ? EV_ACCENT + '33' : isSuspended ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.08)'
    ctx.beginPath(); ctx.roundRect(btnX, btnY, btnSz, btnSz, 3); ctx.fill()

    ctx.strokeStyle = isActive ? EV_ACCENT + '99' : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    if (isSuspended) ctx.setLineDash([2, 2])
    ctx.beginPath(); ctx.roundRect(btnX + 0.5, btnY + 0.5, btnSz - 1, btnSz - 1, 3); ctx.stroke()
    ctx.setLineDash([])

    const iconCol = isActive ? EV_ACCENT
      : isSuspended ? 'rgba(255,255,255,0.35)'
      : this._sampleEnabled ? 'rgba(180,255,180,0.85)' : 'rgba(255,255,255,0.55)'

    ctx.fillStyle = iconCol
    drawIcon(ctx, this._sampleEnabled ? 'aperture' : 'circle-half', btnX + btnSz / 2, midY, btnSz - 8)

    ctx.restore()
  }

  private _renderRadiusSliderRow(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const midY       = b.y + b.height / 2
    const valueRight = b.x + b.width - 8
    const sld0       = b.x + LABEL_W
    const sldR       = valueRight - SLIDER_VALUE_W - 6
    const norm       = (this._sampleRadius - SAMPLE_RADIUS_MIN) / (SAMPLE_RADIUS_MAX - SAMPLE_RADIUS_MIN)

    ctx.save()
    ctx.font         = '10px monospace'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = 'rgba(255,255,255,0.62)'
    ctx.textAlign    = 'left'
    ctx.fillText('radius', b.x + 6, midY)

    this._drawSlider(ctx, midY, sld0, sldR, norm,
      this._sampleEnabled ? SAMPLE_ACCENT : 'rgba(255,255,255,0.30)')

    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.textAlign = 'right'
    ctx.fillText(`${Math.round(this._sampleRadius)}px`, valueRight, midY)
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
    const b = this._sampleRadiusRowBounds
    if (b === null) return false
    const sld0 = b.x + LABEL_W
    const sldR = b.x + b.width - 8 - SLIDER_VALUE_W - 6
    return point.x >= sld0 - 6 && point.x <= sldR + 6 &&
           point.y >= b.y       && point.y <= b.y + b.height
  }

  private _setSampleRadiusFromPointer(px: number): void {
    const b = this._sampleRadiusRowBounds
    if (b === null) return
    const sld0   = b.x + LABEL_W
    const sldR   = b.x + b.width - 8 - SLIDER_VALUE_W - 6
    const thumbR = 5
    const lo     = sld0 + thumbR
    const hi     = sldR - thumbR
    const range  = Math.max(1e-6, hi - lo)
    this.setSampleRadius((px - lo) / range)
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point) {
    if (!this._addFillDone && this._onAddFill !== null) {
      const { x, y, w, h } = this._fillBtnRect()
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h) return this
    }
    if (this._sampleToggleBounds !== null && boundingBoxContains(this._sampleToggleBounds, point)) return this
    if (this._sliderHit(point)) return this
    return this._picker.hitTest(point)
  }

  handlePointerDown(point: Point): boolean {
    if (!this._addFillDone && this._onAddFill !== null) {
      const { x, y, w, h } = this._fillBtnRect()
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h) {
        this._addFillDone = true
        this._onAddFill()
        return true
      }
    }
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

}

function byteHex(v: number): string {
  return Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0')
}
