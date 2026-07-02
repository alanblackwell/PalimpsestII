import { Layer }           from '../core/Layer.js'
import { Node }            from '../core/Node.js'
import { ValueType }       from '../core/types.js'
import type { Point, Ctx2D } from '../core/types.js'
import { contentLeft }     from '../interaction/layout.js'
import { drawIcon }        from '../ui/icons.js'
import { rndColour, OUTLINE_COLOUR } from '../core/colour.js'

import { AmountLayer }     from './AmountLayer.js'
import { ColourLayer }     from './ColourLayer.js'
import { PointLayer }      from './PointLayer.js'
import { PathLayer }       from './PathLayer.js'
import { RectLayer }       from './RectLayer.js'
import { EllipseLayer }    from './EllipseLayer.js'
import { SelectLayer }     from './SelectLayer.js'
import { CountLayer }      from './CountLayer.js'
import { EventLayer }      from './EventLayer.js'
import { DirectionLayer }  from './DirectionLayer.js'
import { TextLayer }       from './TextLayer.js'
import { ImageLayer }      from './ImageLayer.js'
import { TraceLayer }      from './TraceLayer.js'
import { CompositeLayer }  from './CompositeLayer.js'
import { FilterLayer }     from './FilterLayer.js'
import { CollectionLayer } from './CollectionLayer.js'
import { NoiseLayer }      from './NoiseLayer.js'
import { FillLayer }       from './FillLayer.js'
import { TransformLayer }  from './TransformLayer.js'
import { AnimPathLayer }   from './AnimPathLayer.js'
import { ClipLayer }       from './ClipLayer.js'
import { TileLayer }       from './TileLayer.js'
import { FlashLayer }      from './FlashLayer.js'
import { VideoLayer }      from './VideoLayer.js'
import { CaptureLayer }    from './CaptureLayer.js'
import { TutorialLayer }   from './TutorialLayer.js'
import { StrokeLayer }     from './StrokeLayer.js'
import { RotateLayer }     from './RotateLayer.js'
import { LineLayer }       from './LineLayer.js'
import { WarpLayer }       from './WarpLayer.js'
import { MotionBlurLayer }    from './MotionBlurLayer.js'
import { ArtisticTestLayer } from './ArtisticTestLayer.js'

// ------------------------------------------------------------
// MenuLayer — grid of buttons that create new layers
// ------------------------------------------------------------
//
// Controls-only layer (no renderSelf content).
// renderPanel draws a button grid on the main canvas area.
// Clicking a button inserts an instance of that layer type
// immediately below this layer in the stack, then calls onAdded.

// ── Layout constants ──────────────────────────────────────────

const ACCENT      = '#888888'
const BTN_W_MAX   = 120
const BTN_W_MIN   = 64
const BTN_H       = 34
const BTN_GAP     = 7
const PANEL_Y     = 54
const HEADER_H    = 28
const PAD         = 10
const RIGHT_MARGIN = 12

// ── Randomisation helpers ─────────────────────────────────────

const rnd  = () => Math.random()
const rndR = (lo: number, hi: number) => lo + rnd() * (hi - lo)

export function rndShape(canvasW: number, canvasH: number) {
  const sw = rndR(0.10, 0.40) * canvasW
  const sh = rndR(0.10, 0.35) * canvasH
  const cx = rndR(sw / 2, canvasW - sw / 2)
  const cy = rndR(sh / 2, canvasH - sh / 2)
  return { cx, cy, sw, sh }
}

// ── Button and column types ───────────────────────────────────

type BtnDef = {
  label:              string
  colour:             string
  height?:            number   // default panel height override (px)
  kind?:              'save' | 'load'
  factory?:           (cx: number, cy: number, w: number, h: number) => Layer
  selectAfterCreate?: boolean  // select the new layer instead of keeping Menu selected
}

// A column groups related buttons.
// `top` buttons anchor to the top of the column.
// `bottom` buttons anchor to the bottom, with a gap between them and
// the top group when the column is shorter than the tallest column.
//
// On narrow canvases the rightmost column(s) are folded into their
// left neighbour so the grid still fits in the available width.
type ColDef = {
  name:   string
  top:    BtnDef[]
  bottom: BtnDef[]
}

// ── Column definitions ────────────────────────────────────────
//
// To reorder buttons:   move entries within a top[] or bottom[] array.
// To move columns:      cut/paste an entry to another column's array.
// To change pin:        move from top[] to bottom[] or vice versa.
// To add a button:      add an entry with label, colour, and factory.
// To remove a button:   delete the entry.

