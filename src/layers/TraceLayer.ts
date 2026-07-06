import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type Amount,
  type Colour,
  type ImageValue, type ImageSource,
  type MaskValue, type MaskSource,
  type Point, type PointSource,
  type Ctx2D,
} from '../core/types.js'
import { graph }         from '../dataflow/Graph.js'
import { BindingLayer }  from './BindingLayer.js'
import { SliderRegion }  from '../regions/SliderRegion.js'
import { contentLeft }   from '../interaction/layout.js'
// import { detectContour } from './contourTrace.js'  // mothballed — see _detectPath
import { detectByGradient } from './gradientTrace.js'

// ------------------------------------------------------------
// TraceLayer — closed path traced from the boundary of a mask
// (or, when no mask is supplied, the largest connected region in
// a thresholded grayscale image).
// ------------------------------------------------------------
//
// Outputs: Point (phase position on perimeter) + Mask + Image —
// the same type set as ShapeLayer, so it plugs into any consumer
// that accepts a shape (AnimPath shapeSlot, MaskLayer shape slot,
// CompositeLayer, etc.).
//
// Pipeline (mask present):
//   1. Downsample mask to PROC_SIZE work buffer.
//   2. Moore's neighbour boundary tracing → ordered perimeter chain.
//   3. Uniform arc-length resample to N control points.
//   4. Scale back to canvas coords → 1-pass smooth → Catmull-Rom.
//
// Pipeline (no mask):
//   1. Downsample image, convert to greyscale.
//   2. Gaussian blur → Otsu threshold → binary.
//   3. Largest 4-connected component → same boundary trace.
//
// Detection inputs:
//   imageSlot (Image)  — source bitmap
//   maskSlot  (Mask)   — optional; preferred shape source
//
// Shape rendering inputs (like PathLayer):
//   phaseSlot       (Amount) — position along perimeter [0, 1]
//   colourSlot      (Colour)
//   opacitySlot     (Amount)
//   fillModeSlot    (Event)  — each pulse toggles fill ↔ outline
//   strokeWidthSlot (Amount)

const ACCENT      = '#e8a04a'   // shape amber — matches Rect/Ellipse/Path
const DIR_ACCENT  = '#7ecfcf'
const CAPTURE_W   = 72
const CAPTURE_H   = 26
const PATH_BTN_W  = 60   // "Path" convenience button width
const CLIP_BTN_W  = 60   // "Clip" convenience button width
const CONV_BTN_GAP_X = 8   // gap between Path and Clip buttons
const CONV_BTN_H  = 30   // viewport-bottom convenience button height
const CONV_BTN_GAP = 14  // gap from viewport bottom edge
// const MIN_POINTS = 4   // mothballed boundary-trace constants
// const MAX_POINTS = 32
// const DEF_POINTS = 10
const MIN_RAYS    = 4
const MAX_RAYS    = 16
const DEF_RAYS    = 8
const MIN_SMOOTH  = 1
const MAX_SMOOTH  = 20
const DEF_SMOOTH  = 5
const MIN_SIZE    = 64
const MAX_SIZE    = 512
const DEF_SIZE    = 256
const RENDER_PTS = 200
const BTN_W      = 54
const BTN_H      = 22
const BTN_M      = 6
const CP_R       = 6    // control-point handle radius
const HIT_R      = 14   // pointer hit radius
const ROT_OFF    = 24   // rotate handle offset beyond max radius

// Parameter-control pill (rays / smth / size / bias / circ sliders)
const CPILL_ROW_H  = 26
const CPILL_GAP    = 4
const CPILL_PAD    = 6
const CPILL_LBL_W  = 36
const CPILL_VAL_W  = 32
const CPILL_H      = 6 * CPILL_ROW_H + 5 * CPILL_GAP + 2 * CPILL_PAD

// ── Geometry helpers ─────────────────────────────────────────────

