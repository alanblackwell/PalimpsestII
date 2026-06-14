import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type Amount, type AmountSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// MathLayer — combinatorial Amount processing node
// ------------------------------------------------------------
//
// Takes up to two Amount inputs (slotA, slotB) and applies a
// selected mathematical operation, outputting an Amount.
//
// Unbound slots default to 0.  The operation is cycled with
// [◀] / [▶] navigator buttons or by clicking the op label.
//
// Operations
//   Binary  — a+b  a−b  a×b  a÷b  min  max  mod  aᵇ  |a−b|
//   Unary   — 1−a  sin  cos  √a   a²
//
// add / sub results are clamped to [0, 1].
// div / mod guard against b ≈ 0 (return 0).
// sin / cos map the Amount [0,1] → full 2π period, then
//   re-normalise to [0,1] so the output stays in-range.
//
// Visual layout (height ≈ 36 px):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌  [◀]  a × b  [▶]    a:0.40  b:0.75    = 0.30        │
//   └──────────────────────────────────────────────────────────┘
//
// b label is dimmed when the current op is unary.

// ------------------------------------------------------------------
// Operation table
// ------------------------------------------------------------------

interface Op {
  readonly label:  string
  readonly arity:  1 | 2
  readonly fn:     (a: number, b: number) => number
}

const OPS: readonly Op[] = [
  { label: 'a + b',  arity: 2, fn: (a, b) => Math.min(1, Math.max(0, a + b)) },
  { label: 'a − b',  arity: 2, fn: (a, b) => Math.min(1, Math.max(0, a - b)) },
  { label: 'a × b',  arity: 2, fn: (a, b) => a * b                            },
  { label: 'a ÷ b',  arity: 2, fn: (a, b) => b > 0.001 ? Math.min(1, a / b) : 0 },
  { label: 'min',    arity: 2, fn: (a, b) => Math.min(a, b)                   },
  { label: 'max',    arity: 2, fn: (a, b) => Math.max(a, b)                   },
  { label: 'mod',    arity: 2, fn: (a, b) => b > 0.001 ? a % b : 0            },
  { label: 'aᵇ',    arity: 2, fn: (a, b) => Math.pow(a, b)                   },
  { label: '|a−b|',  arity: 2, fn: (a, b) => Math.abs(a - b)                  },
  { label: '1 − a',  arity: 1, fn: (a)    => 1 - a                            },
  { label: 'sin',    arity: 1, fn: (a)    => (Math.sin(a * Math.PI * 2) + 1) / 2 },
  { label: 'cos',    arity: 1, fn: (a)    => (Math.cos(a * Math.PI * 2) + 1) / 2 },
  { label: '√a',     arity: 1, fn: (a)    => Math.sqrt(Math.max(0, a))        },
  { label: 'a²',     arity: 1, fn: (a)    => a * a                            },
]

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT   = '#4a8fe8'   // Amount type colour
const BTN_W    = 18          // width of [◀] / [▶] nav buttons
const BTN_H    = 22
const OP_W     = 68          // reserved for op label text
const VAL_W    = 46          // width of each value column

// ------------------------------------------------------------------
// MathLayer
// ------------------------------------------------------------------

