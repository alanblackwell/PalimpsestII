import { Layer }           from '../core/Layer.js'
import { ValueType }       from '../core/types.js'
import type { Point, Ctx2D } from '../core/types.js'

import { AmountLayer }     from './AmountLayer.js'
import { ColourLayer }     from './ColourLayer.js'
import { PointLayer }      from './PointLayer.js'
import { ClockLayer }      from './ClockLayer.js'
import { RateLayer }       from './RateLayer.js'
import { PathLayer }       from './PathLayer.js'
import { RectLayer }       from './RectLayer.js'
import { EllipseLayer }    from './EllipseLayer.js'
import { SelectLayer }     from './SelectLayer.js'
import { CountLayer }      from './CountLayer.js'
import { EventLayer }      from './EventLayer.js'
import { DirectionLayer }  from './DirectionLayer.js'
import { MathLayer }       from './MathLayer.js'
import { TextLayer }       from './TextLayer.js'
import { ImageLayer }      from './ImageLayer.js'
import { MaskLayer }       from './MaskLayer.js'
import { CompositeLayer }  from './CompositeLayer.js'
import { FilterLayer }     from './FilterLayer.js'
import { CollectionLayer } from './CollectionLayer.js'
import { NoiseLayer }      from './NoiseLayer.js'
import { GradientLayer }   from './GradientLayer.js'
import { TransformLayer }  from './TransformLayer.js'
import { SequencerLayer }  from './SequencerLayer.js'

// ------------------------------------------------------------
// MenuLayer — grid of buttons that create new layers
// ------------------------------------------------------------
//
// Controls-only layer (no renderSelf content).
// renderPanel draws a button grid on the main canvas area.
// Clicking a button inserts an instance of that layer type
// immediately below this layer in the stack, then calls onAdded.
//
// The caller (main.ts) uses onAdded to refresh the widget,
// evaluator, and interaction system.

// ── Constants ─────────────────────────────────────────────────

const ACCENT   = '#888888'

// Button grid layout (canvas-space)
const COLS     = 4
const BTN_W    = 120
const BTN_H    = 34
const BTN_GAP  = 7
const PANEL_X  = 308    // left edge of grid (just right of the strip)
const PANEL_Y  = 54     // top of panel
const HEADER_H = 28     // height of the "Add layer" title row
const PAD      = 10     // inner padding below header

// ── Button definitions ─────────────────────────────────────────

type BtnDef = {
  label:   string
  colour:  string
  factory: (cx: number, cy: number, w: number, h: number) => Layer
}

const BUTTONS: BtnDef[] = [
  { label: 'Amount',     colour: '#4a8fe8', factory: ()          => new AmountLayer(0.5) },
  { label: 'Colour',     colour: '#e8944a', factory: ()          => new ColourLayer({ r: 0.5, g: 0.5, b: 0.5, a: 1 }) },
  { label: 'Point',      colour: '#cf7ecf', factory: (cx, cy)    => new PointLayer({ x: cx, y: cy }) },
  { label: 'Clock',      colour: '#e87e7e', factory: ()          => new ClockLayer() },
  { label: 'Rate',       colour: '#e87e7e', factory: ()          => new RateLayer(0.5) },
  { label: 'Event',      colour: '#e0e060', factory: ()          => new EventLayer() },
  { label: 'Count',      colour: '#a0a0a0', factory: ()          => new CountLayer(0) },
  { label: 'Select',     colour: '#4a8fe8', factory: ()          => new SelectLayer() },
  { label: 'Direction',  colour: '#7ecfcf', factory: ()          => new DirectionLayer(0, 0.5) },
  { label: 'Math',       colour: '#4a8fe8', factory: ()          => new MathLayer(2) },
  { label: 'Collection', colour: '#a0a4b8', factory: ()          => new CollectionLayer([0.25, 0.5, 0.75, 1.0]) },
  { label: 'Sequencer',  colour: '#a0a4b8', factory: (_,__,w,h)  => new SequencerLayer(w, h) },
  { label: 'Path',       colour: '#e8a04a', factory: (cx, cy)    => new PathLayer(undefined, cx, cy) },
  { label: 'Rect',       colour: '#e8a04a', factory: (cx, cy)    => new RectLayer(cx, cy, 200, 120) },
  { label: 'Ellipse',    colour: '#e8a04a', factory: (cx, cy)    => new EllipseLayer(cx, cy, 160, 100) },
  { label: 'Text',       colour: '#888888', factory: ()          => new TextLayer('Text') },
  { label: 'Image',      colour: '#7ecf7e', factory: ()          => new ImageLayer() },
  { label: 'Mask',       colour: '#cfcf7e', factory: (_,__,w,h)  => new MaskLayer(w, h) },
  { label: 'Composite',  colour: '#7ecf7e', factory: (_,__,w,h)  => new CompositeLayer(w, h) },
  { label: 'Filter',     colour: '#7ecf7e', factory: (_,__,w,h)  => new FilterLayer(w, h) },
  { label: 'Noise',      colour: '#4a8fe8', factory: ()          => new NoiseLayer() },
  { label: 'Gradient',   colour: '#7ecf7e', factory: (_,__,w,h)  => new GradientLayer(w, h) },
  { label: 'Transform',  colour: '#7ecf7e', factory: (_,__,w,h)  => new TransformLayer(w, h) },
]

