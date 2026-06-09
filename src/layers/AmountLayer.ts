import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import { ValueType, type Amount, type AmountSource, type Ctx2D, type Point } from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { SliderRegion, registerPromotionFactory } from '../regions/SliderRegion.js'

// ------------------------------------------------------------
// AmountLayer — a layer that holds and exposes an Amount value
// ------------------------------------------------------------
//
// Two operating modes:
//
//   Unbound  — the value is controlled entirely by the embedded
//              SliderRegion; the user drags to change it.
//
//   Bound    — the value is driven by a source layer (the slot);
//              the slider shows the current value read-only.
//
// The layer is both a source (implements AmountSource) and a
// consumer (has one ParameterSlot for an optional Amount input).
//
// Visual layout (within bounds):
//
//   ┌──────────────────────────────────────────────┐
//   │  ○───────────●────────────  0.62             │
//   └──────────────────────────────────────────────┘
//
// The slider occupies the full width with a small inset;
// a numeric value label is drawn on the right edge.

// Register the promotion factory immediately so that any SliderRegion
// created before a full AmountLayer can still call promoteToLayer().
registerPromotionFactory((initial: Amount) => new AmountLayer(initial))

export class AmountLayer extends Layer implements AmountSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Amount])

  // Optional input binding — when active, drives the displayed value.
  private readonly _slot: ParameterSlot

  // Embedded slider widget.
  private readonly _slider: SliderRegion

  // Current output value (either from slot or from slider).
  private _value: Amount

  // Padding around the slider within the layer bounds.
  private static readonly PAD_X       = 10
  private static readonly PAD_Y       = 6
  // Space reserved on the right for the numeric label.
  private static readonly LABEL_WIDTH = 40

  constructor(initial: Amount = 0.5) {
    super()
    this._value  = initial
    this._slot   = new ParameterSlot(ValueType.Amount, this)
    this._slider = new SliderRegion(this, initial)
    this.slots.push(this._slot)
    this.debugName = 'AmountLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // AmountSource
  // ----------------------------------------------------------

  getAmount(): Amount { return this._value }

  // ----------------------------------------------------------
  // Value
  // ----------------------------------------------------------

  // Called by the embedded SliderRegion when the user drags.
  setValue(v: Amount): void {
    this._value = v
    this.markDirty()
  }

  // The parameter slot for external binding.
  get slot(): ParameterSlot { return this._slot }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._slot.isActive) {
      // Driven by a source: read its value and show in slider read-only.
      const src = this._slot.source as AmountSource
      this._value = src.getAmount()
      this._slider.displayValue = this._value
      this._slider.interactive  = false
    } else {
      // User-controlled: keep slider interactive.
      this._slider.interactive = true
      // _value is already up-to-date from setValue() / constructor.
      this._slider.displayValue = this._value
    }
    // Keep slider bounds in sync with our bounds.
    this._syncSliderBounds()
  }

  private _syncSliderBounds(): void {
    const { x, y, width, height } = this.bounds
    const px = AmountLayer.PAD_X
    const py = AmountLayer.PAD_Y
    this._slider.bounds = {
      x:      x + px,
      y:      y + py,
      width:  Math.max(0, width  - px * 2 - AmountLayer.LABEL_WIDTH),
      height: Math.max(0, height - py * 2),
    }
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.bounds
    if (width <= 0 || height <= 0) return

    // Background pill
    const r = Math.min(height / 2, 8)
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, r)
    ctx.fill()

    // Slider widget
    this._slider.renderSelf(ctx)

    // Numeric label — right-aligned, outside the slider thumb zone
    const label = this._value.toFixed(2)
    ctx.font         = '11px monospace'
    ctx.fillStyle    = this._slot.isActive ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.80)'
    ctx.textAlign    = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, x + width - 6, y + height / 2)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point) {
    return this._slider.hitTest(point)
  }
}