export class MathLayer extends Layer implements AmountSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Amount])

  private readonly _slotA: ParameterSlot
  private readonly _slotB: ParameterSlot

  private _opIndex: number = 2    // default: a × b
  private _result:  Amount = 0
  private _aValue:  number = 0
  private _bValue:  number = 0
  private _cpBounds: { x: number; y: number; width: number; height: number } | null = null

  constructor(opIndex = 2) {
    super()
    this._opIndex = Math.max(0, Math.min(OPS.length - 1, opIndex))
    this._slotA   = new ParameterSlot(ValueType.Amount, this)
    this._slotB   = new ParameterSlot(ValueType.Amount, this)
    this.slots.push(this._slotA, this._slotB)
    this.debugName = 'MathLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // AmountSource
  // ----------------------------------------------------------

  getAmount(): Amount { return this._result }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get slotA(): ParameterSlot { return this._slotA }
  get slotB(): ParameterSlot { return this._slotB }

  // ----------------------------------------------------------
  // Op navigation
  // ----------------------------------------------------------

  cycleNext(): void {
    this._opIndex = (this._opIndex + 1) % OPS.length
    this.markDirty()
  }

  cyclePrev(): void {
    this._opIndex = (this._opIndex - 1 + OPS.length) % OPS.length
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { opIndex: this._opIndex }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.opIndex === 'number') this._opIndex = state.opIndex
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    this._aValue = this._slotA.isActive
      ? (this._slotA.source as AmountSource).getAmount()
      : 0
    this._bValue = this._slotB.isActive
      ? (this._slotB.source as AmountSource).getAmount()
      : 0
    this._result = OPS[this._opIndex].fn(this._aValue, this._bValue)
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    const b = this._cpBounds ?? this.bounds
    if (boundingBoxContains(this._prevBtnBounds(b), point)) {
      this.cyclePrev()
      return true
    }
    if (boundingBoxContains(this._nextBtnBounds(b), point)) {
      this.cycleNext()
      return true
    }
    // Clicking the op label itself also cycles forward.
    if (boundingBoxContains(this._opLabelBounds(b), point)) {
      this.cycleNext()
      return true
    }
    return false
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    return (this._cpBounds && boundingBoxContains(this._cpBounds, point))
      ? this : null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width <= 0 || this.bounds.height <= 0) return
    this._drawPill(ctx, this.bounds)
    const cp = { x: 300, y: 50, width: 260, height: this.bounds.height }
    this._cpBounds = cp
    this._drawPill(ctx, cp)
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    const midY   = y + height / 2
    const op     = OPS[this._opIndex]
    const binary = op.arity === 2

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // [◀] prev button
    this._drawNavBtn(ctx, this._prevBtnBounds(b), '◀', midY)

    // Op label zone (click to cycle)
    const opB = this._opLabelBounds(b)
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(opB.x, opB.y, opB.width, opB.height, 3)
    ctx.fill()
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(op.label, opB.x + opB.width / 2, midY)

    // [▶] next button
    this._drawNavBtn(ctx, this._nextBtnBounds(b), '▶', midY)

    // Value columns — right section
    const valStart = this._nextBtnBounds(b).x + BTN_W + 10
    ctx.font      = '11px monospace'
    ctx.textAlign = 'left'

    // a value
    ctx.fillStyle    = this._slotA.isActive
      ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.28)'
    ctx.textBaseline = 'middle'
    const aStr = 'a:' + this._aValue.toFixed(2)
    ctx.fillText(aStr, valStart, midY)

    // b value (dim for unary ops)
    const bX = valStart + VAL_W
    ctx.fillStyle = !binary
      ? 'rgba(255,255,255,0.15)'
      : this._slotB.isActive
        ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.28)'
    const bStr = 'b:' + this._bValue.toFixed(2)
    ctx.fillText(bStr, bX, midY)

    // Result
    const resX = x + width - 6
    ctx.textAlign = 'right'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.fillText('=' + this._result.toFixed(3), resX, midY)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _drawNavBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    midY: number,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 3)
    ctx.fill()
    ctx.font         = '9px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.55)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, midY)
  }

  // Button / zone geometry — all derived from bounds

  private _prevBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const { x, y, height } = b ?? this.bounds
    return { x: x + 8, y: y + (height - BTN_H) / 2, width: BTN_W, height: BTN_H }
  }

  private _opLabelBounds(b?: { x: number; y: number; width: number; height: number }) {
    const pb = this._prevBtnBounds(b)
    return { x: pb.x + BTN_W + 4, y: pb.y, width: OP_W, height: BTN_H }
  }

  private _nextBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const ob = this._opLabelBounds(b)
    return { x: ob.x + OP_W + 4, y: ob.y, width: BTN_W, height: BTN_H }
  }
}
