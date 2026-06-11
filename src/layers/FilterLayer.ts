import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type Amount,     type AmountSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { SliderRegion } from '../regions/SliderRegion.js'

// ------------------------------------------------------------
// FilterLayer — applies a CSS image filter to an ImageSource
// ------------------------------------------------------------
//
// Reads sourceSlot (Image), draws it into an OffscreenCanvas with
// a CSS filter applied, and returns the result from getImage().
//
// Filter is selected with [◀] / [▶] (or clicking the label).
// Intensity is controlled by an embedded SliderRegion (manual) or
// overridden by the intensitySlot (Amount) when bound.
//
// Filters (8):
//   blur        — 0→0 px, 1→20 px Gaussian blur
//   brightness  — 0→0×, 0.5→1× (neutral), 1→2×
//   contrast    — 0→0×, 0.5→1× (neutral), 1→2×
//   saturate    — 0→0×, 0.5→1× (neutral), 1→3×
//   hue-rotate  — 0→0°, 1→360° colour shift
//   grayscale   — 0→colour, 1→full grey
//   invert      — 0→normal, 1→fully inverted
//   sepia       — 0→normal, 1→full sepia
//
// Visual layout (height ≈ 40 px):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌  [◀]  blur  [▶]   [======= intensity =======]  0.25  │
//   └──────────────────────────────────────────────────────────┘
//
// Call resize(w, h) when the canvas dimensions change.

// ------------------------------------------------------------------
// Filter table
// ------------------------------------------------------------------

interface Filter {
  readonly label:    string
  readonly defaultT: number
  readonly css:      (t: number) => string
}

const FILTERS: readonly Filter[] = [
  {
    label: 'blur',
    defaultT: 0.25,
    css: t => `blur(${(t * 20).toFixed(1)}px)`,
  },
  {
    label: 'brightness',
    defaultT: 0.5,
    css: t => `brightness(${(t * 2).toFixed(3)})`,
  },
  {
    label: 'contrast',
    defaultT: 0.5,
    css: t => `contrast(${(t * 2).toFixed(3)})`,
  },
  {
    label: 'saturate',
    defaultT: 0.5,
    css: t => `saturate(${(t * 3).toFixed(3)})`,
  },
  {
    label: 'hue-rotate',
    defaultT: 0.25,
    css: t => `hue-rotate(${Math.round(t * 360)}deg)`,
  },
  {
    label: 'grayscale',
    defaultT: 1.0,
    css: t => `grayscale(${t.toFixed(3)})`,
  },
  {
    label: 'invert',
    defaultT: 1.0,
    css: t => `invert(${t.toFixed(3)})`,
  },
  {
    label: 'sepia',
    defaultT: 1.0,
    css: t => `sepia(${t.toFixed(3)})`,
  },
]

// ------------------------------------------------------------------
// Layout constants
// ------------------------------------------------------------------

const ACCENT   = '#7ecf7e'   // Image type colour
const BTN_W    = 18
const BTN_H    = 22
const LABEL_W  = 68          // filter name zone width
const PAD_X    = 8
const PAD_Y    = 7
const VAL_W    = 42          // right-side value label width
const BTN_M    = 6           // right margin

// ------------------------------------------------------------------
// FilterLayer
// ------------------------------------------------------------------