const COLUMNS: ColDef[] = [

  // ── Shapes ─────────────────────────────────────────────────────────
  {
    name: 'Shapes',
    top: [
      { label: 'Ellipse',  colour: '#e8a04a', factory: (_,__,w,h) => { const s = rndShape(w,h); const c = Node.geometricMode ? OUTLINE_COLOUR : rndColour(); return new EllipseLayer(s.cx, s.cy, s.sw, s.sh, c) } },
      { label: 'Path',     colour: '#e8a04a', factory: (_,__,w,h) => { const s = rndShape(w,h); const c = Node.geometricMode ? OUTLINE_COLOUR : rndColour(); return new PathLayer(undefined, s.cx, s.cy, c) } },
      { label: 'Rectangle', colour: '#e8a04a', factory: (_,__,w,h) => { const s = rndShape(w,h); const c = Node.geometricMode ? OUTLINE_COLOUR : rndColour(); return new RectLayer(s.cx, s.cy, s.sw, s.sh, c) } },
      { label: 'Text',     colour: '#888888', factory: ()          => new TextLayer(undefined, Node.geometricMode ? OUTLINE_COLOUR : rndColour()) },
      { label: 'Stroke',   colour: '#e86a4a', factory: ()          => new StrokeLayer(Node.geometricMode ? OUTLINE_COLOUR : rndColour()) },
      { label: 'Line',     colour: '#e87e7e', factory: ()          => new LineLayer(Node.geometricMode ? OUTLINE_COLOUR : rndColour()) },
    ],
    bottom: [
      { label: 'Animate',  colour: '#cf7ecf', factory: (_,__,w,h) => new AnimPathLayer(w/2, h/2) },
      { label: 'Move',      colour: '#7ecf7e', factory: (_,__,w,h) => new TransformLayer(w, h),  selectAfterCreate: true },
    ],
  },

  // ── Media ──────────────────────────────────────────────────────────
  {
    name: 'Media',
    top: [
      { label: 'Image',   colour: '#7ecf7e', factory: () => new ImageLayer(),   selectAfterCreate: true },
      { label: 'Video',   colour: '#7ecf7e', factory: () => new VideoLayer(),   selectAfterCreate: true },
      { label: 'Capture', colour: '#7ecf7e', factory: () => new CaptureLayer(), selectAfterCreate: true },
    ],
    bottom: [
//      { label: 'Mask',     colour: '#cfcf7e', factory: ()          => new MaskLayer() },
      { label: 'Clip',      colour: '#7ecf7e', factory: ()          => new ClipLayer(),          selectAfterCreate: true },
      { label: 'Blend',     colour: '#7ecf7e', factory: (_,__,w,h) => new CompositeLayer(w, h), selectAfterCreate: true },
      { label: 'Filter',    colour: '#7ecf7e', factory: ()          => new FilterLayer(),        selectAfterCreate: true },
      { label: 'Warp',       colour: '#7ecf7e', factory: ()          => new WarpLayer(),          selectAfterCreate: true },
      { label: 'Trace',     colour: '#cf9f7e', factory: ()          => new TraceLayer() },
    ],
  },

  // ── Values ─────────────────────────────────────────────────────────
  {
    name: 'Values',
    top: [
      { label: 'Colour',    colour: '#e8944a', height: 170, factory: ()          => new ColourLayer(rndColour()) },
      { label: 'Point',     colour: '#cf7ecf',              factory: (_,__,w,h) => new PointLayer({ x: rndR(0.1,0.9)*w, y: rndR(0.1,0.9)*h }) },
      { label: 'Amount',    colour: '#4a8fe8',              factory: ()          => new AmountLayer(rnd()) },
      { label: 'Angle',     colour: '#7ecfcf',              factory: ()          => new DirectionLayer(rnd() * Math.PI * 2, 1) },
    ],
    bottom: [
      { label: 'Fill',    colour: '#7ecf7e',              factory: (_,__,w,h) => new FillLayer(w, h) },
      { label: 'Tile',      colour: '#7ecf7e', factory: ()          => new TileLayer(),           selectAfterCreate: true },
      { label: 'Trail',      colour: '#7ecf7e', factory: ()          => new MotionBlurLayer(),    selectAfterCreate: true },
      { label: 'Noise',   colour: '#4a8fe8', height: 161, factory: ()          => new NoiseLayer() },
    ],
  },

  // ── Control ────────────────────────────────────────────────────────
  {
    name: 'Control',
    top: [
      { label: 'Tutorial',  colour: '#a0a4b8', factory: ()          => new TutorialLayer() },
      { label: 'Event',      colour: '#e0e060', factory: () => new EventLayer() },
      { label: 'Flash',     colour: '#e0e060', factory: ()          => new FlashLayer(), selectAfterCreate: true },
      { label: 'Index',      colour: '#a0a0a0', factory: () => new CountLayer(0) },
      { label: 'Choose',     colour: '#7ecf7e', factory: () => new SelectLayer(), selectAfterCreate: true },
      { label: 'Collect',    colour: '#7ecf7e', factory: () => new CollectionLayer() },
    ],
    bottom: [
      { label: 'Load',    colour: '#a0a4b8', kind: 'load' },
      { label: 'Save',    colour: '#a0a4b8', kind: 'save' },
      { label: 'ArtTest', colour: '#7ecf7e', factory: () => new ArtisticTestLayer(), selectAfterCreate: true },
    ],
  },
]