// ── MenuLayer ──────────────────────────────────────────────────

type BBox = { x: number; y: number; width: number; height: number }

export class MenuLayer extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set()

  private readonly _canvasW: number
  private readonly _canvasH: number
  private readonly _onAdded: (layer: Layer) => void

  // Bounding box of the entire panel (set during renderPanel, used for hit testing)
  private _cpBounds: BBox | null = null

  constructor(canvasW: number, canvasH: number, onAdded: (layer: Layer) => void) {
    super()
    this._canvasW = canvasW
    this._canvasH = canvasH
    this._onAdded = onAdded
    this.debugName = 'Menu'
  }

  protected recompute(): void {}

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(_ctx: Ctx2D): void {}

  renderPanel(ctx: Ctx2D): void {
    this._drawPill(ctx, this.bounds)
    this._drawGrid(ctx)
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    if (this._cpBounds === null) return null
    const b = this._cpBounds
    if (point.x < b.x || point.x > b.x + b.width ||
        point.y < b.y || point.y > b.y + b.height) return null
    return this._btnIndexAt(point) >= 0 ? this : null
  }

  handlePointerDown(point: Point): boolean {
    const idx = this._btnIndexAt(point)
    if (idx < 0) return false

    const btn     = BUTTONS[idx]!
    const cx      = this._canvasW / 2
    const cy      = this._canvasH / 2
    const newLayer = btn.factory(cx, cy, this._canvasW, this._canvasH)
    newLayer.debugName = btn.label
    newLayer.bounds    = { ...this.bounds }

    const below = this.layerBelow
    if (below !== null) newLayer.insertAbove(below)

    this._onAdded(newLayer)
    return true
  }

  handlePointerUp(): void {}

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _btnIndexAt(point: Point): number {
    const gy = PANEL_Y + HEADER_H + PAD
    for (let i = 0; i < BUTTONS.length; i++) {
      const col = i % COLS
      const row = Math.floor(i / COLS)
      const bx  = PANEL_X + col * (BTN_W + BTN_GAP)
      const by  = gy       + row * (BTN_H + BTN_GAP)
      if (point.x >= bx && point.x <= bx + BTN_W &&
          point.y >= by && point.y <= by + BTN_H) return i
    }
    return -1
  }

  private _drawGrid(ctx: Ctx2D): void {
    const rows  = Math.ceil(BUTTONS.length / COLS)
    const gridW = COLS * BTN_W + (COLS - 1) * BTN_GAP
    const gridH = rows * BTN_H + (rows - 1) * BTN_GAP
    const panW  = gridW + PAD * 2
    const panH  = HEADER_H + PAD + gridH + PAD
    const panX  = PANEL_X - PAD

    this._cpBounds = { x: panX, y: PANEL_Y, width: panW, height: panH }

    ctx.save()

    // Panel background
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(panX, PANEL_Y, panW, panH, 10)
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(panX, PANEL_Y, 4, panH, [4, 0, 0, 4])
    ctx.fill()

    // Header label
    ctx.fillStyle    = 'rgba(255,255,255,0.55)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Add layer', panX + 14, PANEL_Y + HEADER_H / 2)

    // Buttons
    const gy = PANEL_Y + HEADER_H + PAD

    for (let i = 0; i < BUTTONS.length; i++) {
      const btn  = BUTTONS[i]!
      const col  = i % COLS
      const row  = Math.floor(i / COLS)
      const bx   = PANEL_X + col * (BTN_W + BTN_GAP)
      const by   = gy       + row * (BTN_H + BTN_GAP)
      const midY = by + BTN_H / 2

      // Button background
      ctx.fillStyle = 'rgba(255,255,255,0.07)'
      ctx.beginPath()
      ctx.roundRect(bx, by, BTN_W, BTN_H, 5)
      ctx.fill()

      // Colour-coded left stripe
      ctx.fillStyle = btn.colour + 'cc'
      ctx.beginPath()
      ctx.roundRect(bx, by, 3, BTN_H, [5, 0, 0, 5])
      ctx.fill()

      // Label
      ctx.fillStyle    = 'rgba(255,255,255,0.85)'
      ctx.font         = '11px monospace'
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(btn.label, bx + 10, midY)
    }

    ctx.restore()
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
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Add layer  ⊕', x + 12, y + height / 2)
    ctx.restore()
  }
}
