import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  type Colour, type ColourSource,
  type Amount, type AmountSource,
  type Direction, type DirectionSource,
  type Point,  type PointSource,
  type ImageValue, type ImageSource,
  type MaskValue,  type MaskSource,
  type Ctx2D,
} from '../core/types.js'
import { graph }         from '../dataflow/Graph.js'
import { BindingLayer }  from './BindingLayer.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'
import { AngleSnapper } from '../interaction/AngleSnapper.js'
import { collectSnapEdges, snapPointToEdges, drawSnapGuides, EDGE_SNAP_THRESHOLD } from '../interaction/EdgeSnapper.js'
import { drawIcon, type IconName } from '../ui/icons.js'
import {
  hashString,
  drawPencilLine, drawNibPen, NIB_PEN_DEFAULTS,
  drawCalligraphyBrush, BRUSH_DEFAULTS,
  drawNibBrushBlend,
  drawLichtensteinStroke,
} from './artisticBrush.js'

// ------------------------------------------------------------
// LineLayer — a straight line with configurable endpoints,
// stroke width, colour, and optional arrowheads.
// ------------------------------------------------------------
//
// Controls:
//   Start/end drag handles — drag to reposition each endpoint.
//     Dragging a handle while its slot is Bound suspends the
//     binding (suspend-on-touch).
//   Width slider — manual [0,1] maps to [0.5, 80] px. Dragging
//     the slider while widthSlot is Bound suspends it first.
//   Arrow toggles (◀ / ▶) — toggle arrowheads at the start or
//     end of the line. Arrowhead shape adapts to stroke width:
//     narrow strokes → long, acute head; wide strokes → right-angle
//     head with sides extending at least 5px beyond the stroke edge.
//
// All line content (body + arrowheads) is rendered to an OffscreenCanvas
// then composited to the main canvas with a single drawImage call. This
// ensures the drop-shadow applied by the Evaluator in edit mode is computed
// from the composite shape rather than from each element separately.
//
// Slots: start (Point), end (Point), direction (Direction), width (Amount), colour (Colour).

const ACCENT      = '#e87e7e'    // Line layer accent colour
const AM_COL      = '#4a8fe8'    // Amount type accent (width slot)
const HANDLE_R    = 7            // handle circle radius (px)
const HANDLE_HIT  = 14           // pointer hit radius for handles (px)
const MAX_STROKE_W = 80          // Amount [0,1] → width [0.5, 80] px
const INIT_MARGIN = 0.15         // fraction of canvas kept clear on random init
const SNAP_COL    = '#7ecfcf'    // snap highlight colour (Direction accent)
const LINE_SNAP_ANGLES: readonly number[] = Array.from({ length: 8 }, (_, i) => i * Math.PI / 4)
const LINE_SNAP_THRESHOLD = Math.PI / 12  // 15°
const LINE_SNAP_DWELL_MS  = 700
// Minimum extension of arrowhead wing beyond the stroke edge (px each side).
const ARROW_MIN_EXTEND = 5

const SLOT_H      = 30
const SLOT_GAP    = 4
const SW_LABEL_W  = 78
const SW_VALUE_W  = 38

type BBox = { x: number; y: number; width: number; height: number }
type HandleDrag = 'start' | 'end'

const BRUSH_TRANSITIONS = [5, 13, 25] as const
const BRUSH_BLEND_HW    = 2
const BRUSH_OFFSETS     = [0, 0, 3, 5, 11]

function ptDist(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y) }

function bezier2(
  p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }, n: number,
): { x: number; y: number }[] {
  const out = []
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t
    out.push({ x: u*u*p0.x + 2*u*t*p1.x + t*t*p2.x, y: u*u*p0.y + 2*u*t*p1.y + t*t*p2.y })
  }
  return out
}