// ── Layers not shown in the main menu ────────────────────────
//
// These layer types exist in the codebase but are created
// programmatically rather than from the Add-layer menu:
//
//   Clip<Shape> family — ClipRectLayer, ClipEllipseLayer,
//     ClipPathLayer, ClipTextLayer, ClipDrawingLayer.
//     Auto-created by dragging a Mask card onto an Image/Fill/
//     Noise/Video layer in the stack widget.
//
//   BackgroundLayer — off-stack collection for layers that keep
//     recomputing while hidden from the stack.
//
//   ClockLayer  — singleton time source, wired at startup.
//
//   RootLayer   — bottom anchor of the layer stack.
//
//   DeletionLayer — archive for deleted/backgrounded layers;
//     appears in the stack only when the archive is non-empty.
//
//   BindingLayer — created automatically when a slot is bound
//     via drag-and-drop; not directly user-facing.
//
//   MaskLayer - usually created in support of Clip operations
//
//   RateLayer - created automatically to support animations
//
//   SequenceLayer - inherited from original Palimpsest, but doesn't
//     seem to have much utility here
//   
//   CalculateLayer - inherited from original Palimpsest, but doesn't
//     seem to have much utility here
//
//   RotateLayer - functionality now provided by rotation of Angle
//
// ── MenuLayer ─────────────────────────────────────────────────

type BBox = { x: number; y: number; width: number; height: number }
type PlacedBtn = { btn: BtnDef; bx: number; by: number; bw: number }

