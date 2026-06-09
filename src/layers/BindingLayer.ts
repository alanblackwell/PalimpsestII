import { Layer } from '../core/Layer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type Amount,    type AmountSource,
  type Colour,    type ColourSource,
  type Point,     type PointSource,
  type Direction, type DirectionSource,
  type Rate,      type RateSource,
  type Count,     type CountSource,
  type EventValue, type EventSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// BindingLayer — a first-class stack representation of a binding edge
// ------------------------------------------------------------
//
// Per the architecture spec §5:
//
//   "When a manual binding is created, a BindingLayer is inserted
//   into the stack *above the consumer*. It is a value-producing
//   node (same type as the source) and a visual representation of
//   the directed edge."
//
// Structure:
//
//   Source ──→── [slot on Consumer]       dataflow edge
//      ↑
//   BindingLayer (inserted above Consumer; subscribes to Source)
//
// Layers further above may bind to the BindingLayer itself and
// receive the same value the consumer receives.
//
// Controls:
//   Toggle (⊙/◎) — Bound ↔ SuspendedBound on the consumer's slot
//   Remove  (×)  — fully unbind and remove this layer from the stack
//
// Visual layout:
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ ● SourceName  ──→──  ConsumerName · slotType     [⊙]  [×]  │
//   └──────────────────────────────────────────────────────────────┘

// Pixel height of every BindingLayer.
const BINDING_H = 28

// Gap between a BindingLayer and the consumer layer it sits above.
const STACK_GAP = 4

// Per-type accent colours for the left badge and arrows.
const TYPE_COLOUR: Partial<Record<ValueType, string>> = {
  [ValueType.Amount]:    '#4a8fe8',
  [ValueType.Colour]:    '#e8944a',
  [ValueType.Image]:     '#7ecf7e',
  [ValueType.Mask]:      '#cfcf7e',
  [ValueType.Point]:     '#cf7ecf',
  [ValueType.Direction]: '#7ecfcf',
  [ValueType.Rate]:      '#e87e7e',
  [ValueType.Count]:     '#a0a0a0',
  [ValueType.Event]:     '#e0e060',
}

function primaryTypeColour(types: ReadonlySet<ValueType>): string {
  for (const t of types) {
    const c = TYPE_COLOUR[t]
    if (c) return c
  }
  return '#888888'
}

// ------------------------------------------------------------------

