import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { graph }         from '../dataflow/Graph.js'
import {
  ValueType,
  type ImageValue, type ImageSource,
  type Point, type Ctx2D,
  boundingBoxContains,
} from '../core/types.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'
import {
  hashString,
  fillTornPaper,        type TornPaperParams,    TORN_PAPER_DEFAULTS,
  drawPencilLine,       type PencilParams,        PENCIL_DEFAULTS,
  drawNibPen,           type NibPenParams,        NIB_PEN_DEFAULTS,
  drawCalligraphyBrush, type BrushParams,         BRUSH_DEFAULTS,
  drawLichtensteinStroke, type LichtensteinParams, LICHTENSTEIN_DEFAULTS,
} from './artisticBrush.js'

// ------------------------------------------------------------
// ArtisticTestLayer — evaluation harness for Cases 0–4.
// ------------------------------------------------------------
//
// Controls — main pill (canvas-space):
//   [◀] [▶]  cycle cases    [2nd] toggle second pass
//   sz slider  1–80 px
//
// Controls — params pill (below main, case-specific):
//   Case 0  Torn paper:   amplitude | frequency
//   Case 1  Pencil:       min-alpha | max-alpha | jitter
//   Case 2  Nib pen:      nib-angle | min-width | width-var | bleed-density
//   Case 3  Brush:        brush-angle | min-width | taper-len | edge-rough
//
// Each slider shows its label and current numeric value so that
// preferred values can be read off the screen and reported back.

const ACCENT    = '#7ecf7e'
const LABEL_COL = 'rgba(255,255,255,0.85)'
const DIM_COL   = 'rgba(255,255,255,0.40)'
const PILL_R    = 8

const STROKE_MIN =  1
const STROKE_MAX = 80

const CASE_NAMES = [
  'Case 0 — Torn paper fill',
  'Case 1 — Pencil (thin)',
  'Case 2 — Nib pen (medium)',
  'Case 3 — Brush calligraphy (thick)',
  'Case 4 — Lichtenstein stroke [WIP]',
]

// ── Param slider descriptor ────────────────────────────────────

interface ParamSlider {
  label:  string               // short name shown in UI
  value:  number               // current value
  min:    number
  max:    number
  step:   number               // snap increment (0 = continuous)
  fmt:    (v: number) => string  // value display string
  set:    (v: number) => void
  bounds: { x: number; y: number; width: number; height: number } | null
}

// ── Test geometry ─────────────────────────────────────────────

function makeTestPaths(w: number, h: number) {
  const cx = w / 2, cy = h / 2

  // Case 0: superellipse (rounded square silhouette)
  const rectPts: { x: number; y: number }[] = []
  const rx = cx * 0.50, ry = cy * 0.55, n = 6
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2
    const ca = Math.cos(a), sa = Math.sin(a)
    rectPts.push({
      x: cx + Math.sign(ca) * Math.pow(Math.abs(ca), 2 / n) * rx,
      y: cy + Math.sign(sa) * Math.pow(Math.abs(sa), 2 / n) * ry,
    })
  }

  // Case 1: wandering horizontal line
  const thinPts: { x: number; y: number }[] = []
  for (let i = 0; i <= 40; i++) {
    const t = i / 40
    thinPts.push({ x: cx * 0.15 + t * w * 0.70, y: cy * 0.65 + Math.sin(t * Math.PI * 2.5) * cy * 0.18 })
  }

  // Case 2: S-curve
  const sCurvePts: { x: number; y: number }[] = []
  for (let i = 0; i <= 60; i++) {
    const t = i / 60
    sCurvePts.push({ x: cx * 0.12 + t * w * 0.76, y: cy + Math.sin(t * Math.PI * 1.6) * cy * 0.38 })
  }

  // Case 3: diagonal sweep
  const sweepPts: { x: number; y: number }[] = []
  for (let i = 0; i <= 50; i++) {
    const t = i / 50
    sweepPts.push({ x: cx * 0.10 + t * w * 0.80, y: cy * 1.35 - t * cy * 0.70 + Math.sin(t * Math.PI) * cy * 0.22 })
  }

  // Case 4: bold gestural arc — wide, confident, cartoon-scale
  const boldArcPts: { x: number; y: number }[] = []
  for (let i = 0; i <= 40; i++) {
    const t = i / 40
    boldArcPts.push({ x: cx * 0.12 + t * w * 0.76, y: cy + Math.sin(t * Math.PI) * cy * 0.45 })
  }

  return [rectPts, thinPts, sCurvePts, sweepPts, boldArcPts] as const
}