function rotatePoint(p: Point, c: Point, angle: number): Point {
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const dx = p.x - c.x, dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

// ── Catmull-Rom ──────────────────────────────────────────────────

function catmullRom(t: number, p0: number, p1: number, p2: number, p3: number): number {
  return 0.5 * (2*p1 + (-p0+p2)*t + (2*p0-5*p1+4*p2-p3)*t*t + (-p0+3*p1-3*p2+p3)*t*t*t)
}

function sampleSpline(t: number, pts: Point[]): Point {
  const n = pts.length
  const s = (((t % 1) + 1) % 1) * n
  const i = Math.floor(s), u = s - i
  const p0=pts[(i-1+n)%n]!, p1=pts[i]!, p2=pts[(i+1)%n]!, p3=pts[(i+2)%n]!
  return { x: catmullRom(u,p0.x,p1.x,p2.x,p3.x), y: catmullRom(u,p0.y,p1.y,p2.y,p3.y) }
}

type BBox = { x: number; y: number; width: number; height: number }

// ── TraceLayer ────────────────────────────────────────────────────

export class TraceLayer extends Layer implements PointSource, MaskSource, ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point, ValueType.Mask, ValueType.Image])

  // Detection inputs
  readonly imageSlot:  ParameterSlot
  readonly maskSlot:   ParameterSlot
  readonly priorSlot: ParameterSlot

  // Shape rendering inputs
  readonly phaseSlot: ParameterSlot

  private readonly _raysSlider:     SliderRegion
  private readonly _smoothSlider:   SliderRegion
  private readonly _sizeSlider:     SliderRegion
  private readonly _biasSlider:     SliderRegion
  private readonly _circSlider:     SliderRegion
  private readonly _gradModeSlider: SliderRegion

  // Detection state
  private _phase:           number  = 0
  private _controlPoints:   Point[] = []
  private _lastImageId:     object | null = null
  private _lastNumRays:     number  = DEF_RAYS
  private _lastWinSize:     number  = DEF_SMOOTH
  private _lastWorkSize:    number  = DEF_SIZE
  private _lastRadialBias:    number       = 0.5
  private _lastCircBias:      number       = 0.5
  private _lastGradMode:      number       = 0.5
  private _lastPriorId:       object|null  = null
  private _lastPriorActive:   boolean      = false
  private _lastMaskActive:    boolean      = false
  private _forceDetect:     boolean = false

  // Offscreen canvases for Mask and Image outputs
  private _maskCanvas:  OffscreenCanvas = new OffscreenCanvas(1, 1)
  private _imageCanvas: OffscreenCanvas = new OffscreenCanvas(1, 1)

  // UI state
  private _slotsBottom      = 0
  private _captureBtnBounds: BBox | null = null
  private _onAddPath: (() => void) | null = null
  private _onAddClip: (() => void) | null = null

  // Handle drag state
  private _angle:           number = 0
  private _dragIndex:       number = -1
  private _specialDrag:     'center' | 'size' | 'rotate' | null = null
  private _dragStartPtr:    Point = { x: 0, y: 0 }
  private _dragStartPts:    Point[] = []
  private _dragStartCenter: Point = { x: 0, y: 0 }
  private _dragStartAngle:  number = 0

  constructor() {
    super()
    this.imageSlot  = new ParameterSlot(ValueType.Image,  this, 'image')
    this.maskSlot   = new ParameterSlot(ValueType.Mask,   this, 'mask')
    this.priorSlot  = new ParameterSlot(ValueType.Mask,   this, 'prior')
    this.phaseSlot  = new ParameterSlot(ValueType.Amount, this, 'phase')
    const initRays   = (DEF_RAYS   - MIN_RAYS)   / (MAX_RAYS   - MIN_RAYS)
    const initSmooth = (DEF_SMOOTH - MIN_SMOOTH) / (MAX_SMOOTH - MIN_SMOOTH)
    const initSize   = (DEF_SIZE   - MIN_SIZE)   / (MAX_SIZE   - MIN_SIZE)
    this._raysSlider     = new SliderRegion(this, initRays)
    this._smoothSlider   = new SliderRegion(this, initSmooth)
    this._sizeSlider     = new SliderRegion(this, initSize)
    this._biasSlider     = new SliderRegion(this, 0.5)
    this._circSlider     = new SliderRegion(this, 0.5)
    this._gradModeSlider = new SliderRegion(this, 0.5)
    this.slots.push(this.imageSlot, this.maskSlot, this.priorSlot)
    this.debugName = 'Trace'
    graph.register(this)
  }

  override autoBindRules(): ReturnType<Layer['autoBindRules']> {
    return [
      { slot: this.imageSlot, accepts: (l: Layer) => l.types.has(ValueType.Image) },
      { slot: this.maskSlot,  accepts: (l: Layer) => l.types.has(ValueType.Mask)  },
    ]
  }

  // ── Source interface ─────────────────────────────────────────────

  getPoint(): Point {
    return this._controlPoints.length < 2 ? { x: 0, y: 0 }
      : sampleSpline(this._phase, this._controlPoints)
  }

  samplePerimeter(t: number): Point {
    return this._controlPoints.length < 2 ? { x: 0, y: 0 }
      : sampleSpline(t, this._controlPoints)
  }

  getMask():  MaskValue  { return this._maskCanvas  }
  getImage(): ImageValue { return this._imageCanvas }

  setValue(_v: Amount): void { this.markDirty() }

  getControlPoints(): Point[] { return this._controlPoints.map(p => ({ ...p })) }

  setOnAddPath(fn: () => void): void { this._onAddPath = fn }
  setOnAddClip(fn: () => void): void { this._onAddClip = fn }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      phase:         this._phase,
      controlPoints: this._controlPoints,
      raysValue:     this._raysSlider.value,
      smoothValue:   this._smoothSlider.value,
      sizeValue:     this._sizeSlider.value,
      biasValue:     this._biasSlider.value,
      circValue:     this._circSlider.value,
      gradModeValue: this._gradModeSlider.value,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.phase === 'number')        this._phase = state.phase
    if (Array.isArray(state.controlPoints))     this._controlPoints = state.controlPoints as Point[]
    if (typeof state.raysValue === 'number') {
      this._raysSlider.setValue(state.raysValue as Amount)
      this._lastNumRays = this._numRays()
    }
    if (typeof state.smoothValue === 'number') {
      this._smoothSlider.setValue(state.smoothValue as Amount)
      this._lastWinSize = this._winSize()
    }
    if (typeof state.sizeValue === 'number') {
      this._sizeSlider.setValue(state.sizeValue as Amount)
      this._lastWorkSize = this._workSize()
    }
    if (typeof state.biasValue === 'number') {
      this._biasSlider.setValue(state.biasValue as Amount)
      this._lastRadialBias = this._biasSlider.value
    }
    if (typeof state.circValue === 'number') {
      this._circSlider.setValue(state.circValue as Amount)
      this._lastCircBias = this._circSlider.value
    }
    if (typeof state.gradModeValue === 'number') {
      this._gradModeSlider.setValue(state.gradModeValue as Amount)
      this._lastGradMode = this._gradModeSlider.value
    }
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    const numRays      = this._numRays()
    const winSize      = this._winSize()
    const workSize     = this._workSize()
    const radialBias   = this._biasSlider.value
    const circBias     = this._circSlider.value
    const gradMode     = this._gradModeSlider.value
    const maskActive  = this.maskSlot.isActive
    const priorActive = this.priorSlot.isActive
    const imageVal    = this.imageSlot.isActive
      ? (this.imageSlot.source as ImageSource).getImage() : null
    const maskVal     = maskActive
      ? (this.maskSlot.source as MaskSource).getMask() : null
    // getMask() used only for change-detection identity; actual prior input is built below
    const priorMask   = priorActive
      ? (this.priorSlot.source as MaskSource).getMask() : null
    const imageId     = imageVal as object | null
    const priorId     = priorMask as object | null

    if ((this._forceDetect || imageId !== this._lastImageId ||
         numRays !== this._lastNumRays || winSize !== this._lastWinSize ||
         workSize !== this._lastWorkSize || radialBias !== this._lastRadialBias ||
         circBias !== this._lastCircBias || gradMode !== this._lastGradMode ||
         priorId !== this._lastPriorId || priorActive !== this._lastPriorActive ||
         maskActive !== this._lastMaskActive)
        && imageVal !== null) {
      this._lastImageId     = imageId
      this._lastNumRays     = numRays
      this._lastWinSize     = winSize
      this._lastWorkSize    = workSize
      this._lastRadialBias  = radialBias
      this._lastCircBias    = circBias
      this._lastGradMode    = gradMode
      this._lastPriorId     = priorId
      this._lastPriorActive = priorActive
      this._lastMaskActive  = maskActive
      this._forceDetect     = false
      // For shape/stroke/path sources with samplePerimeter, rasterise the filled
      // interior so each ray can find its crossing at the shape boundary.
      const priorSrc: MaskValue = (priorActive && this.priorSlot.source !== null &&
        typeof (this.priorSlot.source as unknown as Record<string, unknown>)['samplePerimeter'] === 'function')
        ? this._buildPriorCanvas(this.priorSlot.source as unknown as { samplePerimeter(t: number): Point  })
        : priorMask
      this._detectPath(imageVal, maskVal, priorSrc, numRays, winSize, workSize, radialBias, circBias, gradMode)
    } else if (imageVal === null && this._controlPoints.length > 0) {
      this._lastImageId = null; this._controlPoints = []
    }

    this._updateOffscreens()
  }

  // ── Detection pipeline ───────────────────────────────────────────

  private _buildPriorCanvas(src: { samplePerimeter(t: number): Point }): OffscreenCanvas {
    const W = Node.canvasWidth, H = Node.canvasHeight
    const canvas = new OffscreenCanvas(W, H)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    const N = 200
    for (let i = 0; i <= N; i++) {
      const p = src.samplePerimeter(i / N)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else         ctx.lineTo(p.x, p.y)
    }
    ctx.closePath()
    ctx.fill()
    return canvas
  }

  private _numRays(): number {
    return Math.round(MIN_RAYS + this._raysSlider.value * (MAX_RAYS - MIN_RAYS))
  }

  private _winSize(): number {
    return Math.round(MIN_SMOOTH + this._smoothSlider.value * (MAX_SMOOTH - MIN_SMOOTH))
  }

  private _workSize(): number {
    return Math.round(MIN_SIZE + this._sizeSlider.value * (MAX_SIZE - MIN_SIZE))
  }

  private _detectPath(
    imageSrc:   ImageBitmap | OffscreenCanvas,
    maskSrc:    MaskValue,
    priorSrc:   MaskValue,
    numRays:    number,
    winSize:    number,
    workSize:   number,
    radialBias: number,
    circBias:   number,
    gradMode:   number,
  ): void {
    const pts = detectByGradient(
      imageSrc, maskSrc as OffscreenCanvas | null,
      numRays, winSize, workSize, radialBias, circBias, gradMode,
      priorSrc as OffscreenCanvas | null,
    )
    this._controlPoints = pts ?? []
  }

  // ── Offscreen canvases ───────────────────────────────────────────

  private _updateOffscreens(): void {
    const w = Node.canvasWidth, h = Node.canvasHeight

    if (this._maskCanvas.width !== w || this._maskCanvas.height !== h)
      this._maskCanvas = new OffscreenCanvas(w, h)
    const mctx = this._maskCanvas.getContext('2d')!
    mctx.clearRect(0, 0, w, h)
    if (this._controlPoints.length >= 3)
      this._drawSpline(mctx, { r: 1, g: 1, b: 1, a: 1 }, 1)

    if (this._imageCanvas.width !== w || this._imageCanvas.height !== h)
      this._imageCanvas = new OffscreenCanvas(w, h)
    const ictx = this._imageCanvas.getContext('2d')!
    ictx.clearRect(0, 0, w, h)
    if (this._controlPoints.length >= 3)
      this._drawSpline(ictx, { r: 1, g: 1, b: 1, a: 1 }, 0.2)
  }

  private _drawSpline(ctx: Ctx2D, colour: Colour, opacity: number): void {
    if (this._controlPoints.length < 3) return
    const css = `rgba(${Math.round(colour.r*255)},${Math.round(colour.g*255)},${Math.round(colour.b*255)},${colour.a})`
    ctx.save()
    ctx.globalAlpha = opacity
    ctx.beginPath()
    for (let i = 0; i <= RENDER_PTS; i++) {
      const p = sampleSpline(i / RENDER_PTS, this._controlPoints)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else         ctx.lineTo(p.x, p.y)
    }
    ctx.closePath()
    ctx.fillStyle = css
    ctx.fill()
    ctx.restore()
  }

  // ── Rendering ────────────────────────────────────────────────────

  renderSelf(ctx: Ctx2D): void {
    this._drawSpline(ctx, { r: 1, g: 1, b: 1, a: 1 }, 0.2)
  }

  renderPanel(ctx: Ctx2D): void {
    this._drawPill(ctx, this.bounds)
    this._drawPill(ctx, this.canvasBounds)
  }

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    this.renderSlotGroup(ctx, this.slots, this.panelBottom)
    let bottom = this.panelBottom
    for (const b of this._slotBounds.values()) bottom = Math.max(bottom, b.y + b.height)
    const pillY = bottom + 8
    this._drawControlPill(ctx, pillY)
    this._slotsBottom = pillY + CPILL_H
  }

  override renderOverlay(ctx: Ctx2D): void {
    this._drawControlHandles(ctx)
    this._renderCaptureBtn(ctx)
    this._renderPathBtn(ctx)
    this._renderClipBtn(ctx)
  }

  private _renderCaptureBtn(ctx: Ctx2D): void {
    const x = this.canvasBounds.x
    const y = this._slotsBottom + 8
    this._captureBtnBounds = { x, y, width: CAPTURE_W, height: CAPTURE_H }

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath(); ctx.roundRect(x, y, CAPTURE_W, CAPTURE_H, 5); ctx.fill()
    ctx.fillStyle = ACCENT + 'cc'
    ctx.beginPath(); ctx.roundRect(x, y, 3, CAPTURE_H, [5, 0, 0, 5]); ctx.fill()
    ctx.save()
    ctx.beginPath(); ctx.rect(x, y, CAPTURE_W, CAPTURE_H); ctx.clip()
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.font         = '10px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Capture', x + 8, y + CAPTURE_H / 2)
    ctx.restore()
    ctx.restore()
  }

  private _convBtnStartX(): number {
    const left   = contentLeft(Node.canvasWidth)
    const totalW = PATH_BTN_W + CONV_BTN_GAP_X + CLIP_BTN_W
    return left + Math.max(0, (Node.viewportWidth - left - totalW) / 2)
  }

  private _pathBtnRect(): { x: number; y: number; w: number } {
    return { x: this._convBtnStartX(), y: Node.viewportHeight - CONV_BTN_H - CONV_BTN_GAP, w: PATH_BTN_W }
  }

  private _clipBtnRect(): { x: number; y: number; w: number } {
    return { x: this._convBtnStartX() + PATH_BTN_W + CONV_BTN_GAP_X, y: Node.viewportHeight - CONV_BTN_H - CONV_BTN_GAP, w: CLIP_BTN_W }
  }

  private _pathBtnVisible(): boolean {
    return this._onAddPath !== null && this._controlPoints.length >= 3
  }

  private _clipBtnVisible(): boolean {
    return this._onAddClip !== null && this._controlPoints.length >= 3
  }

  private _renderConvBtn(ctx: Ctx2D, x: number, y: number, w: number, label: string, accent: string): void {
    const midY = y + CONV_BTN_H / 2
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath(); ctx.roundRect(x, y, w, CONV_BTN_H, 5); ctx.fill()
    ctx.fillStyle = accent + 'cc'
    ctx.beginPath(); ctx.roundRect(x, y, 3, CONV_BTN_H, [5, 0, 0, 5]); ctx.fill()
    ctx.save()
    ctx.beginPath(); ctx.rect(x, y, w, CONV_BTN_H); ctx.clip()
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, x + 10, midY)
    ctx.restore()
    ctx.restore()
  }

  private _renderPathBtn(ctx: Ctx2D): void {
    if (!this._pathBtnVisible()) return
    const { x, y, w } = this._pathBtnRect()
    this._renderConvBtn(ctx, x, y, w, 'Path', ACCENT)
  }

  private _renderClipBtn(ctx: Ctx2D): void {
    if (!this._clipBtnVisible()) return
    const { x, y, w } = this._clipBtnRect()
    this._renderConvBtn(ctx, x, y, w, 'Clip', '#7ecf7e')
  }

  // ── Pill rendering ───────────────────────────────────────────────

  private _drawPill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return
    const midY    = y + height / 2
    const btnB    = this._detectBtnBounds(b)

    ctx.save()

    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // Status text
    const hasPts = this._controlPoints.length > 0
    ctx.font         = '10px monospace'
    ctx.fillStyle    = hasPts ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.35)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      hasPts ? `${this._controlPoints.length} pts` : this.imageSlot.isActive ? '…' : '—',
      x + 16, midY,
    )

    // DETECT button
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(btnB.x, btnB.y, btnB.width, btnB.height, 4)
    ctx.fill()
    ctx.font      = 'bold 10px monospace'
    ctx.fillStyle = ACCENT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('DETECT', btnB.x + btnB.width / 2, btnB.y + btnB.height / 2)

    ctx.restore()
  }

  private _drawControlPill(ctx: Ctx2D, y: number): void {
    const cb = this.canvasBounds
    const { x, width } = cb

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, CPILL_H, 6)
    ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, CPILL_H, [4, 0, 0, 4])
    ctx.fill()
    ctx.restore()

    const trkX0 = x + CPILL_LBL_W + 12
    const trkX1 = x + width - CPILL_VAL_W - 8
    const trkW  = Math.max(0, trkX1 - trkX0)

    const rows = [
      { label: 'rays', slider: this._raysSlider,     text: `${this._numRays()}`  },
      { label: 'smth', slider: this._smoothSlider,   text: `${this._winSize()}`  },
      { label: 'size', slider: this._sizeSlider,     text: `${this._workSize()}` },
      { label: 'bias', slider: this._biasSlider,     text: `${Math.round(this._biasSlider.value * 100)}` },
      { label: 'circ', slider: this._circSlider,     text: `${Math.round(this._circSlider.value * 100)}` },
      { label: 'grad', slider: this._gradModeSlider, text: `${Math.round(this._gradModeSlider.value * 100)}` },
    ]

    for (let i = 0; i < rows.length; i++) {
      const { label, slider, text } = rows[i]!
      const rowY = y + CPILL_PAD + i * (CPILL_ROW_H + CPILL_GAP)
      const midY = rowY + CPILL_ROW_H / 2

      slider.bounds       = { x: trkX0, y: rowY + 4, width: trkW, height: CPILL_ROW_H - 8 }
      slider.interactive  = true
      slider.displayValue = slider.value

      ctx.save()
      ctx.font         = '10px monospace'
      ctx.fillStyle    = 'rgba(255,255,255,0.62)'
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, x + 12, midY)
      slider.renderSelf(ctx)
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.textAlign = 'right'
      ctx.fillText(text, x + width - 8, midY)
      ctx.restore()
    }
  }

  // ── Interaction ──────────────────────────────────────────────────

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): Node | null {
    // Handles take priority over controls so they remain reachable everywhere on canvas.
    if (this._controlPoints.length >= 2) {
      const r2 = HIT_R * HIT_R
      const c  = this._centroid()
      if ((point.x-c.x)**2 + (point.y-c.y)**2 <= r2) return this
      const sh = this._sizeHandlePos()
      if ((point.x-sh.x)**2 + (point.y-sh.y)**2 <= r2) return this
      const rh = this._rotateHandlePos()
      if ((point.x-rh.x)**2 + (point.y-rh.y)**2 <= r2) return this
      if (this._nearest(point) >= 0) return this
      if (this._curveHit(point) !== null) return this
    }

    // UI controls (sliders, buttons)
    if (this._pathBtnVisible()) {
      const { x, y, w } = this._pathBtnRect()
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + CONV_BTN_H) return this
    }
    if (this._clipBtnVisible()) {
      const { x, y, w } = this._clipBtnRect()
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + CONV_BTN_H) return this
    }
    const raysHit = this._raysSlider.hitTest(point)
    if (raysHit !== null) return raysHit
    const smoothHit = this._smoothSlider.hitTest(point)
    if (smoothHit !== null) return smoothHit
    const sizeHit = this._sizeSlider.hitTest(point)
    if (sizeHit !== null) return sizeHit
    const biasHit = this._biasSlider.hitTest(point)
    if (biasHit !== null) return biasHit
    const circHit = this._circSlider.hitTest(point)
    if (circHit !== null) return circHit
    const gradModeHit = this._gradModeSlider.hitTest(point)
    if (gradModeHit !== null) return gradModeHit
    if (boundingBoxContains(this._detectBtnBounds(this.canvasBounds), point)) return this
    if (this._captureBtnBounds !== null && boundingBoxContains(this._captureBtnBounds, point)) return this

    return null
  }

  handlePointerDown(point: Point): boolean {
    // Path convenience button
    if (this._pathBtnVisible()) {
      const { x, y, w } = this._pathBtnRect()
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + CONV_BTN_H) {
        this._onAddPath?.()
        this.markDirty()
        return true
      }
    }
    // Clip convenience button
    if (this._clipBtnVisible()) {
      const { x, y, w } = this._clipBtnRect()
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + CONV_BTN_H) {
        this._onAddClip?.()
        this.markDirty()
        return true
      }
    }

    // DETECT button (in pill header)
    if (boundingBoxContains(this._detectBtnBounds(this.canvasBounds), point)) {
      this._forceDetect = true; this.markDirty(); return true
    }

    // Capture button (below slot rows)
    if (this._captureBtnBounds !== null && boundingBoxContains(this._captureBtnBounds, point)) {
      this._forceDetect = true; this.markDirty(); return true
    }

    if (this._controlPoints.length < 2) return false

    const r2 = HIT_R * HIT_R
    const c  = this._centroid()

    // Centre handle
    if ((point.x-c.x)**2 + (point.y-c.y)**2 <= r2) {
      this._specialDrag     = 'center'
      this._dragStartPtr    = { ...point }
      this._dragStartPts    = this._controlPoints.map(p => ({ ...p }))
      this.markDirty(); return true
    }
    // Size handle
    const sh = this._sizeHandlePos()
    if ((point.x-sh.x)**2 + (point.y-sh.y)**2 <= r2) {
      this._specialDrag     = 'size'
      this._dragStartPtr    = { ...point }
      this._dragStartPts    = this._controlPoints.map(p => ({ ...p }))
      this._dragStartCenter = c
      this.markDirty(); return true
    }
    // Rotate handle
    const rh = this._rotateHandlePos()
    if ((point.x-rh.x)**2 + (point.y-rh.y)**2 <= r2) {
      this._specialDrag     = 'rotate'
      this._dragStartPtr    = { ...point }
      this._dragStartPts    = this._controlPoints.map(p => ({ ...p }))
      this._dragStartCenter = c
      this._dragStartAngle  = this._angle
      this.markDirty(); return true
    }
    // Control point
    const idx = this._nearest(point)
    if (idx >= 0) {
      this._dragIndex = idx; this.markDirty(); return true
    }
    // Click on curve: insert new point
    const hit = this._curveHit(point)
    if (hit !== null) {
      this._controlPoints.splice(hit.insertAt, 0, { ...hit.pos })
      this._dragIndex = hit.insertAt
      this.markDirty(); return true
    }
    return false
  }

  handleContextMenu(point: Point): boolean {
    if (this._controlPoints.length <= MIN_RAYS) return false
    const idx = this._nearest(point)
    if (idx < 0) return false
    this._controlPoints.splice(idx, 1)
    if (this._dragIndex === idx) this._dragIndex = -1
    this.markDirty()
    return true
  }

  override handlePointerMove(point: Point): void {
    if (this._specialDrag === 'center') {
      const dx = point.x - this._dragStartPtr.x
      const dy = point.y - this._dragStartPtr.y
      this._controlPoints = this._dragStartPts.map(p => ({ x: p.x+dx, y: p.y+dy }))
      this.markDirty(); return
    }
    if (this._specialDrag === 'size') {
      const c0  = this._dragStartCenter
      const d0  = Math.hypot(this._dragStartPtr.x-c0.x, this._dragStartPtr.y-c0.y)
      const d1  = Math.hypot(point.x-c0.x, point.y-c0.y)
      const scl = d0 > 0 ? d1/d0 : 1
      this._controlPoints = this._dragStartPts.map(p => ({
        x: c0.x + (p.x-c0.x)*scl, y: c0.y + (p.y-c0.y)*scl,
      }))
      this.markDirty(); return
    }
    if (this._specialDrag === 'rotate') {
      const c0    = this._dragStartCenter
      const a0    = Math.atan2(this._dragStartPtr.y-c0.y, this._dragStartPtr.x-c0.x)
      const a1    = Math.atan2(point.y-c0.y, point.x-c0.x)
      const delta = a1 - a0
      this._controlPoints = this._dragStartPts.map(p => rotatePoint(p, c0, delta))
      this._angle = this._dragStartAngle + delta
      this.markDirty(); return
    }
    if (this._dragIndex >= 0) {
      this._controlPoints[this._dragIndex] = { ...point }
      this.markDirty()
    }
  }

  override handlePointerUp(): void {
    this._specialDrag = null
    this._dragIndex   = -1
    this.markDirty()
  }

  // ── Private helpers ──────────────────────────────────────────────

  private _detectBtnBounds(b: BBox) {
    return { x: b.x + b.width - BTN_M - BTN_W, y: b.y + (b.height - BTN_H) / 2, width: BTN_W, height: BTN_H }
  }

  private _centroid(): Point {
    if (this._controlPoints.length === 0) return { x: 0, y: 0 }
    const x = this._controlPoints.reduce((s, p) => s + p.x, 0) / this._controlPoints.length
    const y = this._controlPoints.reduce((s, p) => s + p.y, 0) / this._controlPoints.length
    return { x, y }
  }

  private _sizeHandlePos(): Point {
    const c    = this._centroid()
    const maxR = this._controlPoints.reduce((r, p) => Math.max(r, Math.hypot(p.x-c.x, p.y-c.y)), 0)
    return { x: c.x + maxR + 24, y: c.y }
  }

  private _rotateHandlePos(): Point {
    const c    = this._centroid()
    const maxR = this._controlPoints.reduce((r, p) => Math.max(r, Math.hypot(p.x-c.x, p.y-c.y)), 0)
    const a    = this._angle - Math.PI / 2
    return { x: c.x + (maxR + ROT_OFF) * Math.cos(a), y: c.y + (maxR + ROT_OFF) * Math.sin(a) }
  }

  private _nearest(p: Point): number {
    const r2 = HIT_R * HIT_R
    let best = -1, bestD = Infinity
    for (let i = 0; i < this._controlPoints.length; i++) {
      const cp = this._controlPoints[i]!
      const d2 = (p.x-cp.x)**2 + (p.y-cp.y)**2
      if (d2 <= r2 && d2 < bestD) { bestD = d2; best = i }
    }
    return best
  }

  private _curveHit(p: Point): { insertAt: number; pos: Point } | null {
    const n = this._controlPoints.length
    if (n < 2) return null
    const r2 = HIT_R * HIT_R
    let bestT = 0, bestD2 = Infinity, bestPos: Point = { x: 0, y: 0 }
    for (let i = 0; i <= RENDER_PTS; i++) {
      const t  = (i / RENDER_PTS) % 1
      const pt = sampleSpline(t, this._controlPoints)
      const d2 = (p.x-pt.x)**2 + (p.y-pt.y)**2
      if (d2 < bestD2) { bestD2 = d2; bestT = t; bestPos = pt }
    }
    if (bestD2 > r2) return null
    const segIndex = Math.min(n-1, Math.floor(bestT * n))
    return { insertAt: segIndex + 1, pos: bestPos }
  }

  private _drawControlHandles(ctx: Ctx2D): void {
    if (this._controlPoints.length < 2) return
    const c  = this._centroid()
    const sh = this._sizeHandlePos()
    const rh = this._rotateHandlePos()

    ctx.save()

    // Spline outline overlay
    ctx.beginPath()
    for (let i = 0; i <= RENDER_PTS; i++) {
      const p = sampleSpline(i / RENDER_PTS, this._controlPoints)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else         ctx.lineTo(p.x, p.y)
    }
    ctx.closePath()
    ctx.strokeStyle = 'rgba(232,160,74,0.70)'
    ctx.lineWidth   = 1.5
    ctx.setLineDash([])
    ctx.stroke()

    // Dashed guide lines
    ctx.strokeStyle = 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(sh.x, sh.y); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(rh.x, rh.y); ctx.stroke()
    ctx.setLineDash([])

    // Control point handles
    for (let i = 0; i < this._controlPoints.length; i++) {
      const pt  = this._controlPoints[i]!
      const lit = i === this._dragIndex
      ctx.fillStyle   = lit ? ACCENT : 'rgba(232,160,74,0.30)'
      ctx.strokeStyle = lit ? '#ffffff' : ACCENT
      ctx.lineWidth   = 1.5
      ctx.beginPath(); ctx.arc(pt.x, pt.y, CP_R, 0, Math.PI*2)
      ctx.fill(); ctx.stroke()
    }

    // Centre handle
    const litC = this._specialDrag === 'center'
    ctx.fillStyle   = litC ? '#ffffff' : ACCENT
    ctx.strokeStyle = litC ? ACCENT : 'rgba(0,0,0,0.50)'
    ctx.lineWidth   = 1
    ctx.beginPath(); ctx.arc(c.x, c.y, CP_R+2, 0, Math.PI*2)
    ctx.fill(); ctx.stroke()

    // Size handle (square)
    const litS = this._specialDrag === 'size'
    const hs   = CP_R
    ctx.fillStyle   = litS ? ACCENT : 'rgba(255,255,255,0.85)'
    ctx.strokeStyle = 'rgba(0,0,0,0.50)'
    ctx.lineWidth   = 1
    ctx.fillRect(sh.x-hs, sh.y-hs, hs*2, hs*2)
    ctx.strokeRect(sh.x-hs, sh.y-hs, hs*2, hs*2)

    // Rotate handle (circle)
    const litR = this._specialDrag === 'rotate'
    ctx.fillStyle   = litR ? '#ffffff' : 'rgba(232,160,74,0.85)'
    ctx.strokeStyle = 'rgba(0,0,0,0.50)'
    ctx.lineWidth   = 1
    ctx.beginPath(); ctx.arc(rh.x, rh.y, CP_R, 0, Math.PI*2)
    ctx.fill(); ctx.stroke()

    ctx.restore()
  }

  private _drawPhaseIndicator(ctx: Ctx2D): void {
    const cp = this.getPoint()
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'
    ctx.lineWidth   = 1.5
    ctx.beginPath(); ctx.arc(cp.x, cp.y, 8, 0, Math.PI * 2); ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath(); ctx.arc(cp.x, cp.y, 3, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }
}