export class BindingLayer extends Layer
  implements AmountSource, ColourSource, PointSource,
             DirectionSource, RateSource, CountSource, EventSource {

  readonly types: ReadonlySet<ValueType>
  override readonly isInfrastructure = true

  private readonly _source: Node
  private readonly _slot:   ParameterSlot
  private _enabled = true

  // Button geometry — derived from bounds, computed on demand.
  private static readonly BTN = 20   // button size in px
  private static readonly BTN_M = 6  // margin from right edge
  private static readonly BTN_G = 4  // gap between buttons

  // ----------------------------------------------------------
  // Construction
  // ----------------------------------------------------------

  private constructor(source: Node, slot: ParameterSlot) {
    super()
    this._source = source
    this._slot   = slot
    this.types   = new Set(source.types)
    this.debugName = 'BindingLayer'

    // Subscribe to source dirtiness so that nodes bound *to this*
    // layer get correctly invalidated when the source changes.
    source.addDependent(this)

    graph.register(this)
  }

  // ----------------------------------------------------------
  // Factory
  // ----------------------------------------------------------

  // Bind source to slot, create the BindingLayer, insert it above
  // the consumer in the stack, and position it adjacent to the
  // consumer's bounds.
  //
  // Returns null if the binding would create a cycle or a type
  // mismatch prevents it.
  static create(source: Node, slot: ParameterSlot): BindingLayer | null {
    if (!graph.bind(source, slot)) return null

    const bl       = new BindingLayer(source, slot)
    const consumer = slot.owner

    if (consumer instanceof Layer) {
      bl.insertAbove(consumer)
      // Position flush with the consumer, immediately above it.
      const cb    = consumer.bounds
      bl.bounds   = { x: cb.x, y: cb.y - BINDING_H - STACK_GAP, width: cb.width, height: BINDING_H }
    }

    return bl
  }

  // ----------------------------------------------------------
  // Controls
  // ----------------------------------------------------------

  get enabled(): boolean { return this._enabled }

  // Toggle between Bound and SuspendedBound on the consumer's slot.
  toggle(): void {
    if (this._enabled) {
      graph.suspend(this._slot)
    } else {
      graph.resume(this._slot)
    }
    this._enabled = !this._enabled
    this.markDirty()
  }

  // Fully unbind the consumer's slot and remove this layer from
  // the stack.
  remove(): void {
    graph.unbind(this._slot)
    this._source.removeDependent(this)
    this.removeFromStack()
    graph.unregister(this)
  }

  // ----------------------------------------------------------
  // Typed source interfaces — all delegate to _source
  // ----------------------------------------------------------

  getAmount():    Amount    { return (this._source as AmountSource).getAmount() }
  getColour():    Colour    { return (this._source as ColourSource).getColour() }
  getPoint():     Point     { return (this._source as PointSource).getPoint() }
  getDirection(): Direction { return (this._source as DirectionSource).getDirection() }
  getRate():      Rate      { return (this._source as RateSource).getRate() }
  getCount():     Count     { return (this._source as CountSource).getCount() }
  getEventTime(): EventValue { return (this._source as EventSource).getEventTime() }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  // BindingLayer has no parameter slots, so the default evaluate()
  // path won't pull the source. Override to do it explicitly.
  override evaluate(): void {
    this._source.evaluate()
    super.evaluate()
  }

  protected recompute(): void {
    // Pure pass-through — value is read live from _source via getters.
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._toggleBtnBounds(), point)) {
      this.toggle()
      return true
    }
    if (boundingBoxContains(this._removeBtnBounds(), point)) {
      this.remove()
      return true
    }
    return false
  }

  protected override hitTestSelf(point: { x: number; y: number }): Node | null {
    return boundingBoxContains(this.bounds, point) ? this : null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.bounds
    if (width <= 0 || height <= 0) return

    const accent  = primaryTypeColour(this._source.types)
    const midY    = y + height / 2
    const disabled = !this._enabled

    ctx.save()

    // Background
    ctx.fillStyle = disabled ? 'rgba(30,30,30,0.70)' : 'rgba(20,30,50,0.75)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, 4)
    ctx.fill()

    // Accent stripe on the left
    ctx.fillStyle = disabled ? 'rgba(120,120,120,0.6)' : accent
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // Text style
    ctx.font         = '11px monospace'
    ctx.textBaseline = 'middle'

    // Source label
    const srcLabel = this._source.debugName
    ctx.fillStyle = disabled ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.85)'
    ctx.textAlign = 'left'
    ctx.fillText(srcLabel, x + 12, midY)

    // Arrow / disabled indicator — centred
    const arrowX = x + width / 2
    ctx.textAlign    = 'center'
    ctx.fillStyle    = disabled ? 'rgba(255,80,80,0.70)' : accent
    ctx.font         = disabled ? 'bold 13px monospace' : '13px monospace'
    ctx.fillText(disabled ? '✕' : '→', arrowX, midY)

    // Consumer label + slot type
    const consumer   = this._slot.owner
    const label      = consumer.debugName + ' · ' + (this._slot.type ?? 'any')
    ctx.font         = '11px monospace'
    ctx.fillStyle    = disabled ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.65)'
    ctx.textAlign    = 'right'
    const textRight  = this._toggleBtnBounds().x - 8
    ctx.fillText(label, textRight, midY)

    // Toggle button
    this._drawBtn(ctx, this._toggleBtnBounds(), disabled ? '◎' : '⊙',
      disabled ? 'rgba(255,180,60,0.80)' : accent)

    // Remove button
    this._drawBtn(ctx, this._removeBtnBounds(), '×', 'rgba(220,80,80,0.80)')

    ctx.restore()
  }

  private _drawBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    colour: string,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()

    ctx.font         = '13px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }

  // ----------------------------------------------------------
  // Button geometry
  // ----------------------------------------------------------

  private _removeBtnBounds() {
    const { x, y, width, height } = this.bounds
    const m = BindingLayer.BTN_M
    const s = BindingLayer.BTN
    return { x: x + width - m - s, y: y + (height - s) / 2, width: s, height: s }
  }

  private _toggleBtnBounds() {
    const rb = this._removeBtnBounds()
    const s  = BindingLayer.BTN
    const g  = BindingLayer.BTN_G
    return { x: rb.x - s - g, y: rb.y, width: s, height: s }
  }
}
