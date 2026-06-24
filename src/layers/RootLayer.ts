import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  type Colour, type ColourSource,
  type EventValue, type EventSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import type { Clock } from '../dataflow/Clock.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'
import { drawIcon } from '../ui/icons.js'

// ------------------------------------------------------------
// RootLayer — the immovable bottom of the layer stack
// ------------------------------------------------------------
//
// Provides the background fill for the canvas. Two controls:
//
//   • toggleSlot (Event): each rising edge flips _transparent.
//     When _transparent is true, a checkerboard is drawn (signals
//     no fill). When false (default), the background is filled.
//   • colourSlot (Colour): when bound, overrides the fill colour.
//     When unbound, the fill is white (#ffffff).
//
// Note: this.bounds is set to the full canvas rect (via resize())
// so that renderSelf covers the canvas. Panel geometry uses fixed
// STRIP_* / PANEL_* constants instead of this.bounds.

// Checkerboard cell size in pixels.
const CELL = 16

// The two alternating cell colours.
const COLOUR_A = '#3c3c3c'
const COLOUR_B = '#2d2d2d'

const ACCENT  = '#888888'
const STRIPE  = 4

// Fixed panel height
const STRIP_H = 36

// Canvas-space pill position (right of Stack Widget)
const PANEL_Y = 50

// Centred clock-dial readout
const CLOCK_R         = 70     // dial radius, px
const CLOCK_FILL      = 'rgba(232,196,74,0.35)'  // first lap (gold, ClockLayer accent)
const CLOCK_OVERTIME  = 'rgba(224,80,80,0.42)'   // subsequent laps (red, "over the hour")
const CLOCK_BG        = '#ffffff'                // dial face — matches default canvas background
const CLOCK_GREY      = '128,128,128'            // dial boundary, ticks, hand, trail, readout (rgb triple)

type BBox = { x: number; y: number; width: number; height: number }