// ── Layer ─────────────────────────────────────────────────────

export class ArtisticTestLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private _canvas:     OffscreenCanvas
  private _caseIndex   = 0
  private _strokeSize  = 8
  private _secondPass  = false

  // Per-case tunable params (copies of defaults, mutated by sliders)
  private _torn:        TornPaperParams    = { ...TORN_PAPER_DEFAULTS }
  private _pencil:      PencilParams       = { ...PENCIL_DEFAULTS }
  private _nib:         NibPenParams       = { ...NIB_PEN_DEFAULTS }
  private _brush:       BrushParams        = { ...BRUSH_DEFAULTS }
  private _lichtenstein: LichtensteinParams = { ...LICHTENSTEIN_DEFAULTS }

  // Main-pill button/slider bounds
  private _prevBtnB:    { x: number; y: number; width: number; height: number } | null = null
  private _nextBtnB:    { x: number; y: number; width: number; height: number } | null = null
  private _mainSliderB: { x: number; y: number; width: number; height: number } | null = null
  private _secondPassB: { x: number; y: number; width: number; height: number } | null = null

  // Per-case param sliders (rebuilt each renderPanel)
  private _paramSliders: ParamSlider[] = []
  private _paramDragging: number | null = null  // index into _paramSliders

  constructor() {
    super()
    this._canvas = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)
    this.debugName = 'ArtisticTest'
    graph.register(this)
  }

  // ── ImageSource ──────────────────────────────────────────────

  getImage(): ImageValue { return this._canvas }

  // ── Node ─────────────────────────────────────────────────────

  protected override recompute(): void {
    const w = Node.canvasWidth, h = Node.canvasHeight
    if (this._canvas.width !== w || this._canvas.height !== h) {
      this._canvas = new OffscreenCanvas(w, h)
    }
    const ctx  = this._canvas.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#f5f0e8'
    ctx.fillRect(0, 0, w, h)

    const [rectPts, thinPts, sCurvePts, sweepPts, boldArcPts] = makeTestPaths(w, h)
    const seed = hashString(this.debugName)
    const sz   = this._strokeSize
    const sp   = this._secondPass

    switch (this._caseIndex) {
      case 0: fillTornPaper(ctx,            rectPts,    '#3a5ca8', sz, seed, this._torn,          sp); break
      case 1: drawPencilLine(ctx,           thinPts,    '#222222', sz, seed, this._pencil,        sp); break
      case 2: drawNibPen(ctx,               sCurvePts,  '#111111', sz, seed, this._nib,           sp); break
      case 3: drawCalligraphyBrush(ctx,     sweepPts,   '#0a0a0a', sz, seed, this._brush,         sp); break
      case 4: drawLichtensteinStroke(ctx,   boldArcPts, '#c8102e', sz, seed, this._lichtenstein,  sp); break
    }
  }

  // ── Rendering ────────────────────────────────────────────────

  override renderSelf(ctx: Ctx2D): void {
    ctx.drawImage(this._canvas, 0, 0)
  }

  override renderPanel(ctx: Ctx2D): void {
    const left = contentLeft(Node.canvasWidth)
    const pw   = panelWidth(Node.canvasWidth)
    const py   = 50
    const ph   = this.bounds.height

    this._drawSimplePill(ctx, this.bounds)
    this._drawMainPill(ctx, left, pw, py, ph)
    this._buildAndDrawParamPill(ctx, left, pw, py + ph + 8, ph)
  }

  // ── Main control pill ─────────────────────────────────────────

  private _drawMainPill(ctx: Ctx2D, left: number, pw: number, py: number, ph: number): void {
    const pad   = 12
    const btnSz = ph - 10

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath(); ctx.roundRect(left, py, pw, ph, PILL_R); ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath(); ctx.roundRect(left, py, 4, ph, [PILL_R, 0, 0, PILL_R]); ctx.fill()
    ctx.restore()

    let cx = left + pad + 4

    // ◀ ▶ case buttons
    for (const [sym, field] of [['◀', '_prevBtnB'], ['▶', '_nextBtnB']] as const) {
      const b = { x: cx, y: py + (ph - btnSz) / 2, width: btnSz, height: btnSz }
      if (field === '_prevBtnB') this._prevBtnB = b
      else this._nextBtnB = b
      ctx.save()
      ctx.fillStyle = 'rgba(255,255,255,0.12)'
      ctx.beginPath(); ctx.roundRect(b.x, b.y, b.width, b.height, 4); ctx.fill()
      ctx.fillStyle = LABEL_COL
      ctx.font = `${btnSz * 0.6 | 0}px sans-serif`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(sym, b.x + b.width / 2, b.y + b.height / 2)
      ctx.restore()
      cx += btnSz + 4
    }

    // Case name label
    ctx.save()
    ctx.fillStyle = LABEL_COL
    ctx.font = 'bold 11px sans-serif'
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText(CASE_NAMES[this._caseIndex]!, cx + 2, py + ph / 2)
    ctx.restore()

    // Right side: [2nd] button + stroke-size slider
    const rightEdge  = left + pw - pad
    const secondBtnW = 36
    const sliderW    = 120
    const sliderH    = 6

    const secB = { x: rightEdge - secondBtnW, y: py + (ph - btnSz) / 2, width: secondBtnW, height: btnSz }
    this._secondPassB = secB
    ctx.save()
    ctx.fillStyle = this._secondPass ? 'rgba(127,207,127,0.30)' : 'rgba(255,255,255,0.10)'
    ctx.beginPath(); ctx.roundRect(secB.x, secB.y, secB.width, secB.height, 4); ctx.fill()
    ctx.fillStyle = this._secondPass ? '#7ecf7e' : DIM_COL
    ctx.font = 'bold 10px sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('2nd', secB.x + secB.width / 2, secB.y + secB.height / 2)
    ctx.restore()

    const sliderX = secB.x - sliderW - 10
    const sliderY = py + ph / 2 - 5   // shift track up slightly to leave room below
    this._mainSliderB = { x: sliderX, y: sliderY - sliderH / 2 - 4, width: sliderW, height: sliderH + 18 }
    const thumbT = (this._strokeSize - STROKE_MIN) / (STROKE_MAX - STROKE_MIN)
    this._drawSliderTrack(ctx, sliderX, sliderY, sliderW, sliderH, thumbT, null, 'right', 0)

    // Value label centred below the track
    ctx.save()
    ctx.fillStyle = LABEL_COL
    ctx.font = 'bold 10px monospace'
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.fillText(`${this._strokeSize} px`, sliderX + sliderW / 2, sliderY + sliderH / 2 + 4)
    ctx.restore()
  }

  // ── Per-case parameter pill ───────────────────────────────────

  private _buildAndDrawParamPill(ctx: Ctx2D, left: number, pw: number, py: number, _ph: number): void {
    const ROW_H  = 26
    const PAD    = 10
    const sliders = this._makeCaseSliders()
    this._paramSliders = sliders

    const pillH = sliders.length * ROW_H + PAD * 2

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.38)'
    ctx.beginPath(); ctx.roundRect(left, py, pw, pillH, PILL_R); ctx.fill()
    ctx.restore()

    // Column layout: LABEL_W | VALUE_W | slider fills rest
    const LABEL_W = 92
    const VALUE_W = 44
    const sliderX = left + PAD + LABEL_W + VALUE_W
    const sliderW = pw - PAD * 2 - LABEL_W - VALUE_W - PAD

    for (let i = 0; i < sliders.length; i++) {
      const sl   = sliders[i]!
      const rowY = py + PAD + i * ROW_H
      const midY = rowY + ROW_H / 2

      // Label
      ctx.save()
      ctx.fillStyle = DIM_COL
      ctx.font = '11px sans-serif'
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(sl.label, left + PAD, midY)
      ctx.restore()

      // Current value (highlighted)
      ctx.save()
      ctx.fillStyle = LABEL_COL
      ctx.font = 'bold 11px monospace'
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
      ctx.fillText(sl.fmt(sl.value), left + PAD + LABEL_W + VALUE_W - 4, midY)
      ctx.restore()

      // Slider track
      const sliderH = 5
      const thumbT  = Math.max(0, Math.min(1, (sl.value - sl.min) / (sl.max - sl.min)))
      sl.bounds = { x: sliderX, y: midY - sliderH / 2 - 5, width: sliderW, height: sliderH + 10 }
      this._drawSliderTrack(ctx, sliderX, midY, sliderW, sliderH, thumbT, null, 'left', 0)
    }
  }

  private _makeCaseSliders(): ParamSlider[] {
    const t = this._torn, pe = this._pencil, ni = this._nib, br = this._brush, li = this._lichtenstein
    const f2 = (v: number) => v.toFixed(2)
    const f1 = (v: number) => v.toFixed(1)
    const fdeg = (v: number) => `${Math.round(v)}°`

    switch (this._caseIndex) {
      case 0: return [
        { label: 'amplitude',    value: t.amplitude,     min: 0.10, max: 4.0,  step: 0, fmt: f2,                    set: v => { t.amplitude     = v; this.markDirty() }, bounds: null },
        { label: 'freq ratio',   value: t.frequency,     min: 0.005, max: 0.50, step: 0, fmt: v => v.toFixed(3),     set: v => { t.frequency     = v; this.markDirty() }, bounds: null },
        { label: 'stochastic',   value: t.stochasticity, min: 0.0,  max: 1.0,  step: 0, fmt: f2,                    set: v => { t.stochasticity = v; this.markDirty() }, bounds: null },
        { label: 'feather px',   value: t.feather,       min: 0.0,  max: 8.0,  step: 0, fmt: f1,                    set: v => { t.feather       = v; this.markDirty() }, bounds: null },
        { label: 'edge-var',     value: t.edgeVariation, min: 0.0,  max: 1.0,  step: 0, fmt: f2,                    set: v => { t.edgeVariation = v; this.markDirty() }, bounds: null },
      ]
      case 1: return [
        { label: 'min-alpha',  value: pe.minAlpha,  min: 0.00, max: 0.5, step: 0,    fmt: f2,   set: v => { pe.minAlpha  = v; this.markDirty() }, bounds: null },
        { label: 'max-alpha',  value: pe.maxAlpha,  min: 0.30, max: 1.0, step: 0,    fmt: f2,   set: v => { pe.maxAlpha  = v; this.markDirty() }, bounds: null },
        { label: 'jitter px',  value: pe.jitter,    min: 0.00, max: 6.0, step: 0,    fmt: f1,   set: v => { pe.jitter    = v; this.markDirty() }, bounds: null },
      ]
      case 2: return [
        { label: 'nib-angle',  value: ni.nibAngle,       min:   0, max: 180, step: 1, fmt: fdeg, set: v => { ni.nibAngle       = v; this.markDirty() }, bounds: null },
        { label: 'min-width',  value: ni.minWidthRatio,  min: 0.0, max: 0.9, step: 0, fmt: f2,   set: v => { ni.minWidthRatio   = v; this.markDirty() }, bounds: null },
        { label: 'width-var',  value: ni.widthVariation, min: 0.0, max: 0.6, step: 0, fmt: f2,   set: v => { ni.widthVariation  = v; this.markDirty() }, bounds: null },
        { label: 'bleed-dens',   value: ni.bleedDensity,  min: 0.0, max: 2.0,  step: 0, fmt: f2,   set: v => { ni.bleedDensity  = v; this.markDirty() }, bounds: null },
        { label: 'bleed-spread', value: ni.bleedSpread,   min: 0.0, max: 2.0,  step: 0, fmt: f2,   set: v => { ni.bleedSpread   = v; this.markDirty() }, bounds: null },
        { label: 'bleed-len-v', value: ni.bleedLengthVar, min: 0.0, max: 1.0, step: 0, fmt: f2,   set: v => { ni.bleedLengthVar = v; this.markDirty() }, bounds: null },
        { label: 'bleed-wid-v', value: ni.bleedWidthVar,  min: 0.0, max: 2.0, step: 0, fmt: f2,   set: v => { ni.bleedWidthVar  = v; this.markDirty() }, bounds: null },
        { label: 'bleed-angle', value: ni.bleedAngle,     min: 0,   max: 90,  step: 1, fmt: v => `${Math.round(v)}°`, set: v => { ni.bleedAngle = v; this.markDirty() }, bounds: null },
        { label: 'splat-dens',   value: ni.splatDensity,  min: 0.0, max: 2.0, step: 0, fmt: f2,   set: v => { ni.splatDensity  = v; this.markDirty() }, bounds: null },
        { label: 'splat-size',   value: ni.splatterSize,  min: 0.1, max: 3.0, step: 0, fmt: f2,   set: v => { ni.splatterSize  = v; this.markDirty() }, bounds: null },
        { label: 'feather px',   value: ni.feather,       min: 0.0, max: 8.0, step: 0, fmt: f1,   set: v => { ni.feather       = v; this.markDirty() }, bounds: null },
      ]
      case 3: return [
        { label: 'brush-angle', value: br.brushAngle,    min:   0, max: 180, step: 1, fmt: fdeg, set: v => { br.brushAngle    = v; this.markDirty() }, bounds: null },
        { label: 'min-width',   value: br.minWidthRatio, min: 0.0, max: 0.8, step: 0, fmt: f2,   set: v => { br.minWidthRatio = v; this.markDirty() }, bounds: null },
        { label: 'taper-len',   value: br.taperLength,   min: 0.0, max:0.35, step: 0, fmt: f2,   set: v => { br.taperLength   = v; this.markDirty() }, bounds: null },
        { label: 'edge-rough',  value: br.edgeRoughness, min: 0.0, max: 6.0, step: 0, fmt: f1,   set: v => { br.edgeRoughness = v; this.markDirty() }, bounds: null },
        { label: 'feather px',  value: br.feather,       min: 0.0, max:10.0, step: 0, fmt: f1,   set: v => { br.feather       = v; this.markDirty() }, bounds: null },
      ]
      case 4: return [
        { label: 'highlight',    value: li.highlightRatio,      min: 0.0, max: 0.5, step: 0, fmt: f2, set: v => { li.highlightRatio      = v; this.markDirty() }, bounds: null },
        { label: 'hi-bright',    value: li.highlightBrightness, min: 1.0, max: 3.0, step: 0, fmt: f2, set: v => { li.highlightBrightness = v; this.markDirty() }, bounds: null },
        { label: 'outline px',   value: li.outlineWidth,        min: 0.0, max: 8.0, step: 0, fmt: f2, set: v => { li.outlineWidth        = v; this.markDirty() }, bounds: null },
      ]
      default: return []
    }
  }

  // ── Shared slider drawing util ────────────────────────────────

  private _drawSliderTrack(
    ctx:     Ctx2D,
    x:       number,
    midY:    number,
    w:       number,
    h:       number,
    thumbT:  number,
    label:   string | null,
    labelAlign: 'left' | 'right',
    labelX:  number,
  ): void {
    ctx.save()
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    ctx.beginPath(); ctx.roundRect(x, midY - h / 2, w, h, 3); ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath(); ctx.roundRect(x, midY - h / 2, thumbT * w, h, 3); ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath(); ctx.arc(x + thumbT * w, midY, 6, 0, Math.PI * 2); ctx.fill()
    if (label !== null) {
      ctx.fillStyle = DIM_COL
      ctx.font = '10px sans-serif'
      ctx.textAlign = labelAlign; ctx.textBaseline = 'middle'
      ctx.fillText(label, labelX, midY)
    }
    ctx.restore()
  }

  // ── Strip label pill ──────────────────────────────────────────

  private _drawSimplePill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath(); ctx.roundRect(b.x, b.y, b.width, b.height, PILL_R); ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath(); ctx.roundRect(b.x, b.y, 4, b.height, [PILL_R, 0, 0, PILL_R]); ctx.fill()
    ctx.fillStyle = LABEL_COL
    ctx.font = 'bold 12px sans-serif'
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText('Artistic Test', b.x + 14, b.y + b.height / 2)
    ctx.restore()
  }

  // ── Interaction ───────────────────────────────────────────────

  protected override hitTestSelf(point: Point): this | null {
    if (this._prevBtnB    && boundingBoxContains(this._prevBtnB, point))    return this
    if (this._nextBtnB    && boundingBoxContains(this._nextBtnB, point))    return this
    if (this._mainSliderB && boundingBoxContains(this._mainSliderB, point)) return this
    if (this._secondPassB && boundingBoxContains(this._secondPassB, point)) return this
    for (const sl of this._paramSliders) {
      if (sl.bounds && boundingBoxContains(sl.bounds, point)) return this
    }
    if (boundingBoxContains(this.bounds, point)) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    if (this._prevBtnB && boundingBoxContains(this._prevBtnB, point)) {
      this._caseIndex = (this._caseIndex + 4) % 5
      this.markDirty(); return true
    }
    if (this._nextBtnB && boundingBoxContains(this._nextBtnB, point)) {
      this._caseIndex = (this._caseIndex + 1) % 5
      this.markDirty(); return true
    }
    if (this._secondPassB && boundingBoxContains(this._secondPassB, point)) {
      this._secondPass = !this._secondPass
      this.markDirty(); return true
    }
    if (this._mainSliderB && boundingBoxContains(this._mainSliderB, point)) {
      this._paramDragging = -1  // -1 = main stroke slider
      this._applyMainSlider(point.x)
      return true
    }
    for (let i = 0; i < this._paramSliders.length; i++) {
      const sl = this._paramSliders[i]!
      if (sl.bounds && boundingBoxContains(sl.bounds, point)) {
        this._paramDragging = i
        this._applyParamSlider(i, point.x)
        return true
      }
    }
    return false
  }

  handlePointerMove(point: Point): void {
    if (this._paramDragging === null) return
    if (this._paramDragging === -1) this._applyMainSlider(point.x)
    else this._applyParamSlider(this._paramDragging, point.x)
  }

  handlePointerUp(): void { this._paramDragging = null }

  private _applyMainSlider(px: number): void {
    if (!this._mainSliderB) return
    const t = Math.max(0, Math.min(1, (px - this._mainSliderB.x) / this._mainSliderB.width))
    this._strokeSize = Math.round(STROKE_MIN + t * (STROKE_MAX - STROKE_MIN))
    this.markDirty()
  }

  private _applyParamSlider(idx: number, px: number): void {
    const sl = this._paramSliders[idx]
    if (!sl?.bounds) return
    let t = Math.max(0, Math.min(1, (px - sl.bounds.x) / sl.bounds.width))
    let v = sl.min + t * (sl.max - sl.min)
    if (sl.step > 0) v = Math.round(v / sl.step) * sl.step
    sl.set(v)
  }

  // ── Persistence ───────────────────────────────────────────────

  override serializeState(): Record<string, unknown> {
    return {
      caseIndex: this._caseIndex, strokeSize: this._strokeSize, secondPass: this._secondPass,
      torn: { ...this._torn }, pencil: { ...this._pencil },
      nib:  { ...this._nib  }, brush:  { ...this._brush  },
      lichtenstein: { ...this._lichtenstein },
    }
  }

  override deserializeState(s: Record<string, unknown>): void {
    if (typeof s.caseIndex  === 'number')  this._caseIndex  = s.caseIndex
    if (typeof s.strokeSize === 'number')  this._strokeSize = s.strokeSize
    if (typeof s.secondPass === 'boolean') this._secondPass = s.secondPass
    if (s.torn         && typeof s.torn         === 'object') Object.assign(this._torn,         s.torn)
    if (s.pencil       && typeof s.pencil       === 'object') Object.assign(this._pencil,       s.pencil)
    if (s.nib          && typeof s.nib          === 'object') Object.assign(this._nib,          s.nib)
    if (s.brush        && typeof s.brush        === 'object') Object.assign(this._brush,        s.brush)
    if (s.lichtenstein && typeof s.lichtenstein === 'object') Object.assign(this._lichtenstein, s.lichtenstein)
  }
}
