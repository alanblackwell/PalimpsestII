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
const PANEL_X = 300
const PANEL_Y = 50
const PANEL_W = 260

type BBox = { x: number; y: number; width: number; height: number }

export class RootLayer extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set()
  override readonly thumbnailOnlyWhenSelected = true

  // false = filled (white by default), true = transparent (checkerboard)
  private _transparent = false

  private _colour: Colour = { r: 1, g: 1, b: 1, a: 1 }

  readonly toggleSlot: ParameterSlot
  private _lastEventTime: EventValue = null

  readonly colourSlot: ParameterSlot

  private _toggleBounds: BBox | null = null

  constructor(width = 0, height = 0) {
    super()
    this.bounds    = { x: 0, y: 0, width, height }
    this.debugName = 'Root'

    this.toggleSlot = new ParameterSlot(ValueType.Event,  this, 'transparent')
    this.colourSlot = new ParameterSlot(ValueType.Colour, this, 'colour')
    this.slots.push(this.toggleSlot, this.colourSlot)

    graph.register(this)
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
    this._drawPill(ctx, { x: PANEL_X, y: PANEL_Y, width: PANEL_W, height: STRIP_H })
  }

  override renderSlots(ctx: Ctx2D): void {
    super.renderSlots(ctx)

    const SLOT_H   = 26
    const SLOT_GAP = 4
    const BTN_SZ   = SLOT_H - 6   // 20px

    const idx = this.slots.indexOf(this.toggleSlot)
    if (idx < 0) return

    const y    = this.panelBottom + idx * (SLOT_H + SLOT_GAP)
    const midY = y + SLOT_H / 2
    const btnX = PANEL_X + PANEL_W - BTN_SZ - 3
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

    ctx.font         = '11px monospace'
    ctx.fillStyle    = iconCol
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(this._transparent ? '▨' : '■', btnX + BTN_SZ / 2, midY)

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