export class LineLayer extends Layer implements ImageSource, MaskSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image, ValueType.Mask])

  readonly startSlot:     ParameterSlot
  readonly endSlot:       ParameterSlot
  readonly directionSlot: ParameterSlot
  readonly widthSlot:     ParameterSlot
  readonly colourSlot:    ParameterSlot
  readonly opacitySlot:   ParameterSlot

  private _start: Point
  private _end:   Point
  // Rendered endpoints — derived from _start/_end plus directionSlot in recompute().
  private _renderedStart: Point
  private _renderedEnd:   Point
  private _strokeWidth = 3
  private _colour: Colour = { r: 0.5, g: 0.5, b: 0.5, a: 1 }  // mid grey default
  private _arrowStart = false
  private _arrowEnd   = false

  // Opacity — computed each recompute from slot; 1.0 when unbound
  private _opacity = 1.0

  // Offscreen canvas — all line elements composited here, then drawn once
  // to the main canvas so the edit-mode drop-shadow covers the whole shape.
  private _canvas:     OffscreenCanvas = new OffscreenCanvas(1, 1)
  private _maskCanvas: OffscreenCanvas = new OffscreenCanvas(1, 1)
  private _canvasArtisticMode = true

  // Mask convenience button
  private _addMaskDone = false
  private _onAddMask: (() => void) | null = null
  setOnAddMask(fn: () => void): void { this._onAddMask = fn }

  // Active drag
  private _drag:             HandleDrag | null  = null
  private _dragStartMouse:   Point | null       = null
  // In translate-both mode (_dragStartOtherPt !== null):
  //   _dragStartPt      = _start at drag begin  (always)
  //   _dragStartOtherPt = _end   at drag begin  (always)
  // Both are translated by the same pointer delta regardless of which handle
  // the user clicked (_drag tracks that for switch detection only).
  private _dragStartPt:      Point | null       = null
  private _dragStartOtherPt: Point | null       = null
  // Tracks which handle was last used while direction is active with neither
  // point bound, so that switching to the other handle disables direction.
  private _lastDraggedHandle: HandleDrag | null = null
  private _sliderDrag = false

  // Angle snap
  private readonly _lineSnapper = new AngleSnapper(LINE_SNAP_ANGLES, LINE_SNAP_THRESHOLD, LINE_SNAP_DWELL_MS)
  private _snapSnapped  = false
  private _snapProgress = 0
  private _snapDwellTimer: ReturnType<typeof setInterval> | null = null

  // Edge snap guide lines
  private _edgeSnapX: number | null = null
  private _edgeSnapY: number | null = null

  // Pivot-rotation drag initiated via pixel-pick (startCenterDrag).
  // Active when one endpoint is slot-bound (the pivot) and the other is free.
  private _pivotDrag: {
    pivot: Point       // fixed endpoint in canvas space
    grabAngle: number  // angle from pivot to the original click point
    freeAngle: number  // angle from pivot to the free endpoint at drag start
    freeDist:  number  // distance from pivot to the free endpoint
    freeIsEnd: boolean // true: _end is free; false: _start is free
  } | null = null

  // Button bounds written in renderPanel, read in hitTestSelf
  private _arrowStartBounds: BBox | null = null
  private _arrowEndBounds:   BBox | null = null

  constructor(colour?: Colour) {
    super()
    if (colour !== undefined) this._colour = colour
    const W = Node.canvasWidth
    const H = Node.canvasHeight
    const m = INIT_MARGIN
    this._start = {
      x: (m + Math.random() * (1 - 2 * m)) * W,
      y: (m + Math.random() * (1 - 2 * m)) * H,
    }
    this._end = {
      x: (m + Math.random() * (1 - 2 * m)) * W,
      y: (m + Math.random() * (1 - 2 * m)) * H,
    }
    this._renderedStart = { ...this._start }
    this._renderedEnd   = { ...this._end }

    this.startSlot     = new ParameterSlot(ValueType.Point,     this, 'start')
    this.endSlot       = new ParameterSlot(ValueType.Point,     this, 'end')
    this.directionSlot = new ParameterSlot(ValueType.Direction, this, 'direction')
    this.widthSlot     = new ParameterSlot(ValueType.Amount,    this, 'width')
    this.colourSlot    = new ParameterSlot(ValueType.Colour,    this, 'colour')
    this.opacitySlot   = new ParameterSlot(ValueType.Amount,    this, 'opacity')
    this.slots.push(this.startSlot, this.endSlot, this.directionSlot, this.widthSlot, this.colourSlot, this.opacitySlot)
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._canvas     }
  getMask():  MaskValue  { return this._maskCanvas }

  override getSnapBounds() {
    const minX = Math.min(this._start.x, this._end.x)
    const maxX = Math.max(this._start.x, this._end.x)
    const minY = Math.min(this._start.y, this._end.y)
    const maxY = Math.max(this._start.y, this._end.y)
    return { minX, maxX, minY, maxY }
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      start:       this._start,
      end:         this._end,
      strokeWidth: this._strokeWidth,
      colour:      this._colour,
      arrowStart:  this._arrowStart,
      arrowEnd:    this._arrowEnd,
      addMaskDone: this._addMaskDone,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (state.start && typeof state.start === 'object')   this._start = state.start as Point
    if (state.end   && typeof state.end   === 'object')   this._end   = state.end   as Point
    if (typeof state.strokeWidth === 'number')            this._strokeWidth = state.strokeWidth
    if (state.colour && typeof state.colour === 'object') this._colour = state.colour as Colour
    if (typeof state.arrowStart === 'boolean')            this._arrowStart = state.arrowStart
    if (typeof state.arrowEnd   === 'boolean')            this._arrowEnd   = state.arrowEnd
    if (typeof state.addMaskDone === 'boolean')           this._addMaskDone = state.addMaskDone
  }

  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | Colour | null {
    if (slot === this.colourSlot)    return this._colour
    if (slot === this.startSlot)     return { ...this._start }
    if (slot === this.endSlot)       return { ...this._end   }
    if (slot === this.widthSlot)     return Math.max(0, Math.min(1, this._strokeWidth / MAX_STROKE_W))
    if (slot === this.opacitySlot)   return this._opacity
    if (slot === this.directionSlot) {
      const dx = this._end.x - this._start.x
      const dy = this._end.y - this._start.y
      return { angle: Math.atan2(dy, dx), magnitude: 1 }
    }
    return null
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    this._opacity = this.opacitySlot.isActive
      ? (this.opacitySlot.source as AmountSource).getAmount() as Amount
      : 1.0

    if (this.startSlot.isActive)  this._start = (this.startSlot.source  as PointSource).getPoint()
    if (this.endSlot.isActive)    this._end   = (this.endSlot.source    as PointSource).getPoint()
    if (this.widthSlot.isActive)  this._strokeWidth = Math.max(0.5, (this.widthSlot.source as AmountSource).getAmount() * MAX_STROKE_W)
    if (this.colourSlot.isActive) this._colour = (this.colourSlot.source as ColourSource).getColour()
    this._computeRenderedPoints()
    this._updateCanvas()
  }

  // Computes _renderedStart/_renderedEnd from _start/_end plus optional directionSlot.
  //
  // Behaviours:
  //   directionSlot inactive        → rendered endpoints equal raw _start/_end.
  //   Both point slots active       → angle ignored; magnitude retracts both ends equally.
  //   Only endSlot active           → end anchored; direction angle + magnitude place start.
  //   Only startSlot active         → start anchored; direction angle + magnitude place end.
  //   Neither point slot active,
  //     _lastDraggedHandle === 'end' → end is master anchor; start follows direction.
  //   Neither point slot active,
  //     otherwise                   → start is master anchor; end follows direction.
  private _computeRenderedPoints(): void {
    if (!this.directionSlot.isActive) {
      this._renderedStart = this._start
      this._renderedEnd   = this._end
      return
    }

    const dir         = (this.directionSlot.source as DirectionSource).getDirection()
    const startActive = this.startSlot.isActive
    const endActive   = this.endSlot.isActive
    const dx          = this._end.x - this._start.x
    const dy          = this._end.y - this._start.y
    const definedLen  = Math.hypot(dx, dy)

    if (definedLen < 0.5) {
      this._renderedStart = this._start
      this._renderedEnd   = this._end
      return
    }

    const mag = Math.max(0, Math.min(1, dir.magnitude))

    if (startActive && endActive) {
      // Both bound: angle has no effect; magnitude scales how much of the
      // defined length is rendered, retracting each end by an equal amount.
      const udx     = dx / definedLen
      const udy     = dy / definedLen
      const retract = (1 - mag) * definedLen / 2
      this._renderedStart = { x: this._start.x + udx * retract, y: this._start.y + udy * retract }
      this._renderedEnd   = { x: this._end.x   - udx * retract, y: this._end.y   - udy * retract }
    } else if (endActive || (!startActive && this._lastDraggedHandle === 'end')) {
      // End anchored (endSlot active, or neither bound and end was last touched).
      const rendLen = mag * definedLen
      this._renderedEnd   = this._end
      this._renderedStart = {
        x: this._end.x - Math.cos(dir.angle) * rendLen,
        y: this._end.y - Math.sin(dir.angle) * rendLen,
      }
    } else {
      // Start anchored (startSlot active, or neither bound and start is default).
      const rendLen = mag * definedLen
      this._renderedStart = this._start
      this._renderedEnd   = {
        x: this._start.x + Math.cos(dir.angle) * rendLen,
        y: this._start.y + Math.sin(dir.angle) * rendLen,
      }
    }
  }

  // ----------------------------------------------------------
  // Arrowhead geometry
  // ----------------------------------------------------------

  // Half-angle: 15° (narrow, acute) → 45° (wide, right-angle at tip).
  // Half-width: at least ARROW_MIN_EXTEND beyond the stroke edge on each side.
  private _arrowGeom(): { hw: number; len: number } {
    const w   = this._strokeWidth
    const t   = Math.max(0, Math.min(1, w / BRUSH_TRANSITIONS[2]))
    const ang = (15 + t * 30) * (Math.PI / 180)
    const hw  = w / 2 + ARROW_MIN_EXTEND
    return { hw, len: hw / Math.tan(ang) }
  }

  // ----------------------------------------------------------
  // Offscreen canvas — renders the complete line shape once
  // ----------------------------------------------------------

  private _updateCanvas(): void {
    this._canvasArtisticMode = Node.artisticMode
    const cw = Node.canvasWidth, ch = Node.canvasHeight
    if (this._canvas.width !== cw || this._canvas.height !== ch) {
      this._canvas = new OffscreenCanvas(cw, ch)
    }
    const ctx = this._canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null
    if (!ctx) return
    ctx.clearRect(0, 0, cw, ch)
    this._drawLineContent(ctx)

    if (this._maskCanvas.width !== cw || this._maskCanvas.height !== ch) {
      this._maskCanvas = new OffscreenCanvas(cw, ch)
    }
    const mctx = this._maskCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null
    if (!mctx) return
    mctx.clearRect(0, 0, cw, ch)
    this._drawLineContent(mctx, { r: 1, g: 1, b: 1, a: 1 })
  }

  private _drawLineContent(ctx: OffscreenCanvasRenderingContext2D, colour?: Colour): void {
    const start = this._renderedStart, end = this._renderedEnd
    const dx = end.x - start.x, dy = end.y - start.y
    const len = Math.hypot(dx, dy)
    if (len < 0.5) return

    const udx = dx / len, udy = dy / len
    const nx  = -udy, ny = udx
    const w   = this._strokeWidth
    const r   = w / 2
    const { hw, len: aLen } = this._arrowGeom()

    const c   = colour ?? this._colour
    const css = `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${c.a})`

    ctx.fillStyle   = css
    ctx.strokeStyle = css
    ctx.lineWidth   = w

    const useArtistic = colour === undefined && Node.artisticMode

    if (!useArtistic) {
      // Outline mode or mask pass: plain geometric rendering.
      if (!this._arrowStart && !this._arrowEnd) {
        ctx.lineCap = 'round'
        ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke()
        return
      }
      const bsx = start.x + udx*aLen, bsy = start.y + udy*aLen
      const bex = end.x   - udx*aLen, bey = end.y   - udy*aLen
      const OVERLAP = 1
      const lineS = { x: this._arrowStart ? bsx - udx*OVERLAP : start.x, y: this._arrowStart ? bsy - udy*OVERLAP : start.y }
      const lineE = { x: this._arrowEnd   ? bex + udx*OVERLAP : end.x,   y: this._arrowEnd   ? bey + udy*OVERLAP : end.y   }
      ctx.lineCap = 'butt'
      ctx.beginPath(); ctx.moveTo(lineS.x, lineS.y); ctx.lineTo(lineE.x, lineE.y); ctx.stroke()
      if (!this._arrowStart) { ctx.beginPath(); ctx.arc(start.x, start.y, r, 0, Math.PI*2); ctx.fill() }
      if (!this._arrowEnd)   { ctx.beginPath(); ctx.arc(end.x,   end.y,   r, 0, Math.PI*2); ctx.fill() }
      if (this._arrowEnd)   { ctx.beginPath(); ctx.moveTo(end.x, end.y); ctx.lineTo(bex+nx*hw, bey+ny*hw); ctx.lineTo(bex-nx*hw, bey-ny*hw); ctx.closePath(); ctx.fill() }
      if (this._arrowStart) { ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(bsx+nx*hw, bsy+ny*hw); ctx.lineTo(bsx-nx*hw, bsy-ny*hw); ctx.closePath(); ctx.fill() }
      return
    }

    // Artistic rendering: brush style chosen by stroke width.
    const [pt0, pt1, pt2] = BRUSH_TRANSITIONS
    const caseIdx = w < pt0 ? 1 : w < pt1 ? 2 : w < pt2 ? 3 : 4
    const eff     = Math.max(1, w - (BRUSH_OFFSETS[caseIdx] ?? 0))
    const seed    = hashString(this.debugName)

    // Body: cases 1–3 run to the endpoint (arrowhead overlaps); case 4 sets back.
    const bodyS = (this._arrowStart && caseIdx === 4) ? { x: start.x + udx*aLen, y: start.y + udy*aLen } : start
    const bodyE = (this._arrowEnd   && caseIdx === 4) ? { x: end.x   - udx*aLen, y: end.y   - udy*aLen } : end
    const pts   = [bodyS, bodyE]

    if (w > pt1 - BRUSH_BLEND_HW && w < pt1 + BRUSH_BLEND_HW) {
      const t        = (w - (pt1 - BRUSH_BLEND_HW)) / (2 * BRUSH_BLEND_HW)
      const effBlend = Math.max(1, w - ((1-t)*(BRUSH_OFFSETS[2]??0) + t*(BRUSH_OFFSETS[3]??0)))
      drawNibBrushBlend(ctx, pts, css, effBlend, seed, NIB_PEN_DEFAULTS, BRUSH_DEFAULTS, t)
    } else {
      switch (caseIdx) {
        case 1: drawPencilLine(ctx,         pts, css, eff, seed); break
        case 2: drawNibPen(ctx,             pts, css, eff, seed); break
        case 3: drawCalligraphyBrush(ctx,   pts, css, eff, seed); break
        case 4: drawLichtensteinStroke(ctx, pts, css, eff, seed); break
      }
    }

    // Arrowheads.
    if (this._arrowEnd || this._arrowStart) {
      const drawHead = (tip: Point, bx: number, by: number) => {
        const lw = { x: bx + nx*hw, y: by + ny*hw }
        const rw = { x: bx - nx*hw, y: by - ny*hw }
        if (caseIdx === 4) {
          ctx.save(); ctx.globalAlpha = 1; ctx.fillStyle = css
          ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(lw.x, lw.y); ctx.lineTo(rw.x, rw.y); ctx.closePath(); ctx.fill()
          ctx.restore()
        } else if (caseIdx === 1) {
          drawPencilLine(ctx, [lw, tip], css, eff, seed)
          drawPencilLine(ctx, [rw, tip], css, eff, seed)
        } else if (caseIdx === 2) {
          drawNibPen(ctx, [lw, tip, rw], css, eff, seed, { ...NIB_PEN_DEFAULTS, splatDensity: 0 })
        } else {
          const cL = { x: (tip.x+lw.x)/2 + nx*hw*0.5, y: (tip.y+lw.y)/2 + ny*hw*0.5 }
          const cR = { x: (tip.x+rw.x)/2 - nx*hw*0.5, y: (tip.y+rw.y)/2 - ny*hw*0.5 }
          drawCalligraphyBrush(ctx, bezier2(tip, cL, lw, 10), css, Math.max(2, eff*0.35), seed, { ...BRUSH_DEFAULTS, taperLength: 0.30 })
          drawCalligraphyBrush(ctx, bezier2(tip, cR, rw, 10), css, Math.max(2, eff*0.35), seed, { ...BRUSH_DEFAULTS, taperLength: 0.30 })
        }
      }
      if (this._arrowEnd)   drawHead(end,   end.x   - udx*aLen, end.y   - udy*aLen)
      if (this._arrowStart) drawHead(start, start.x  + udx*aLen, start.y + udy*aLen)
    }
  }

  // ----------------------------------------------------------
  // renderSelf — single drawImage to pick up one shadow
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    // If canvas was resized between recomputes, rebuild before drawing.
    const cw = Node.canvasWidth, ch = Node.canvasHeight
    if (this._canvas.width !== cw || this._canvas.height !== ch || this._canvasArtisticMode !== Node.artisticMode) this._updateCanvas()
    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, this._opacity))
    ctx.drawImage(this._canvas, 0, 0)
    ctx.restore()
  }

  // ----------------------------------------------------------
  // renderPanel
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    this._drawSimplePill(ctx, this.bounds)
    this._drawCanvasPill(ctx)
  }

  override renderOverlay(ctx: Ctx2D): void {
    this._drawHandles(ctx)
    drawSnapGuides(ctx, this._edgeSnapX, this._edgeSnapY, Node.canvasWidth, Node.canvasHeight)
    this._renderMaskBtn(ctx)
  }

  private _maskBtnRect() {
    const BTN_W = 60, BTN_H = 30, GAP = 14
    const left  = contentLeft(Node.canvasWidth)
    const x     = left + Math.max(0, (Node.viewportWidth - left - BTN_W) / 2)
    return { x, y: Node.viewportHeight - BTN_H - GAP, w: BTN_W, h: BTN_H }
  }

  private _renderMaskBtn(ctx: Ctx2D): void {
    if (this._addMaskDone || this._onAddMask === null) return
    const { x, y, w, h } = this._maskBtnRect()
    const midY = y + h / 2
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 5); ctx.fill()
    ctx.fillStyle = '#cfcf7ecc'
    ctx.beginPath(); ctx.roundRect(x, y, 3, h, [5, 0, 0, 5]); ctx.fill()
    ctx.save()
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.font = '11px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText('Mask', x + 10, midY)
    ctx.restore()
    ctx.restore()
  }

  private _drawSimplePill(ctx: Ctx2D, b: BBox): void {
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
    ctx.fillText('Line', x + 12, y + height / 2)
    ctx.restore()
  }

  private _drawCanvasPill(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds
    if (width <= 0 || height <= 0) return
    const midY   = y + height / 2
    const BTN_SZ = Math.max(16, height - 8)
    const btnY   = y + (height - BTN_SZ) / 2

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe reflects the live line colour.
    const c = this._colour
    ctx.fillStyle = `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},1)`
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Line', x + 12, midY)

    ctx.font      = '10px monospace'
    ctx.fillStyle = this.widthSlot.isActive ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.70)'
    ctx.fillText(`${this._strokeWidth.toFixed(1)}px`, x + 54, midY)

    // Opacity slot indicator
    {
      const active = this.opacitySlot.isActive
      ctx.font      = '9px monospace'
      ctx.fillStyle = active ? AM_COL : 'rgba(255,255,255,0.22)'
      ctx.textAlign = 'right'
      ctx.fillText(active ? '●' : '○', x + width - (2 * BTN_SZ + 4 + 3) - 8, midY)
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText('α', x + width - (2 * BTN_SZ + 4 + 3) - 20, midY)
    }

    // Arrow toggles at right edge: end (▶) first (rightmost), then start (◀).
    let btnX = x + width - BTN_SZ - 3
    this._arrowEndBounds = { x: btnX, y: btnY, width: BTN_SZ, height: BTN_SZ }
    this._renderArrowBtn(ctx, this._arrowEndBounds, 'arrow-right', this._arrowEnd, midY)
    btnX -= BTN_SZ + 4
    this._arrowStartBounds = { x: btnX, y: btnY, width: BTN_SZ, height: BTN_SZ }
    this._renderArrowBtn(ctx, this._arrowStartBounds, 'arrow-left', this._arrowStart, midY)

    ctx.restore()
  }

  private _renderArrowBtn(ctx: Ctx2D, b: BBox, icon: IconName, active: boolean, midY: number): void {
    ctx.fillStyle = active ? ACCENT + '44' : 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 3)
    ctx.fill()
    ctx.strokeStyle = active ? ACCENT : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.roundRect(b.x + 0.5, b.y + 0.5, b.width - 1, b.height - 1, 3)
    ctx.stroke()
    ctx.fillStyle    = active ? ACCENT : 'rgba(255,255,255,0.55)'
    drawIcon(ctx, icon, b.x + b.width / 2, midY, b.height - 8)
  }

  private _drawHandles(ctx: Ctx2D): void {
    const dirMode   = this._dirTranslateMode
    const dragHandle = this._drag
    const startSnapping = dragHandle === 'start' && this._snapSnapped
    const endSnapping   = dragHandle === 'end'   && this._snapSnapped
    this._drawHandle(ctx, dirMode ? this._renderedStart : this._start, this.startSlot.isActive,
      startSnapping, startSnapping ? this._snapProgress : 0)
    this._drawHandle(ctx, dirMode ? this._renderedEnd   : this._end,   this.endSlot.isActive,
      endSnapping,   endSnapping   ? this._snapProgress : 0)
  }

  private _drawHandle(ctx: Ctx2D, pt: Point, bound: boolean, snapping = false, snapProgress = 0): void {
    const glow = bound ? '#666688' : '#ffffff'
    // Filled circle — cyan when snapping, white otherwise
    ctx.save()
    ctx.shadowColor = glow
    ctx.shadowBlur  = 14
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, HANDLE_R, 0, Math.PI * 2)
    ctx.fillStyle = snapping ? SNAP_COL : 'rgba(255,255,255,0.95)'
    ctx.fill()
    ctx.restore()
    // Dark outline (no shadow)
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, HANDLE_R, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(0,0,0,0.65)'
    ctx.lineWidth   = 1.5
    ctx.stroke()
    // Crosshair
    const cr = HANDLE_R - 2
    ctx.strokeStyle = 'rgba(0,0,0,0.80)'
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.moveTo(pt.x - cr, pt.y); ctx.lineTo(pt.x + cr, pt.y)
    ctx.moveTo(pt.x, pt.y - cr); ctx.lineTo(pt.x, pt.y + cr)
    ctx.stroke()
    // Dwell arc sweeping while snapped
    if (snapping && snapProgress > 0) {
      ctx.save()
      ctx.strokeStyle = SNAP_COL
      ctx.lineWidth   = 1.5
      ctx.globalAlpha = 0.85
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, HANDLE_R + 5, -Math.PI / 2, -Math.PI / 2 + snapProgress * 2 * Math.PI)
      ctx.stroke()
      ctx.restore()
    }
  }

  // ----------------------------------------------------------
  // renderSlots — standard slot rows + width slider pill
  // ----------------------------------------------------------

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    this.renderSlotGroup(ctx, [this.startSlot, this.endSlot, this.directionSlot, this.colourSlot, this.opacitySlot], this.panelBottom)
    this._drawWidthPill(ctx)
  }

  private _widthPillBounds(): BBox {
    const mainH = 5 * (SLOT_H + SLOT_GAP) - SLOT_GAP
    return {
      x:      contentLeft(Node.canvasWidth),
      y:      this.panelBottom + mainH + 8,
      width:  panelWidth(Node.canvasWidth),
      height: 2 * SLOT_H + SLOT_GAP,
    }
  }

  private _widthSliderRowBounds(): BBox {
    const pb = this._widthPillBounds()
    return { x: pb.x, y: pb.y, width: pb.width, height: SLOT_H }
  }

  private _widthBindRowBounds(): BBox {
    const pb = this._widthPillBounds()
    return { x: pb.x, y: pb.y + SLOT_H + SLOT_GAP, width: pb.width, height: SLOT_H }
  }

  private _widthSliderGeom() {
    const b          = this._widthSliderRowBounds()
    const midY       = b.y + b.height / 2
    const labelX     = b.x + 12
    const indX       = b.x + b.width - 8
    const valueRight = indX - 14
    const sld0       = labelX + SW_LABEL_W
    const sldR       = valueRight - SW_VALUE_W - 6
    return { b, midY, labelX, sld0, sldR, valueRight, indX }
  }

  private _drawWidthPill(ctx: Ctx2D): void {
    this._drawWidthSlider(ctx)
    this.renderSlotGroup(ctx, [this.widthSlot], this._widthBindRowBounds().y)
  }

  private _drawWidthSlider(ctx: Ctx2D): void {
    const g      = this._widthSliderGeom()
    const { x, y, width, height } = g.b
    const active = this.widthSlot.isActive
    const colour = active ? AM_COL : ACCENT
    const v01    = Math.max(0, Math.min(1, this._strokeWidth / MAX_STROKE_W))

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, 6)
    ctx.fill()

    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.62)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('stroke width', g.labelX, g.midY)

    this._drawSlider(ctx, g.midY, g.sld0, g.sldR, v01, colour)

    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.textAlign = 'right'
    ctx.fillText(`${this._strokeWidth.toFixed(1)}px`, g.valueRight, g.midY)

    ctx.font      = '9px monospace'
    ctx.fillStyle = active ? AM_COL : 'rgba(255,255,255,0.22)'
    ctx.textAlign = 'right'
    ctx.fillText(active ? '●' : '○', g.indX, g.midY)

    ctx.restore()
  }

  private _drawSlider(ctx: Ctx2D, midY: number, x0: number, x1: number, v: number, colour: string): void {
    const thumbR = 5
    const lo     = x0 + thumbR
    const hi     = x1 - thumbR
    const range  = Math.max(0, hi - lo)
    const thumbX = lo + Math.max(0, Math.min(1, v)) * range

    ctx.lineCap     = 'round'
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth   = 3
    ctx.beginPath(); ctx.moveTo(lo, midY); ctx.lineTo(hi, midY); ctx.stroke()

    ctx.strokeStyle = colour
    ctx.beginPath(); ctx.moveTo(lo, midY); ctx.lineTo(thumbX, midY); ctx.stroke()

    ctx.fillStyle = colour
    ctx.beginPath(); ctx.arc(thumbX, midY, thumbR, 0, Math.PI * 2); ctx.fill()
  }

  private _setWidthFromPointer(px: number): void {
    if (this.widthSlot.state === SlotState.Bound) BindingLayer.findForSlot(this.widthSlot)?.toggle()
    const g      = this._widthSliderGeom()
    const thumbR = 5
    const lo     = g.sld0 + thumbR
    const hi     = g.sldR - thumbR
    const range  = Math.max(1e-6, hi - lo)
    this._strokeWidth = Math.max(0.5, Math.max(0, Math.min(1, (px - lo) / range)) * MAX_STROKE_W)
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Angle snap helpers
  // ----------------------------------------------------------

  private _applySnapAngle(rawPt: Point, fixedPt: Point): Point {
    const dx  = rawPt.x - fixedPt.x
    const dy  = rawPt.y - fixedPt.y
    const len = Math.hypot(dx, dy)
    if (len < 0.5) {
      this._snapSnapped  = false
      this._snapProgress = 0
      return rawPt
    }
    const result = this._lineSnapper.update(Math.atan2(dy, dx))
    this._snapSnapped  = result.snapped
    this._snapProgress = result.progress
    if (result.snapped && this._snapDwellTimer === null) {
      this._snapDwellTimer = setInterval(() => {
        // Feed current stored angle back into snapper to advance dwell timer.
        const [fixed, moving] = this._drag === 'end'
          ? [this._start, this._end] : [this._end, this._start]
        const adx = moving.x - fixed.x, ady = moving.y - fixed.y
        const r = this._lineSnapper.update(Math.atan2(ady, adx))
        this._snapSnapped  = r.snapped
        this._snapProgress = r.progress
        this.markDirty()
        if (this._lineSnapper.isRefining) this._clearSnapDwellTimer()
      }, 16)
    } else if (!result.snapped) {
      this._clearSnapDwellTimer()
    }
    return {
      x: fixedPt.x + Math.cos(result.angle) * len,
      y: fixedPt.y + Math.sin(result.angle) * len,
    }
  }

  private _clearSnapDwellTimer(): void {
    if (this._snapDwellTimer !== null) {
      clearInterval(this._snapDwellTimer)
      this._snapDwellTimer = null
    }
    this._snapSnapped  = false
    this._snapProgress = 0
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  get isInteractive(): boolean { return true }

  // True when direction defines the end position and neither raw point is bound.
  // In this mode the visual handles live at the rendered endpoints, not the raw
  // _start/_end, and dragging either handle translates the whole line.
  private get _dirTranslateMode(): boolean {
    return this.directionSlot.isActive && !this.startSlot.isActive && !this.endSlot.isActive
  }

  protected override hitTestSelf(point: Point): this | null {
    if (this._drag !== null || this._sliderDrag || this._pivotDrag !== null) return this
    if (!this._addMaskDone && this._onAddMask !== null) {
      const { x, y, w, h } = this._maskBtnRect()
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h) return this
    }
    if (this._arrowStartBounds !== null && this._inBox(point, this._arrowStartBounds)) return this
    if (this._arrowEndBounds   !== null && this._inBox(point, this._arrowEndBounds))   return this
    const dirMode = this._dirTranslateMode
    if (ptDist(point, dirMode ? this._renderedStart : this._start) <= HANDLE_HIT) return this
    if (ptDist(point, dirMode ? this._renderedEnd   : this._end)   <= HANDLE_HIT) return this
    if (this._inBox(point, this._widthSliderRowBounds())) return this
    return null
  }

  private _inBox(p: Point, b: BBox): boolean {
    return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (!this._addMaskDone && this._onAddMask !== null) {
      const { x, y, w, h } = this._maskBtnRect()
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h) {
        this._addMaskDone = true
        this._onAddMask()
        return true
      }
    }

    if (this._arrowStartBounds !== null && this._inBox(point, this._arrowStartBounds)) {
      this._arrowStart = !this._arrowStart
      this.markDirty()
      return true
    }
    if (this._arrowEndBounds !== null && this._inBox(point, this._arrowEndBounds)) {
      this._arrowEnd = !this._arrowEnd
      this.markDirty()
      return true
    }

    const dirMode = this._dirTranslateMode

    if (ptDist(point, dirMode ? this._renderedStart : this._start) <= HANDLE_HIT) {
      if (dirMode) {
        if (this._lastDraggedHandle === 'end') {
          // Handle switch: snap _end to its rendered position so the line stays
          // in place after direction is suspended, then let the user drag start.
          this._end = { ...this._renderedEnd }
          BindingLayer.findForSlot(this.directionSlot)?.toggle()
          this._lastDraggedHandle = null
          this._drag = 'start'; this._dragStartMouse = { ...point }
          this._dragStartPt = { ...this._start }; this._dragStartOtherPt = null
          this._lineSnapper.reset()
          return true
        }
        this._lastDraggedHandle = 'start'
        this._drag = 'start'; this._dragStartMouse = { ...point }
        // translate-both: _dragStartPt = _start, _dragStartOtherPt = _end (always)
        this._dragStartPt = { ...this._start }; this._dragStartOtherPt = { ...this._end }
        return true
      }
      if (this.startSlot.state === SlotState.Bound) BindingLayer.findForSlot(this.startSlot)?.toggle()
      this._drag = 'start'; this._dragStartMouse = { ...point }
      this._dragStartPt = { ...this._start }; this._dragStartOtherPt = null
      this._lineSnapper.reset()
      return true
    }

    if (ptDist(point, dirMode ? this._renderedEnd : this._end) <= HANDLE_HIT) {
      if (dirMode) {
        if (this._lastDraggedHandle === 'start') {
          // Handle switch: snap _end so the line stays in place after suspension.
          this._end = { ...this._renderedEnd }
          BindingLayer.findForSlot(this.directionSlot)?.toggle()
          this._lastDraggedHandle = null
          this._drag = 'end'; this._dragStartMouse = { ...point }
          this._dragStartPt = { ...this._end }; this._dragStartOtherPt = null
          this._lineSnapper.reset()
          return true
        }
        this._lastDraggedHandle = 'end'
        this._drag = 'end'; this._dragStartMouse = { ...point }
        // translate-both: _dragStartPt = _start, _dragStartOtherPt = _end (always)
        this._dragStartPt = { ...this._start }; this._dragStartOtherPt = { ...this._end }
        return true
      }
      if (this.endSlot.state === SlotState.Bound) BindingLayer.findForSlot(this.endSlot)?.toggle()
      this._drag = 'end'; this._dragStartMouse = { ...point }
      this._dragStartPt = { ...this._end }; this._dragStartOtherPt = null
      this._lineSnapper.reset()
      return true
    }

    if (this._inBox(point, this._widthSliderRowBounds())) {
      this._sliderDrag = true
      this._setWidthFromPointer(point.x)
      return true
    }

    return false
  }

  startCenterDrag(point: Point): boolean {
    // Direction slot always disabled — it would fight any positional movement.
    if (this.directionSlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this.directionSlot)?.toggle()
    }

    const startActive = this.startSlot.isActive
    const endActive   = this.endSlot.isActive

    if (startActive && !endActive) {
      // Start is slot-bound (fixed); rotate _end around the rendered start pivot.
      const pivot = { ...this._renderedStart }
      const freeDist = Math.hypot(this._end.x - pivot.x, this._end.y - pivot.y)
      if (freeDist < 1) return false
      this._pivotDrag = {
        pivot,
        grabAngle: Math.atan2(point.y - pivot.y, point.x - pivot.x),
        freeAngle: Math.atan2(this._end.y - pivot.y, this._end.x - pivot.x),
        freeDist,
        freeIsEnd: true,
      }
      this.markDirty()
      return true
    }

    if (endActive && !startActive) {
      // End is slot-bound (fixed); rotate _start around the rendered end pivot.
      const pivot = { ...this._renderedEnd }
      const freeDist = Math.hypot(this._start.x - pivot.x, this._start.y - pivot.y)
      if (freeDist < 1) return false
      this._pivotDrag = {
        pivot,
        grabAngle: Math.atan2(point.y - pivot.y, point.x - pivot.x),
        freeAngle: Math.atan2(this._start.y - pivot.y, this._start.x - pivot.x),
        freeDist,
        freeIsEnd: false,
      }
      this.markDirty()
      return true
    }

    // Both bound or neither bound → translate the whole line.
    // Suspend any individually-active endpoint slots first.
    if (startActive) BindingLayer.findForSlot(this.startSlot)?.toggle()
    if (endActive)   BindingLayer.findForSlot(this.endSlot)?.toggle()
    this._drag           = 'start'
    this._dragStartMouse = { ...point }
    this._dragStartPt    = { ...this._start }
    this._dragStartOtherPt = { ...this._end }
    this.markDirty()
    return true
  }

  handlePointerMove(point: Point): void {
    if (this._sliderDrag) {
      this._setWidthFromPointer(point.x)
      return
    }
    if (this._pivotDrag !== null) {
      const pd = this._pivotDrag
      const currentAngle = Math.atan2(point.y - pd.pivot.y, point.x - pd.pivot.x)
      const newAngle = pd.freeAngle + (currentAngle - pd.grabAngle)
      const newPt = {
        x: pd.pivot.x + Math.cos(newAngle) * pd.freeDist,
        y: pd.pivot.y + Math.sin(newAngle) * pd.freeDist,
      }
      if (pd.freeIsEnd) this._end   = newPt
      else              this._start = newPt
      this.markDirty()
      return
    }
    if (this._drag === null || this._dragStartMouse === null || this._dragStartPt === null) return
    const dx = point.x - this._dragStartMouse.x
    const dy = point.y - this._dragStartMouse.y
    if (this._dragStartOtherPt !== null) {
      // Translate-both: _dragStartPt = _start at begin, _dragStartOtherPt = _end at begin.
      // Apply the same delta to both regardless of which handle (_drag) was clicked.
      // No angle snap in translate mode — the angle doesn't change.
      this._start = { x: this._dragStartPt.x + dx, y: this._dragStartPt.y + dy }
      this._end   = { x: this._dragStartOtherPt.x + dx, y: this._dragStartOtherPt.y + dy }
      this._edgeSnapX = null; this._edgeSnapY = null
    } else {
      const rawPt = { x: this._dragStartPt.x + dx, y: this._dragStartPt.y + dy }
      // Apply angle snap first (preserves distance, adjusts direction).
      const anglePt = this._drag === 'start'
        ? this._applySnapAngle(rawPt, this._end)
        : this._applySnapAngle(rawPt, this._start)
      // Then apply edge snap to the (possibly angle-snapped) point.
      const edges = collectSnapEdges(this, 3)
      if (edges.xs.length > 0 || edges.ys.length > 0) {
        const snapped = snapPointToEdges(anglePt, edges, EDGE_SNAP_THRESHOLD)
        if (this._drag === 'start') this._start = { x: snapped.x, y: snapped.y }
        else                        this._end   = { x: snapped.x, y: snapped.y }
        this._edgeSnapX = snapped.snapLineX; this._edgeSnapY = snapped.snapLineY
      } else {
        if (this._drag === 'start') this._start = anglePt
        else                        this._end   = anglePt
        this._edgeSnapX = null; this._edgeSnapY = null
      }
    }
    this.markDirty()
  }

  handlePointerUp(): void {
    this._drag             = null
    this._dragStartMouse   = null
    this._dragStartPt      = null
    this._dragStartOtherPt = null
    this._pivotDrag        = null
    this._sliderDrag       = false
    this._clearSnapDwellTimer()
    this._edgeSnapX = null; this._edgeSnapY = null
    // _lastDraggedHandle intentionally kept: it persists across drag sessions so
    // that switching to the other handle on a subsequent drag disables direction.
  }
}
