import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type Colour,   type ColourSource,
  type Point,    type PointSource,
  type Amount,   type AmountSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// TextLayer — renders a string onto the canvas
// ------------------------------------------------------------
//
// A terminal (sink) layer: types = empty set; nothing binds to it.
//
// Input slots:
//   positionSlot  (Point)  — where to anchor the text on-canvas.
//                            Unbound default: canvas-centre-ish.
//   colourSlot    (Colour) — text fill colour.
//                            Unbound default: white.
//   sizeSlot      (Amount) — maps [0,1] → [MIN_SIZE, MAX_SIZE] px.
//                            Unbound default: DEFAULT_SIZE px.
//
// Text content:
//   Set via constructor; click the [✎] button in the stack panel
//   to edit using a native prompt() dialog.
//
// Rendering:
//   Two components, like PointLayer:
//     1. Stack panel label (at this.bounds) — truncated text + slot
//        status indicators + [✎] edit button.
//     2. Canvas text drawn at the resolved position, in the resolved
//        colour and size, with a subtle drop-shadow for legibility.
//
// Visual layout of the stack panel (height ≈ 36 px):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ T  "Hello, world"         pos ● col ● sz ●    [✎]      │
//   └──────────────────────────────────────────────────────────┘
//
// Slot indicators are filled (●) when the slot is active, hollow (○) when not.

const ACCENT       = '#c8c8e8'   // neutral periwinkle — text / display node
const MIN_SIZE     = 12          // px at amount = 0
const MAX_SIZE     = 120         // px at amount = 1
const DEFAULT_SIZE = 48          // px when sizeSlot unbound
const DEFAULT_POS  = { x: 400, y: 300 }
const DEFAULT_COL  = { r: 1, g: 1, b: 1, a: 1 }

// Button geometry
const BTN   = 20
const BTN_M = 6

export class TextLayer extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set()

  private readonly _positionSlot: ParameterSlot
  private readonly _colourSlot:   ParameterSlot
  private readonly _sizeSlot:     ParameterSlot

  private _text:     string = 'Hello'
  private _position: Point  = { ...DEFAULT_POS }
  private _colour:   Colour = { ...DEFAULT_COL }
  private _size:     number = DEFAULT_SIZE

  constructor(text = 'Hello') {
    super()
    this._text         = text
    this._positionSlot = new ParameterSlot(ValueType.Point,  this)
    this._colourSlot   = new ParameterSlot(ValueType.Colour, this)
    this._sizeSlot     = new ParameterSlot(ValueType.Amount, this)
    this.slots.push(this._positionSlot, this._colourSlot, this._sizeSlot)
    this.debugName = 'TextLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get positionSlot(): ParameterSlot { return this._positionSlot }
  get colourSlot():   ParameterSlot { return this._colourSlot   }
  get sizeSlot():     ParameterSlot { return this._sizeSlot     }

  // ----------------------------------------------------------
  // Text editing
  // ----------------------------------------------------------

  get text(): string { return this._text }

  promptEdit(): void {
    const next = window.prompt('Edit text:', this._text)
    if (next !== null) {
      this._text = next
      this.markDirty()
    }
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    this._position = this._positionSlot.isActive
      ? (this._positionSlot.source as PointSource).getPoint()
      : { ...DEFAULT_POS }

    this._colour = this._colourSlot.isActive
      ? (this._colourSlot.source as ColourSource).getColour()
      : { ...DEFAULT_COL }

    const amt = this._sizeSlot.isActive
      ? (this._sizeSlot.source as AmountSource).getAmount() as Amount
      : -1
    this._size = amt >= 0
      ? MIN_SIZE + amt * (MAX_SIZE - MIN_SIZE)
      : DEFAULT_SIZE
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._editBtnBounds(), point)) {
      this.promptEdit()
      return true
    }
    return false
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    return boundingBoxContains(this.bounds, point) ? this : null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    this._renderPanel(ctx)
    this._renderCanvas(ctx)
  }

  // ── Stack panel ─────────────────────────────────────────────

  private _renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.bounds
    if (width <= 0 || height <= 0) return

    const midY = y + height / 2

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

    // "T" glyph
    ctx.font         = 'bold 13px monospace'
    ctx.fillStyle    = ACCENT
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('T', x + 10, midY)

    // Text preview (truncated)
    const editB    = this._editBtnBounds()
    const previewR = editB.x - 8
    const previewL = x + 26
    ctx.font      = '11px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.80)'
    const truncated = this._truncate(ctx, `"${this._text}"`, previewR - previewL - 70)
    ctx.fillText(truncated, previewL, midY)

    // Slot indicator dots — pos / col / sz
    const dotsR = editB.x - 6
    const slots = [
      { slot: this._positionSlot, label: 'pos' },
      { slot: this._colourSlot,   label: 'col' },
      { slot: this._sizeSlot,     label: 'sz'  },
    ]
    ctx.font = '9px monospace'
    let dx = dotsR
    for (let i = slots.length - 1; i >= 0; i--) {
      const { slot, label } = slots[i]
      const active = slot.isActive
      ctx.fillStyle = active ? ACCENT : 'rgba(255,255,255,0.22)'
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(active ? '●' : '○', dx, midY)
      dx -= 12
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText(label, dx, midY)
      dx -= ctx.measureText(label).width + 6
    }

    // [✎] edit button
    this._drawBtn(ctx, editB, '✎', 'rgba(255,255,255,0.60)')

    ctx.restore()
  }

  // ── Canvas text ─────────────────────────────────────────────

  private _renderCanvas(ctx: Ctx2D): void {
    if (!this._text) return

    const { x: px, y: py } = this._position
    const c = this._colour
    const css = `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${c.a.toFixed(2)})`

    ctx.save()

    ctx.font         = `${Math.round(this._size)}px sans-serif`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'

    // Drop shadow for legibility on any background
    ctx.shadowColor  = 'rgba(0,0,0,0.70)'
    ctx.shadowBlur   = 6
    ctx.shadowOffsetX = 1
    ctx.shadowOffsetY = 1

    ctx.fillStyle = css
    ctx.fillText(this._text, px, py)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _editBtnBounds() {
    const { x, y, width, height } = this.bounds
    return { x: x + width - BTN_M - BTN, y: y + (height - BTN) / 2, width: BTN, height: BTN }
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
    ctx.font         = '12px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }

  // Truncate `str` to fit within `maxWidth` pixels, appending '…'.
  private _truncate(ctx: Ctx2D, str: string, maxWidth: number): string {
    if (maxWidth <= 0) return ''
    if (ctx.measureText(str).width <= maxWidth) return str
    let lo = 0, hi = str.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (ctx.measureText(str.slice(0, mid) + '…').width <= maxWidth) lo = mid
      else hi = mid - 1
    }
    return str.slice(0, lo) + '…'
  }
}