export class MenuLayer extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set()

  private readonly _onAdded: (layer: Layer, selectAfterCreate: boolean) => void

  private _onSave: (() => void) | null = null
  private _onLoad: (() => void) | null = null

  private _cpBounds:     BBox | null  = null
  private _btnBounds:    PlacedBtn[]  = []
  private _toggleBounds: BBox | null  = null

  constructor(onAdded: (layer: Layer, selectAfterCreate: boolean) => void) {
    super()
    this._onAdded = onAdded
    this.debugName = 'Menu'
  }

  setSaveLoadCallbacks(onSave: () => void, onLoad: () => void): void {
    this._onSave = onSave
    this._onLoad = onLoad
  }

  protected recompute(): void {}

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
    if (this._btnIndexAt(point) >= 0) return this
    if (this._toggleBounds !== null) {
      const t = this._toggleBounds
      if (point.x >= t.x && point.x <= t.x + t.width &&
          point.y >= t.y && point.y <= t.y + t.height) return this
    }
    return null
  }

  handlePointerDown(point: Point): boolean {
    if (this._toggleBounds !== null) {
      const t = this._toggleBounds
      if (point.x >= t.x && point.x <= t.x + t.width &&
          point.y >= t.y && point.y <= t.y + t.height) {
        Node.geometricMode = !Node.geometricMode
        this.markDirty()
        Node.scheduleFrame?.()
        return true
      }
    }

    const idx = this._btnIndexAt(point)
    if (idx < 0) return false

    const btn = this._btnBounds[idx]!.btn

    if (btn.kind === 'save') { this._onSave?.(); return true }
    if (btn.kind === 'load') { this._onLoad?.(); return true }

    const vw       = Node.viewportWidth
    const vh       = Node.viewportHeight
    const newLayer = btn.factory!(vw / 2, vh / 2, vw, vh)
    Layer.assignDebugName(newLayer)
    newLayer.bounds = { ...this.bounds, height: btn.height ?? this.bounds.height }

    const below = this.layerBelow
    if (below !== null) newLayer.insertAbove(below)

    this._onAdded(newLayer, btn.selectAfterCreate ?? false)
    return true
  }

  handlePointerUp(): void {}

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  // How many columns fit and how wide each button should be.
  // Starts at COLUMNS.length / BTN_W_MAX; reduces columns then
  // button width until everything fits, minimum 1 column.
  private _layout(): { cols: number; btnW: number; panX: number; panW: number } {
    const canvasW = Node.canvasWidth
    const vw      = Node.viewportWidth
    // Use the smaller of canvas and viewport so the panel left edge matches
    // the widget boundary on small viewports where canvas > viewport.
    const left    = contentLeft(Math.min(canvasW, vw))
    // Available width is based on the full canvas so all columns always fit
    // even when the canvas is wider than the viewport; the user can scroll.
    const availW  = Math.max(BTN_W_MIN + PAD * 2, canvasW - left - RIGHT_MARGIN)

    let cols = COLUMNS.length
    let btnW = BTN_W_MAX
    for (; cols > 1; cols--) {
      btnW = (availW - PAD * 2 - (cols - 1) * BTN_GAP) / cols
      if (btnW >= BTN_W_MIN) break
    }
    if (cols === 1) btnW = availW - PAD * 2
    btnW = Math.min(BTN_W_MAX, Math.max(BTN_W_MIN, btnW))

    const gridW = cols * btnW + (cols - 1) * BTN_GAP
    const panW  = gridW + PAD * 2
    // When canvas is wider than viewport, anchor panel to the left edge so
    // column 1 is immediately visible; otherwise centre as usual.
    const panX  = canvasW > vw
      ? left + PAD
      : left + Math.max(0, (availW - panW) / 2)

    return { cols, btnW, panX, panW }
  }

  // Returns the active columns, folding any columns that don't fit
  // into the rightmost active column (top[] to top[], bottom[] to bottom[]).
  private _resolveColumns(activeCols: number): { top: BtnDef[]; bottom: BtnDef[] }[] {
    const n      = Math.min(activeCols, COLUMNS.length)
    const result = COLUMNS.slice(0, n).map(c => ({ top: [...c.top], bottom: [...c.bottom] }))
    for (let c = n; c < COLUMNS.length; c++) {
      const last = result[result.length - 1]!
      last.top.push(...COLUMNS[c]!.top)
      last.bottom.push(...COLUMNS[c]!.bottom)
    }
    return result
  }

  private _btnIndexAt(point: Point): number {
    for (let i = 0; i < this._btnBounds.length; i++) {
      const { bx, by, bw } = this._btnBounds[i]!
      if (point.x >= bx && point.x <= bx + bw &&
          point.y >= by && point.y <= by + BTN_H) return i
    }
    return -1
  }

  private _drawGrid(ctx: Ctx2D): void {
    const { cols, btnW, panX, panW } = this._layout()
    const resolved  = this._resolveColumns(cols)
    const totalRows = resolved.reduce((mx, c) => Math.max(mx, c.top.length + c.bottom.length), 0)
    const gridH     = totalRows > 0 ? totalRows * BTN_H + (totalRows - 1) * BTN_GAP : 0
    const panH      = HEADER_H + PAD + gridH + PAD
    const gridX     = panX + PAD
    const gy        = PANEL_Y + HEADER_H + PAD

    this._cpBounds  = { x: panX, y: PANEL_Y, width: panW, height: panH }
    this._btnBounds = []

    const fontSize = btnW < 75 ? 9 : btnW < 95 ? 10 : 11

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(panX, PANEL_Y, panW, panH, 10)
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(panX, PANEL_Y, 4, panH, [4, 0, 0, 4])
    ctx.fill()

    ctx.fillStyle    = 'rgba(255,255,255,0.55)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Add layer', panX + 14, PANEL_Y + HEADER_H / 2)

    // Outline-mode toggle icon — top right of header, same grey as heading
    const iconSz  = 15
    const iconCX  = panX + panW - PAD - iconSz / 2
    const iconCY  = PANEL_Y + HEADER_H / 2
    this._toggleBounds = { x: iconCX - iconSz / 2 - 3, y: PANEL_Y, width: iconSz + 6, height: HEADER_H }
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    drawIcon(ctx, Node.geometricMode ? 'shapes' : 'palette', iconCX, iconCY, iconSz)

    for (let c = 0; c < resolved.length; c++) {
      const col = resolved[c]!
      const bx  = gridX + c * (btnW + BTN_GAP)

      const drawBtn = (btn: BtnDef, row: number) => {
        const by   = gy + row * (BTN_H + BTN_GAP)
        const midY = by + BTN_H / 2

        ctx.fillStyle = 'rgba(255,255,255,0.07)'
        ctx.beginPath()
        ctx.roundRect(bx, by, btnW, BTN_H, 5)
        ctx.fill()

        ctx.fillStyle = btn.colour + 'cc'
        ctx.beginPath()
        ctx.roundRect(bx, by, 3, BTN_H, [5, 0, 0, 5])
        ctx.fill()

        ctx.save()
        ctx.beginPath()
        ctx.rect(bx, by, btnW, BTN_H)
        ctx.clip()
        ctx.fillStyle    = 'rgba(255,255,255,0.85)'
        ctx.font         = `${fontSize}px monospace`
        ctx.textAlign    = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(btn.label, bx + 10, midY)
        ctx.restore()

        this._btnBounds.push({ btn, bx, by, bw: btnW })
      }

      for (let i = 0; i < col.top.length; i++) {
        drawBtn(col.top[i]!, i)
      }
      for (let i = 0; i < col.bottom.length; i++) {
        drawBtn(col.bottom[i]!, totalRows - col.bottom.length + i)
      }
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