export class RootLayer extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set()
  override get thumbnailOnlyWhenSelected(): boolean { return true }

  // false = filled (white by default), true = transparent (checkerboard)
  private _transparent = false

  private _colour: Colour = { r: 1, g: 1, b: 1, a: 1 }

  readonly toggleSlot: ParameterSlot
  private _lastEventTime: EventValue = null

  readonly colourSlot: ParameterSlot

  // Nominally bound (via setClock, raw bind — not a BindingLayer) to the
  // app's singleton ClockLayer, signalling its special status. Clicking
  // this slot while Root is selected inserts the singleton above Root.
  readonly clockSlot: ParameterSlot
  private _clock: Clock | null = null

  private _toggleBounds: BBox | null = null

  constructor(width = 0, height = 0) {
    super()
    this.bounds    = { x: 0, y: 0, width, height }
    this.debugName = 'Root'

    this.toggleSlot = new ParameterSlot(ValueType.Event,  this, 'transparent')
    this.colourSlot = new ParameterSlot(ValueType.Colour, this, 'colour')
    this.clockSlot  = new ParameterSlot(ValueType.Amount, this, 'clock')
    this.slots.push(this.toggleSlot, this.colourSlot, this.clockSlot)

    graph.register(this)
  }

  // Nominally bind the singleton ClockLayer to clockSlot — a raw bind (no
  // BindingLayer), since the clock has no stack position yet and needs no
  // binding-inspector UI. Called once at startup.
  setClock(clock: Clock): void {
    this._clock = clock
    this.clockSlot.bind(clock)
  }

  resize(width: number, height: number): void {
    this.bounds = { x: 0, y: 0, width, height }
    this.markDirty()
  }

  // panelBottom is derived from the fixed strip height, not this.bounds.height
  override get panelBottom(): number {
    return PANEL_Y + STRIP_H + 8
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  override evaluate(): void {
    if (this.toggleSlot.isActive) this.toggleSlot.source!.evaluate()
    if (this.colourSlot.isActive) this.colourSlot.source!.evaluate()
    super.evaluate()
  }

  protected recompute(): void {
    // Rising edge on toggleSlot flips _transparent.
    if (this.toggleSlot.isActive) {
      const t = (this.toggleSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastEventTime) {
        this._lastEventTime = t
        this._transparent = !this._transparent
      }
    }

    // Pull colour from colourSlot when bound, else default white.
    this._colour = this.colourSlot.isActive
      ? (this.colourSlot.source as ColourSource).getColour()
      : { r: 1, g: 1, b: 1, a: 1 }
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { transparent: this._transparent }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.transparent === 'boolean') this._transparent = state.transparent
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    if (w <= 0 || h <= 0) return

    ctx.save()

    if (this._transparent) {
      // Checkerboard — signals "no fill / transparent"
      ctx.fillStyle = COLOUR_A
      ctx.fillRect(0, 0, w, h)

      ctx.fillStyle = COLOUR_B
      const cols = Math.ceil(w / CELL)
      const rows = Math.ceil(h / CELL)
      for (let row = 0; row < rows; row++) {
        for (let col = (row % 2); col < cols; col += 2) {
          ctx.fillRect(col * CELL, row * CELL, CELL, CELL)
        }
      }
    } else {
      const c = this._colour
      ctx.fillStyle = `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${c.a})`
      ctx.fillRect(0, 0, w, h)
    }

    ctx.restore()
  }

  renderPanel(ctx: Ctx2D): void {
    this._drawPill(ctx, { x: contentLeft(Node.canvasWidth), y: PANEL_Y, width: panelWidth(Node.canvasWidth), height: STRIP_H })
    this._renderClockReadout(ctx)
  }

  // Clock-dial readout, centred on the canvas. renderPanel runs only for
  // the selected (top) layer, after the full stack composite — so this sits
  // on top of everything, including any transparent areas elsewhere in the
  // stack, without being part of the root content itself.
  //
  //   • A filled segment sweeps the dial once per hour, growing in
  //     discrete one-minute steps (ticking forward as the second hand
  //     completes each minute). Past the first hour it sweeps a second lap,
  //     coloured red.
  //   • A second hand sweeps the dial once per minute, with a faint
  //     fading trail behind it.
  //   • Below the dial, the elapsed time is shown as hh:mm:ss.cs (the same
  //     format used by the ClockLayer thumbnail).
  private _renderClockReadout(ctx: Ctx2D): void {
    if (this._clock === null) return
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    if (w <= 0 || h <= 0) return

    const elapsed = this._clock.elapsed
    const cx = w / 2
    const cy = h / 2
    const R  = CLOCK_R

    // Hour sweep: discrete one-minute steps, lapping (and turning red)
    // every 60 minutes.
    const totalMinutes  = Math.floor(elapsed / 60)
    const lap           = Math.floor(totalMinutes / 60)
    const minutesInLap  = totalMinutes % 60
    const sweepFrac     = minutesInLap / 60
    const sweepColour   = (lap % 2 === 0) ? CLOCK_FILL : CLOCK_OVERTIME

    // Second hand: continuous sweep, once per minute.
    const secAngle = ((elapsed % 60) / 60) * Math.PI * 2 - Math.PI / 2

    ctx.save()

    // Dial face
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.fillStyle = CLOCK_BG
    ctx.fill()

    // Hour-sweep segment (filled pie slice from 12 o'clock, clockwise)
    if (sweepFrac > 0) {
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.arc(cx, cy, R - 3, -Math.PI / 2, -Math.PI / 2 + sweepFrac * Math.PI * 2)
      ctx.closePath()
      ctx.fillStyle = sweepColour
      ctx.fill()
    }

    // Dial rim
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${CLOCK_GREY},0.5)`
    ctx.lineWidth   = 1.5
    ctx.stroke()

    // Minute ticks, every 5 minutes
    for (let i = 0; i < 12; i++) {
      const a  = (i / 12) * Math.PI * 2 - Math.PI / 2
      const r1 = R - 7
      const r2 = R - 1
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2)
      ctx.strokeStyle = `rgba(${CLOCK_GREY},0.5)`
      ctx.lineWidth   = 1
      ctx.stroke()
    }

    // Second hand's fading trail
    const handR     = R - 8
    const TRAIL_SPAN  = Math.PI / 3   // 60° trail
    const TRAIL_STEPS = 12
    for (let i = 0; i < TRAIL_STEPS; i++) {
      const t0 = i / TRAIL_STEPS
      const t1 = (i + 1) / TRAIL_STEPS
      ctx.beginPath()
      ctx.arc(cx, cy, handR, secAngle - TRAIL_SPAN * t1, secAngle - TRAIL_SPAN * t0)
      ctx.strokeStyle = `rgba(${CLOCK_GREY},${0.45 * (1 - t1)})`
      ctx.lineWidth   = 2
      ctx.stroke()
    }

    // Second hand
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(secAngle) * handR, cy + Math.sin(secAngle) * handR)
    ctx.strokeStyle = `rgba(${CLOCK_GREY},0.85)`
    ctx.lineWidth   = 1.5
    ctx.stroke()

    // Centre pivot
    ctx.beginPath()
    ctx.arc(cx, cy, 2, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${CLOCK_GREY},0.85)`
    ctx.fill()

    // Numeric readout — hh:mm:ss.cs, same format as the ClockLayer thumbnail
    const totalCs = Math.floor(elapsed * 100)
    const cs = totalCs % 100
    const ss = Math.floor(totalCs / 100) % 60
    const mm = Math.floor(totalCs / 6000) % 60
    const hh = Math.floor(totalCs / 360000)
    const pad = (n: number) => String(n).padStart(2, '0')
    const timeStr = hh > 0
      ? `${hh}:${pad(mm)}:${pad(ss)}.${pad(cs)}`
      : `${mm}:${pad(ss)}.${pad(cs)}`

    ctx.font         = 'bold 20px monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle    = `rgba(${CLOCK_GREY},0.85)`
    ctx.fillText(timeStr, cx, cy + R + 14)

    ctx.restore()
  }

  override renderSlots(ctx: Ctx2D): void {
    super.renderSlots(ctx)

    const SLOT_H   = 30
    const SLOT_GAP = 4
    const BTN_SZ   = SLOT_H - 6   // 20px

    const idx = this.slots.indexOf(this.toggleSlot)
    if (idx < 0) return

    const y    = this.panelBottom + idx * (SLOT_H + SLOT_GAP)
    const midY = y + SLOT_H / 2
    const btnX = contentLeft(Node.canvasWidth) + panelWidth(Node.canvasWidth) - BTN_SZ - 3
    const btnY = y + 3

    this._toggleBounds = { x: btnX, y: btnY, width: BTN_SZ, height: BTN_SZ }

    const state       = this.toggleSlot.state
    const isActive    = state === SlotState.Bound
    const isSuspended = state === SlotState.SuspendedBound

    ctx.save()

    if (isActive) {
      ctx.fillStyle = ACCENT + '33'
    } else if (isSuspended) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)'
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.08)'
    }
    ctx.beginPath()
    ctx.roundRect(btnX, btnY, BTN_SZ, BTN_SZ, 3)
    ctx.fill()

    ctx.strokeStyle = isActive ? ACCENT + '99' : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    if (isSuspended) ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.roundRect(btnX + 0.5, btnY + 0.5, BTN_SZ - 1, BTN_SZ - 1, 3)
    ctx.stroke()
    ctx.setLineDash([])

    // ■ = filled (opaque), ▨ = transparent
    const iconCol = isActive
      ? ACCENT
      : isSuspended ? 'rgba(255,255,255,0.35)'
      : this._transparent ? 'rgba(180,180,180,0.85)' : 'rgba(255,255,255,0.85)'

    ctx.fillStyle    = iconCol
    drawIcon(ctx, this._transparent ? 'checkerboard' : 'square', btnX + BTN_SZ / 2, midY, BTN_SZ - 8)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    if (this._toggleBounds !== null) {
      const b = this._toggleBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) return this
    }
    return null
  }

  handlePointerDown(point: Point): boolean {
    if (this._toggleBounds !== null) {
      const b = this._toggleBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) {
        this._handleToggle()
        return true
      }
    }
    return false
  }

  handlePointerUp(): void {}

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _handleToggle(): void {
    if (this.toggleSlot.state === SlotState.Bound) {
      this.toggleSlot.suspend()
    } else if (this.toggleSlot.state === SlotState.SuspendedBound) {
      this.toggleSlot.resume()
    } else {
      this._transparent = !this._transparent
      this.markDirty()
    }
  }

  private _drawPill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, STRIPE, height, [4, 0, 0, 4])
    ctx.fill()

    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Background', x + 12, y + height / 2)
    ctx.restore()
  }
}
