import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type Count, type CountSource,
  type EventSource, type EventValue,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { drawIcon } from '../ui/icons.js'

// ------------------------------------------------------------
// CountLayer — a non-negative integer counter
// ------------------------------------------------------------
//
// Two operating modes:
//
//   Manual   — [−] and [+] buttons increment/decrement the count.
//              Count never goes below 0.
//
//   Driven   — an EventSource is bound to the event slot.  Each
//              new event pulse (EventValue timestamp changes)
//              increments the counter by 1.  Manual buttons still
//              work on top.
//
// A [↺] reset button always zeros the counter.
//
// The canvas-space pill uses big buttons (same size/style as TextLayer's
// edit/size row): [−] and [+] lead at the left with the count between them,
// [↺] reset sits at the right edge. The widget-column strip (this.bounds)
// keeps the original small layout below — it's non-interactive (hit-testing
// only ever looks at the canvas-space pill) and normally hidden behind the
// StackWidget, so it doesn't need enlarging.
//
//   ┌──────────────────────────────────────────────────────┐
//   │ ▌  [ − ]     42     [ + ]                      [ ↺ ] │
//   └──────────────────────────────────────────────────────┘

const ACCENT = '#a0a0a0'   // Count type colour

// Small strip-pill button geometry (widget-column strip only).
const BTN   = 24   // button size in px
const BTN_M = 6    // margin from right edge
const BTN_G = 6    // gap between buttons

// Big canvas-space buttons — same target size as TextLayer's edit/size row.
const BIG_SZ      = 48   // target square size
const BIG_MIN     = 36   // floor when the panel is narrow
const BIG_GAP     = 6
const BIG_MARGIN  = 8
const BIG_VALUE_W = 40   // width reserved for the count value between −/+

type BBox = { x: number; y: number; width: number; height: number }

