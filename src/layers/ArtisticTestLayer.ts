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

const COLOUR_PICKER_H = 116  // hue bar + sv square + padding

const CASE_NAMES = [
  'Case 0 — Torn paper fill',
  'Case 1 — Pencil (thin)',
  'Case 2 — Nib pen (medium)',
  'Case 3 — Brush calligraphy (thick)',
  'Case 4 — Lichtenstein stroke',
]

// Default stroke size per case, chosen for visual appearance.
// Case 2 renders at (sz - 3), Case 3 at (sz - 6), Case 4 at (sz - 5), so their defaults compensate.
const CASE_DEFAULT_SIZES = [40, 2, 8, 21, 40]

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
  private _caseIndex   = 1
  private _strokeSize  = CASE_DEFAULT_SIZES[1]!
  private _secondPass  = false

  // Per-case tunable params (copies of defaults, mutated by sliders)
  private _torn:        TornPaperParams    = { ...TORN_PAPER_DEFAULTS }
  private _pencil:      PencilParams       = { ...PENCIL_DEFAULTS }
  private _nib:         NibPenParams       = { ...NIB_PEN_DEFAULTS }
  private _brush:       BrushParams        = { ...BRUSH_DEFAULTS }
  private _lichtenstein: LichtensteinParams = { ...LICHTENSTEIN_DEFAULTS }

  // Shared stroke colour (HSV) applied to all cases
  private _hue = 210
  private _sat = 85   // HSV saturation 0–100
  private _val = 45   // HSV value/brightness 0–100
  private static _hsvToHex(h: number, s: number, v: number): string {
    s /= 100; v /= 100
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c
    let r = 0, g = 0, b = 0
    if      (h < 60)  { r = c; g = x; b = 0 }
    else if (h < 120) { r = x; g = c; b = 0 }
    else if (h < 180) { r = 0; g = c; b = x }
    else if (h < 240) { r = 0; g = x; b = c }
    else if (h < 300) { r = x; g = 0; b = c }
    else              { r = c; g = 0; b = x }
    const hex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
    return `#${hex(r)}${hex(g)}${hex(b)}`
  }
  private get _strokeColour(): string {
    return ArtisticTestLayer._hsvToHex(this._hue, this._sat, this._val)
  }

  // Main-pill button/slider bounds
  private _prevBtnB:     { x: number; y: number; width: number; height: number } | null = null
  private _nextBtnB:     { x: number; y: number; width: number; height: number } | null = null
  private _secondPassB:  { x: number; y: number; width: number; height: number } | null = null

  // Wide transition slider
  private _wideTrackB:    { x: number; y: number; width: number; height: number } | null = null
  private _dividerBounds: Array<{ x: number; y: number; width: number; height: number }> = []
  // Stroke-size values at the three dividers (Cases 1|2, 2|3, 3|4)
  private _transitionPts: [number, number, number] = [5, 13, 25]

  // Per-case pixel offset subtracted from strokeSize before rendering.
  // Defaults preserve the visual widths that were previously hardcoded inside the drawing functions.
  private _sizeOffset = [0, 0, 3, 5, 11]  // cases 0–4

  // Colour picker bounds (set during renderPanel)
  private _hueBarB:   { x: number; y: number; width: number; height: number } | null = null
  private _svSquareB: { x: number; y: number; width: number; height: number } | null = null

  // Per-case param sliders (rebuilt each renderPanel)
  private _paramSliders: ParamSlider[] = []
  // _paramDragging: -1=stroke handle, -2/-3/-4=dividers, -5=hue bar, -6=SV square, ≥0=param slider
  private _paramDragging: number | null = null

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

    const [rectPts, , sCurvePts] = makeTestPaths(w, h)
    const seed = hashString(this.debugName)
    const sz   = this._strokeSize
    const sp   = this._secondPass
    const col  = this._strokeColour
    const eff  = (n: number) => Math.max(1, sz - (this._sizeOffset[n] ?? 0))

    switch (this._caseIndex) {
      case 0: fillTornPaper(ctx,          rectPts,   col, eff(0), seed, this._torn,          sp); break
      case 1: drawPencilLine(ctx,         sCurvePts, col, eff(1), seed, this._pencil,        sp); break
      case 2: drawNibPen(ctx,             sCurvePts, col, eff(2), seed, this._nib,           sp); break
      case 3: drawCalligraphyBrush(ctx,   sCurvePts, col, eff(3), seed, this._brush,         sp); break
      case 4: drawLichtensteinStroke(ctx, sCurvePts, col, eff(4), seed, this._lichtenstein,  sp); break
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
    const wh   = 52  // wide slider pill height

    this._drawSimplePill(ctx, this.bounds)
    this._drawMainPill(ctx, left, pw, py, ph)
    this._drawWideSlider(ctx, left, py + ph + 8, wh)
    this._drawColourPicker(ctx, left, pw, py + ph + 8 + wh + 8)
    this._buildAndDrawParamPill(ctx, left, pw, py + ph + 8 + wh + 8 + COLOUR_PICKER_H + 8, ph)
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

    // Right side: colour swatch + [2nd] button
    const rightEdge  = left + pw - pad
    const secondBtnW = 36
    const swatchSz   = btnSz

    // Colour swatch — click target not needed, purely informational
    const swatchX = rightEdge - secondBtnW - 6 - swatchSz
    ctx.save()
    ctx.fillStyle = this._strokeColour
    ctx.beginPath(); ctx.roundRect(swatchX, py + (ph - swatchSz) / 2, swatchSz, swatchSz, 3); ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.roundRect(swatchX, py + (ph - swatchSz) / 2, swatchSz, swatchSz, 3); ctx.stroke()
    ctx.restore()

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
  }

  // ── Wide transition slider ────────────────────────────────────

  private _drawWideSlider(ctx: Ctx2D, left: number, py: number, ph: number): void {
    const cw      = Node.canvasWidth
    const pillW   = cw - left - 10
    const TPAD    = 18           // horizontal padding inside pill to track edges
    const trackX  = left + TPAD
    const trackW  = pillW - TPAD * 2
    const trackH  = 10
    const midY    = py + ph / 2 + 2  // slightly below centre to leave room for labels above

    // Pill background
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath(); ctx.roundRect(left, py, pillW, ph, PILL_R); ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath(); ctx.roundRect(left, py, 4, ph, [PILL_R, 0, 0, PILL_R]); ctx.fill()
    ctx.restore()

    // Helper: stroke size ↔ track x
    const sizeToX = (sz: number): number =>
      trackX + (sz - STROKE_MIN) / (STROKE_MAX - STROKE_MIN) * trackW

    // Case regions (Cases 1–4 only; Case 0 not represented here)
    const [pt0, pt1, pt2] = this._transitionPts
    const REGION_COLORS = ['#e8d44a', '#4a8fe8', '#7ecf7e', '#e87e7e']
    const regions = [
      { case: 1, from: STROKE_MIN, to: pt0,       label: 'Pencil' },
      { case: 2, from: pt0,        to: pt1,        label: 'Nib pen' },
      { case: 3, from: pt1,        to: pt2,        label: 'Brush' },
      { case: 4, from: pt2,        to: STROKE_MAX, label: 'Lichtenstein' },
    ]
    for (let i = 0; i < regions.length; i++) {
      const r  = regions[i]!
      const rx = sizeToX(r.from)
      const rw = sizeToX(r.to) - rx
      ctx.save()
      ctx.globalAlpha = this._caseIndex === r.case ? 0.18 : 0.06
      ctx.fillStyle   = REGION_COLORS[i]!
      ctx.fillRect(rx, py + 4, rw, ph - 8)
      ctx.restore()

      // Case label above track
      ctx.save()
      ctx.fillStyle     = this._caseIndex === r.case ? LABEL_COL : DIM_COL
      ctx.font          = `${this._caseIndex === r.case ? 'bold ' : ''}10px sans-serif`
      ctx.textAlign     = 'center'
      ctx.textBaseline  = 'middle'
      ctx.fillText(r.label, rx + rw / 2, py + 10)
      ctx.restore()
    }

    // Track background
    ctx.save()
    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    ctx.beginPath(); ctx.roundRect(trackX, midY - trackH / 2, trackW, trackH, 4); ctx.fill()
    ctx.restore()

    // Store track bounds for event handlers
    this._wideTrackB = { x: trackX, y: midY - trackH / 2 - 10, width: trackW, height: trackH + 20 }

    // Divider lines (between Cases 1|2, 2|3, 3|4)
    this._dividerBounds = []
    const divSizes: [number, number, number] = [pt0, pt1, pt2]
    for (let d = 0; d < 3; d++) {
      const dx = sizeToX(divSizes[d]!)
      // Hit zone
      this._dividerBounds[d] = { x: dx - 9, y: py, width: 18, height: ph }

      ctx.save()
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'
      ctx.lineWidth   = 2
      ctx.beginPath(); ctx.moveTo(dx, py + 4); ctx.lineTo(dx, py + ph - 4); ctx.stroke()

      // Triangle handle at top of divider
      ctx.fillStyle = 'rgba(255,255,255,0.90)'
      ctx.beginPath()
      ctx.moveTo(dx,     py + 4)
      ctx.lineTo(dx - 5, py + 12)
      ctx.lineTo(dx + 5, py + 12)
      ctx.closePath(); ctx.fill()

      // Pixel value label below track
      ctx.fillStyle    = LABEL_COL
      ctx.font         = 'bold 10px monospace'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(`${divSizes[d]}px`, dx, midY + trackH / 2 + 3)
      ctx.restore()
    }

    // Stroke-size thumb on the track
    const thumbX = sizeToX(this._strokeSize)
    ctx.save()
    ctx.fillStyle = '#ffffff'
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 4
    ctx.beginPath(); ctx.arc(thumbX, midY, 9, 0, Math.PI * 2); ctx.fill()
    ctx.shadowBlur = 0
    ctx.fillStyle    = '#1a1a1a'
    ctx.font         = 'bold 9px monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${this._strokeSize}`, thumbX, midY)
    ctx.restore()
  }

  // ── Colour picker ─────────────────────────────────────────────

  private _drawColourPicker(ctx: Ctx2D, left: number, pw: number, py: number): void {
    const PAD = 12
    const HH  = 14   // hue bar height
    const SVH = 72   // SV square height
    const tx  = left + PAD
    const tw  = pw - PAD * 2

    // Pill
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath(); ctx.roundRect(left, py, pw, COLOUR_PICKER_H, PILL_R); ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath(); ctx.roundRect(left, py, 4, COLOUR_PICKER_H, [PILL_R, 0, 0, PILL_R]); ctx.fill()
    ctx.restore()

    // ── Hue bar ──
    const hueY = py + PAD
    const hueGrad = ctx.createLinearGradient(tx, hueY, tx + tw, hueY)
    for (let i = 0; i <= 6; i++) hueGrad.addColorStop(i / 6, `hsl(${i * 60}, 100%, 50%)`)
    ctx.save()
    ctx.fillStyle = hueGrad
    ctx.beginPath(); ctx.roundRect(tx, hueY, tw, HH, 3); ctx.fill()
    ctx.restore()

    // Hue thumb
    const hueThumbX = tx + (this._hue / 360) * tw
    ctx.save()
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5
    ctx.beginPath(); ctx.arc(hueThumbX, hueY + HH / 2, 7, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()

    this._hueBarB = { x: tx, y: hueY - 4, width: tw, height: HH + 8 }

    // ── SV square ──
    const svY = hueY + HH + 6
    const svX = tx
    const svW = tw
    const svH = SVH
    this._svSquareB = { x: svX, y: svY, width: svW, height: svH }

    ctx.save()
    ctx.beginPath(); ctx.roundRect(svX, svY, svW, svH, 3); ctx.clip()
    // White→hue horizontal gradient
    const hvGrad = ctx.createLinearGradient(svX, svY, svX + svW, svY)
    hvGrad.addColorStop(0, '#ffffff')
    hvGrad.addColorStop(1, `hsl(${this._hue}, 100%, 50%)`)
    ctx.fillStyle = hvGrad; ctx.fillRect(svX, svY, svW, svH)
    // Transparent→black vertical gradient
    const vGrad = ctx.createLinearGradient(svX, svY, svX, svY + svH)
    vGrad.addColorStop(0, 'rgba(0,0,0,0)')
    vGrad.addColorStop(1, 'rgba(0,0,0,1)')
    ctx.fillStyle = vGrad; ctx.fillRect(svX, svY, svW, svH)
    ctx.restore()

    // Crosshair
    const cx = svX + (this._sat / 100) * svW
    const cy = svY + (1 - this._val / 100) * svH
    ctx.save()
    ctx.strokeStyle = this._val > 50 ? 'rgba(0,0,0,0.7)' : '#ffffff'; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.stroke()
    ctx.fillStyle = this._strokeColour
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill()
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

    const fwAdj = (v: number) => `${Math.round(v)}px`
    const wAdj  = (n: number): ParamSlider => ({
      label: 'width adj', value: this._sizeOffset[n] ?? 0, min: 0, max: 20, step: 1, fmt: fwAdj,
      set: v => { this._sizeOffset[n] = Math.round(v); this.markDirty() }, bounds: null,
    })

    switch (this._caseIndex) {
      case 0: return [
        wAdj(0),
        { label: 'max-width',    value: t.maxWidth,      min: 1,    max: 80,   step: 1, fmt: v => `${Math.round(v)}px`, set: v => { t.maxWidth      = Math.round(v); this.markDirty() }, bounds: null },
        { label: 'amplitude',    value: t.amplitude,     min: 0.10, max: 4.0,  step: 0, fmt: f2,              set: v => { t.amplitude     = v; this.markDirty() }, bounds: null },
        { label: 'freq ratio',   value: t.frequency,     min: 0.005, max: 0.50, step: 0, fmt: v => v.toFixed(3), set: v => { t.frequency  = v; this.markDirty() }, bounds: null },
        { label: 'stochastic',   value: t.stochasticity, min: 0.0,  max: 1.0,  step: 0, fmt: f2,              set: v => { t.stochasticity = v; this.markDirty() }, bounds: null },
        { label: 'feather px',   value: t.feather,       min: 0.0,  max: 8.0,  step: 0, fmt: f1,              set: v => { t.feather       = v; this.markDirty() }, bounds: null },
        { label: 'edge-var',     value: t.edgeVariation, min: 0.0,  max: 1.0,  step: 0, fmt: f2,              set: v => { t.edgeVariation = v; this.markDirty() }, bounds: null },
      ]
      case 1: return [
        wAdj(1),
        { label: 'min-alpha',  value: pe.minAlpha,  min: 0.00, max: 0.5, step: 0, fmt: f2, set: v => { pe.minAlpha  = v; this.markDirty() }, bounds: null },
        { label: 'max-alpha',  value: pe.maxAlpha,  min: 0.30, max: 1.0, step: 0, fmt: f2, set: v => { pe.maxAlpha  = v; this.markDirty() }, bounds: null },
        { label: 'jitter px',  value: pe.jitter,    min: 0.00, max: 6.0, step: 0, fmt: f1, set: v => { pe.jitter    = v; this.markDirty() }, bounds: null },
      ]
      case 2: return [
        wAdj(2),
        { label: 'taper-len',    value: ni.taperLength,    min: 0.0, max: 0.35, step: 0, fmt: f2,   set: v => { ni.taperLength    = v; this.markDirty() }, bounds: null },
        { label: 'nib-angle',    value: ni.nibAngle,       min:   0, max: 180,  step: 1, fmt: fdeg,  set: v => { ni.nibAngle       = v; this.markDirty() }, bounds: null },
        { label: 'min-width',    value: ni.minWidthRatio,  min: 0.0, max: 0.9,  step: 0, fmt: f2,   set: v => { ni.minWidthRatio  = v; this.markDirty() }, bounds: null },
        { label: 'width-var',    value: ni.widthVariation, min: 0.0, max: 0.6,  step: 0, fmt: f2,   set: v => { ni.widthVariation = v; this.markDirty() }, bounds: null },
        { label: 'bleed-dens',   value: ni.bleedDensity,   min: 0.0, max: 2.0,  step: 0, fmt: f2,   set: v => { ni.bleedDensity  = v; this.markDirty() }, bounds: null },
        { label: 'bleed-spread', value: ni.bleedSpread,    min: 0.0, max: 2.0,  step: 0, fmt: f2,   set: v => { ni.bleedSpread   = v; this.markDirty() }, bounds: null },
        { label: 'bleed-len-v',  value: ni.bleedLengthVar, min: 0.0, max: 1.0,  step: 0, fmt: f2,   set: v => { ni.bleedLengthVar = v; this.markDirty() }, bounds: null },
        { label: 'bleed-wid-v',  value: ni.bleedWidthVar,  min: 0.0, max: 2.0,  step: 0, fmt: f2,   set: v => { ni.bleedWidthVar  = v; this.markDirty() }, bounds: null },
        { label: 'bleed-angle',  value: ni.bleedAngle,     min:   0, max: 90,   step: 1, fmt: v => `${Math.round(v)}°`, set: v => { ni.bleedAngle = v; this.markDirty() }, bounds: null },
        { label: 'splat-dens',   value: ni.splatDensity,   min: 0.0, max: 2.0,  step: 0, fmt: f2,   set: v => { ni.splatDensity  = v; this.markDirty() }, bounds: null },
        { label: 'splat-size',   value: ni.splatterSize,   min: 0.1, max: 3.0,  step: 0, fmt: f2,   set: v => { ni.splatterSize  = v; this.markDirty() }, bounds: null },
        { label: 'feather px',   value: ni.feather,        min: 0.0, max: 8.0,  step: 0, fmt: f1,   set: v => { ni.feather       = v; this.markDirty() }, bounds: null },
      ]
      case 3: return [
        wAdj(3),
        { label: 'brush-angle', value: br.brushAngle,    min:   0, max: 180, step: 1, fmt: fdeg, set: v => { br.brushAngle    = v; this.markDirty() }, bounds: null },
        { label: 'min-width',   value: br.minWidthRatio, min: 0.0, max: 0.8, step: 0, fmt: f2,   set: v => { br.minWidthRatio = v; this.markDirty() }, bounds: null },
        { label: 'taper-len',   value: br.taperLength,   min: 0.0, max:0.35, step: 0, fmt: f2,   set: v => { br.taperLength   = v; this.markDirty() }, bounds: null },
        { label: 'edge-rough',  value: br.edgeRoughness, min: 0.0, max: 6.0, step: 0, fmt: f1,   set: v => { br.edgeRoughness = v; this.markDirty() }, bounds: null },
        { label: 'feather px',  value: br.feather,       min: 0.0, max:10.0, step: 0, fmt: f1,   set: v => { br.feather       = v; this.markDirty() }, bounds: null },
      ]
      case 4: return [
        wAdj(4),
        { label: 'stripes',     value: li.stripeCount,    min: 1,   max: 10,   step: 1, fmt: v => `${Math.round(v)}`, set: v => { li.stripeCount    = Math.round(v); this.markDirty() }, bounds: null },
        { label: 'dark-ratio',  value: li.darkWidthRatio, min: 0.1, max: 4.0,  step: 0, fmt: f2,                      set: v => { li.darkWidthRatio = v; this.markDirty() }, bounds: null },
        { label: 'taper-len',   value: li.taperLength,    min: 0.0, max: 0.70, step: 0, fmt: f2,                      set: v => { li.taperLength    = v; this.markDirty() }, bounds: null },
        { label: 'outline px',  value: li.outlineWidth,   min: 0.0, max: 8.0,  step: 0, fmt: f2,                      set: v => { li.outlineWidth   = v; this.markDirty() }, bounds: null },
        { label: 'weave',       value: li.weave,          min: 0.0, max: 1.0,  step: 0, fmt: f2,                      set: v => { li.weave          = v; this.markDirty() }, bounds: null },
        { label: 'weave-freq',  value: li.weaveFreq,      min: 0.5, max: 8.0,  step: 0, fmt: f1,                      set: v => { li.weaveFreq      = v; this.markDirty() }, bounds: null },
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
    if (this._prevBtnB    && boundingBoxContains(this._prevBtnB,    point)) return this
    if (this._nextBtnB    && boundingBoxContains(this._nextBtnB,    point)) return this
    if (this._secondPassB && boundingBoxContains(this._secondPassB, point)) return this
    for (const db of this._dividerBounds) {
      if (boundingBoxContains(db, point)) return this
    }
    if (this._wideTrackB && boundingBoxContains(this._wideTrackB,  point)) return this
    if (this._hueBarB    && boundingBoxContains(this._hueBarB,     point)) return this
    if (this._svSquareB  && boundingBoxContains(this._svSquareB,   point)) return this
    for (const sl of this._paramSliders) {
      if (sl.bounds && boundingBoxContains(sl.bounds, point)) return this
    }
    if (boundingBoxContains(this.bounds, point)) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    if (this._prevBtnB && boundingBoxContains(this._prevBtnB, point)) {
      this._caseIndex  = (this._caseIndex + 4) % 5
      this._strokeSize = CASE_DEFAULT_SIZES[this._caseIndex]!
      this.markDirty(); return true
    }
    if (this._nextBtnB && boundingBoxContains(this._nextBtnB, point)) {
      this._caseIndex  = (this._caseIndex + 1) % 5
      this._strokeSize = CASE_DEFAULT_SIZES[this._caseIndex]!
      this.markDirty(); return true
    }
    if (this._secondPassB && boundingBoxContains(this._secondPassB, point)) {
      this._secondPass = !this._secondPass
      this.markDirty(); return true
    }
    // Dividers take priority over the track handle
    for (let d = 0; d < 3; d++) {
      const db = this._dividerBounds[d]
      if (db && boundingBoxContains(db, point)) {
        this._paramDragging = -2 - d   // -2/-3/-4 = divider 0/1/2
        return true
      }
    }
    if (this._wideTrackB && boundingBoxContains(this._wideTrackB, point)) {
      this._paramDragging = -1
      this._applyMainSlider(point.x)
      return true
    }
    if (this._hueBarB && boundingBoxContains(this._hueBarB, point)) {
      this._paramDragging = -5
      this._applyHueDrag(point.x)
      return true
    }
    if (this._svSquareB && boundingBoxContains(this._svSquareB, point)) {
      this._paramDragging = -6
      this._applySVDrag(point.x, point.y)
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
    if      (this._paramDragging === -1)  this._applyMainSlider(point.x)
    else if (this._paramDragging === -5)  this._applyHueDrag(point.x)
    else if (this._paramDragging === -6)  this._applySVDrag(point.x, point.y)
    else if (this._paramDragging >= -4 && this._paramDragging <= -2)
                                          this._applyDividerDrag(-this._paramDragging - 2, point.x)
    else if (this._paramDragging >= 0)    this._applyParamSlider(this._paramDragging, point.x)
  }

  handlePointerUp(): void { this._paramDragging = null }

  private _applyMainSlider(px: number): void {
    if (!this._wideTrackB) return
    const t = Math.max(0, Math.min(1, (px - this._wideTrackB.x) / this._wideTrackB.width))
    this._strokeSize = Math.round(STROKE_MIN + t * (STROKE_MAX - STROKE_MIN))
    // Auto-switch case based on region (Case 0 is never auto-selected here)
    if (this._caseIndex !== 0) {
      const sz = this._strokeSize
      const [pt0, pt1, pt2] = this._transitionPts
      const newCase = sz < pt0 ? 1 : sz < pt1 ? 2 : sz < pt2 ? 3 : 4
      this._caseIndex = newCase
    }
    this.markDirty()
  }

  private _applyDividerDrag(divIdx: number, px: number): void {
    if (!this._wideTrackB) return
    const t  = Math.max(0, Math.min(1, (px - this._wideTrackB.x) / this._wideTrackB.width))
    const sz = Math.round(STROKE_MIN + t * (STROKE_MAX - STROKE_MIN))
    const pts = [...this._transitionPts] as [number, number, number]
    pts[divIdx] = sz
    // Enforce order: each divider must be at least 1px from its neighbours
    if (divIdx === 0) pts[0] = Math.min(Math.max(pts[0]!, STROKE_MIN + 1), pts[1]! - 1)
    if (divIdx === 1) { pts[1] = Math.max(pts[1]!, pts[0]! + 1); pts[1] = Math.min(pts[1]!, pts[2]! - 1) }
    if (divIdx === 2) pts[2] = Math.max(Math.min(pts[2]!, STROKE_MAX - 1), pts[1]! + 1)
    this._transitionPts = pts
    this.markDirty()
  }

  private _applyHueDrag(px: number): void {
    if (!this._hueBarB) return
    const t = Math.max(0, Math.min(1, (px - this._hueBarB.x) / this._hueBarB.width))
    this._hue = Math.round(t * 360) % 360
    this.markDirty()
  }

  private _applySVDrag(px: number, py: number): void {
    if (!this._svSquareB) return
    const b = this._svSquareB
    this._sat = Math.round(Math.max(0, Math.min(1, (px - b.x) / b.width)) * 100)
    this._val = Math.round(Math.max(0, Math.min(1, 1 - (py - b.y) / b.height)) * 100)
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
      transitionPts: [...this._transitionPts],
      hue: this._hue, sat: this._sat, val: this._val,
      sizeOffset: [...this._sizeOffset],
      torn: { ...this._torn }, pencil: { ...this._pencil },
      nib:  { ...this._nib  }, brush:  { ...this._brush  },
      lichtenstein: { ...this._lichtenstein },
    }
  }

  override deserializeState(s: Record<string, unknown>): void {
    if (typeof s.caseIndex  === 'number')  this._caseIndex  = s.caseIndex
    if (typeof s.strokeSize === 'number')  this._strokeSize = s.strokeSize
    if (typeof s.secondPass === 'boolean') this._secondPass = s.secondPass
    if (Array.isArray(s.transitionPts) && s.transitionPts.length === 3) {
      this._transitionPts = s.transitionPts as [number, number, number]
    }
    if (typeof s.hue === 'number') this._hue = s.hue
    if (typeof s.sat === 'number') this._sat = s.sat
    if (typeof s.val === 'number') this._val = s.val
    if (Array.isArray(s.sizeOffset)) {
      for (let i = 0; i < 5 && i < s.sizeOffset.length; i++) {
        if (typeof s.sizeOffset[i] === 'number') this._sizeOffset[i] = s.sizeOffset[i]
      }
    }
    if (s.torn         && typeof s.torn         === 'object') Object.assign(this._torn,         s.torn)
    if (s.pencil       && typeof s.pencil       === 'object') Object.assign(this._pencil,       s.pencil)
    if (s.nib          && typeof s.nib          === 'object') Object.assign(this._nib,          s.nib)
    if (s.brush        && typeof s.brush        === 'object') Object.assign(this._brush,        s.brush)
    if (s.lichtenstein && typeof s.lichtenstein === 'object') Object.assign(this._lichtenstein, s.lichtenstein)
  }
}