export class FilterLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _sourceSlot:    ParameterSlot
  private readonly _intensitySlot: ParameterSlot
  private readonly _slider:        SliderRegion

  private _filterIndex: number = 0
  private _intensity:   number = FILTERS[0].defaultT
  private _offscreen:   OffscreenCanvas

  constructor(canvasWidth = 1920, canvasHeight = 1080) {
    super()
    this._offscreen      = new OffscreenCanvas(canvasWidth, canvasHeight)
    this._sourceSlot     = new ParameterSlot(ValueType.Image,  this)
    this._intensitySlot  = new ParameterSlot(ValueType.Amount, this)
    this._slider         = new SliderRegion(this, this._intensity)
    this.slots.push(this._sourceSlot, this._intensitySlot)
    this.debugName = 'FilterLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._offscreen }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get sourceSlot():    ParameterSlot { return this._sourceSlot    }
  get intensitySlot(): ParameterSlot { return this._intensitySlot }

  // ----------------------------------------------------------
  // Filter cycling
  // ----------------------------------------------------------

  cycleNext(): void {
    this._filterIndex = (this._filterIndex + 1) % FILTERS.length
    const def = FILTERS[this._filterIndex].defaultT
    this._intensity = def
    this._slider.displayValue = def
    this.markDirty()
  }

  cyclePrev(): void {
    this._filterIndex = (this._filterIndex - 1 + FILTERS.length) % FILTERS.length
    const def = FILTERS[this._filterIndex].defaultT
    this._intensity = def
    this._slider.displayValue = def
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Resize
  // ----------------------------------------------------------

  resize(w: number, h: number): void {
    this._offscreen = new OffscreenCanvas(w, h)
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Called by SliderRegion when the user drags
  // ----------------------------------------------------------

  setValue(v: Amount): void {
    this._intensity = v
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._intensitySlot.isActive) {
      this._intensity = (this._intensitySlot.source as AmountSource).getAmount() as Amount
      this._slider.displayValue = this._intensity
      this._slider.interactive  = false
    } else {
      this._slider.interactive  = true
      this._slider.displayValue = this._intensity
    }

    this._syncSliderBounds()
    this._applyFilter()
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._prevBtnBounds(), point)) { this.cyclePrev(); return true }
    if (boundingBoxContains(this._nextBtnBounds(), point)) { this.cycleNext(); return true }
    if (boundingBoxContains(this._labelBounds(), point))   { this.cycleNext(); return true }
    // Delegate to slider for intensity drag
    return this._slider.handlePointerDown(point)
  }

  handlePointerMove(point: Point): void {
    this._slider.handlePointerMove(point)
  }

  handlePointerUp(): void {
    this._slider.handlePointerUp()
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    return boundingBoxContains(this.canvasBounds, point) ? this : null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    // Blit filtered result to main canvas
    ctx.save()
    ctx.drawImage(this._offscreen as CanvasImageSource, 0, 0)
    ctx.restore()
  }

  // ── Stack panel ─────────────────────────────────────────────

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds
    if (width <= 0 || height <= 0) return

    const midY   = y + height / 2
    const filter = FILTERS[this._filterIndex]

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.50)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = this._sourceSlot.isActive ? ACCENT : 'rgba(126,207,126,0.35)'
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // [◀] prev
    this._drawNavBtn(ctx, this._prevBtnBounds(), '◀', midY)

    // Filter name label
    const lb = this._labelBounds()
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(lb.x, lb.y, lb.width, lb.height, 3)
    ctx.fill()
    ctx.font         = '11px monospace'
    ctx.fillStyle    = this._sourceSlot.isActive
      ? 'rgba(255,255,255,0.90)' : 'rgba(255,255,255,0.40)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(filter.label, lb.x + lb.width / 2, midY)

    // [▶] next
    this._drawNavBtn(ctx, this._nextBtnBounds(), '▶', midY)

    // Intensity slider
    this._slider.renderSelf(ctx)

    // Intensity value label
    const valX = x + width - BTN_M
    ctx.font         = '11px monospace'
    ctx.fillStyle    = this._intensitySlot.isActive
      ? 'rgba(126,207,126,0.85)' : 'rgba(255,255,255,0.70)'
    ctx.textAlign    = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(this._intensity.toFixed(2), valX, midY)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _applyFilter(): void {
    const oc   = this._offscreen
    const ctx  = oc.getContext('2d')! as CanvasRenderingContext2D
    const w    = oc.width
    const h    = oc.height
    const src  = this._sourceSlot.isActive
      ? (this._sourceSlot.source as ImageSource).getImage()
      : null

    ctx.clearRect(0, 0, w, h)
    if (src === null) return

    const filterStr = FILTERS[this._filterIndex].css(this._intensity)
    ctx.filter  = filterStr
    ctx.drawImage(src as CanvasImageSource, 0, 0, w, h)
    ctx.filter  = 'none'
  }

  private _syncSliderBounds(): void {
    const { x, y, width, height } = this.bounds
    // Slider starts after the [▶] button and ends before the value label.
    const sliderX = this._nextBtnBounds().x + BTN_W + PAD_X
    const sliderR = x + width - BTN_M - VAL_W - 4
    this._slider.bounds = {
      x:      sliderX,
      y:      y + PAD_Y,
      width:  Math.max(0, sliderR - sliderX),
      height: Math.max(0, height - PAD_Y * 2),
    }
  }

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

  private _prevBtnBounds() {
    const { x, y, height } = this.canvasBounds
    return { x: x + PAD_X, y: y + (height - BTN_H) / 2, width: BTN_W, height: BTN_H }
  }

  private _labelBounds() {
    const pb = this._prevBtnBounds()
    return { x: pb.x + BTN_W + 4, y: pb.y, width: LABEL_W, height: BTN_H }
  }

  private _nextBtnBounds() {
    const lb = this._labelBounds()
    return { x: lb.x + LABEL_W + 4, y: lb.y, width: BTN_W, height: BTN_H }
  }
}