export class CountLayer extends Layer implements CountSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Count])

  // Optional EventSource input — increments counter on each new pulse.
  private readonly _eventSlot: ParameterSlot

  private _count: Count = 0

  // Last seen event timestamp — used to detect new pulses.
  private _lastEventTime: EventValue = null

  constructor(initial: Count = 0) {
    super()
    this._count    = Math.max(0, Math.floor(initial))
    this._eventSlot = new ParameterSlot(ValueType.Event, this)
    this.slots.push(this._eventSlot)
    this.displayBaseName = 'Index'
    this.debugName = 'Index'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // CountSource
  // ----------------------------------------------------------

  getCount(): Count { return this._count }

  // ----------------------------------------------------------
  // Slot accessor
  // ----------------------------------------------------------

  get eventSlot(): ParameterSlot { return this._eventSlot }

  // Canvas-space pill is taller than the default strip height, to fit the
  // big −/+/reset buttons. Independent of `this.bounds.height` (the
  // widget-column strip, which keeps its own small layout — see _drawPill).
  override get canvasBounds(): { x: number; y: number; width: number; height: number } {
    const base = super.canvasBounds
    return { ...base, height: BIG_MARGIN * 2 + this._bigSquareSize(base.width) }
  }

  override get panelBottom(): number {
    return 50 + this.canvasBounds.height + 8
  }

  // ----------------------------------------------------------
  // Controls
  // ----------------------------------------------------------

  increment(): void {
    this._count++
    this.markDirty()
  }

  decrement(): void {
    if (this._count > 0) this._count--
    this.markDirty()
  }

  reset(): void {
    this._count         = 0
    this._lastEventTime = null
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { count: this._count }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.count === 'number') this._count = state.count
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._eventSlot.isActive) {
      const src = this._eventSlot.source as EventSource
      const t   = src.getEventTime()
      // New, non-null timestamp that differs from what we last saw → pulse.
      if (t !== null && t !== this._lastEventTime) {
        this._count++
        this._lastEventTime = t
      }
    }
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._bigDecrBtnBounds(), point)) {
      this.decrement()
      return true
    }
    if (boundingBoxContains(this._bigIncrBtnBounds(), point)) {
      this.increment()
      return true
    }
    if (boundingBoxContains(this._bigResetBtnBounds(), point)) {
      this.reset()
      return true
    }
    return false
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    return boundingBoxContains(this.canvasBounds, point) ? this : null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width <= 0 || this.bounds.height <= 0) return
    this._drawPill(ctx, this.bounds)
    this._drawBigPill(ctx, this.canvasBounds)
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
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

    // [−] button
    const decrB = this._decrBtnBounds(b)
    this._drawBtn(ctx, decrB, '−',
      this._count > 0 ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.18)')

    // Count value — centred between the two stepper buttons
    const incrB  = this._incrBtnBounds(b)
    const valCx  = (decrB.x + decrB.width + incrB.x) / 2
    ctx.font         = '13px monospace'
    ctx.fillStyle    = this._eventSlot.isActive
      ? 'rgba(160,160,160,0.95)'
      : 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(this._count), valCx, midY)

    // [+] button
    this._drawBtn(ctx, incrB, '+', 'rgba(255,255,255,0.75)')

    // [↺] reset button
    this._drawIconBtn(ctx, this._resetBtnBounds(b), 'rgba(255,255,255,0.45)')

    ctx.restore()
  }

  // ── Canvas-space pill — big buttons ─────────────────────────

  private _drawBigPill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    const decrB  = this._bigDecrBtnBounds()
    const incrB  = this._bigIncrBtnBounds()
    const resetB = this._bigResetBtnBounds()

    this._drawBigGlyphBtn(ctx, decrB, '−',
      this._count > 0 ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.30)')
    this._drawBigGlyphBtn(ctx, incrB, '+', 'rgba(255,255,255,0.85)')

    // Count value — centred between the two stepper buttons
    const valCx = decrB.x + decrB.width + (incrB.x - decrB.x - decrB.width) / 2
    ctx.font         = `${Math.max(12, Math.round(decrB.height * 0.32))}px monospace`
    ctx.fillStyle    = this._eventSlot.isActive
      ? 'rgba(160,160,160,0.95)'
      : 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(this._count), valCx, decrB.y + decrB.height / 2)

    this._drawBigIconBtn(ctx, resetB, 'rgba(255,255,255,0.65)')

    ctx.restore()
  }

  private _drawBigGlyphBtn(ctx: Ctx2D, b: BBox, glyph: string, colour: string): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 6)
    ctx.fill()
    ctx.font         = `${Math.max(16, Math.round(b.height * 0.5))}px monospace`
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(glyph, b.x + b.width / 2, b.y + b.height / 2)
  }

  private _drawBigIconBtn(ctx: Ctx2D, b: BBox, colour: string): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 6)
    ctx.fill()
    ctx.fillStyle = colour
    drawIcon(ctx, 'arrow-counter-clockwise', b.x + b.width / 2, b.y + b.height / 2, Math.round(Math.min(b.width, b.height) * 0.5))
  }

  // Square size for the big buttons — shrinks to BIG_MIN on narrow panels
  // rather than wrapping, same tradeoff as TextLayer's edit/size row.
  private _bigSquareSize(pillWidth: number): number {
    const available = pillWidth - 2 * BIG_MARGIN - BIG_GAP - BIG_VALUE_W
    return Math.max(BIG_MIN, Math.min(BIG_SZ, Math.floor(available / 3)))
  }

  private _bigDecrBtnBounds(): BBox {
    const cb = this.canvasBounds
    const sq = this._bigSquareSize(cb.width)
    return { x: cb.x + BIG_MARGIN, y: cb.y + (cb.height - sq) / 2, width: sq, height: sq }
  }

  private _bigIncrBtnBounds(): BBox {
    const db = this._bigDecrBtnBounds()
    return { x: db.x + db.width + BIG_GAP + BIG_VALUE_W, y: db.y, width: db.width, height: db.height }
  }

  private _bigResetBtnBounds(): BBox {
    const cb = this.canvasBounds
    const sq = this._bigSquareSize(cb.width)
    return { x: cb.x + cb.width - BIG_MARGIN - sq, y: cb.y + (cb.height - sq) / 2, width: sq, height: sq }
  }

  // ----------------------------------------------------------
  // Private helpers — small widget-column strip only
  // ----------------------------------------------------------

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
    ctx.font         = '14px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }

  private _drawIconBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    colour: string,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    ctx.fillStyle = colour
    drawIcon(ctx, 'arrow-counter-clockwise', b.x + b.width / 2, b.y + b.height / 2, Math.min(b.width, b.height) - 8)
  }

  // Layout: [−] at left after accent stripe; [+] immediately after; [↺] at right edge.
  private _decrBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const { x, y, height } = b ?? this.bounds
    const s = BTN
    return { x: x + 10, y: y + (height - s) / 2, width: s, height: s }
  }

  private _incrBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const db = this._decrBtnBounds(b)
    return { x: db.x + BTN + BTN_G, y: db.y, width: BTN, height: BTN }
  }

  private _resetBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const { x, y, width, height } = b ?? this.bounds
    const s = BTN
    return { x: x + width - BTN_M - s, y: y + (height - s) / 2, width: s, height: s }
  }
}
