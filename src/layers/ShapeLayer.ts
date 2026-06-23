import { Layer } from '../core/Layer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState, boundingBoxContains,
  type Colour, type ColourSource,
  type Point,  type PointSource,
  type Amount, type AmountSource,
  type EventValue, type EventSource,
  type MaskValue,  type MaskSource,
  type ImageValue, type ImageSource,
  type Direction,  type DirectionSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'
import { AngleSnapper } from '../interaction/AngleSnapper.js'

// ------------------------------------------------------------
// ShapeLayer — abstract base for rectangle and ellipse layers
// ------------------------------------------------------------
//
// Provides:
//   • Center position, width, height, rotation angle, uniform scale
//   • Five input slots: positionSlot (Point), colourSlot (Colour),
//     opacitySlot (Amount), scaleSlot (Amount), rotationSlot (Direction)
//   • Ten interactive handles: center (move), four edge midpoints
//     (anchored resize — the opposite edge/corner stays fixed in canvas
//     space, so the centre shifts as the box is resized), four corners
//     (anchored resize), one rotation handle (upper-right of bounding box)
//   • renderSelf  — draws shape content via abstract drawShape()
//   • renderPanel — strip pill + canvas panel pill + handle overlays
//   • PointSource output — center of the shape
//
// Subclasses implement drawShape() and samplePerimeter().

const ACCENT     = '#e8a04a'   // warm amber — shape type colour
const DIR_ACCENT = '#7ecfcf'   // Direction type colour
const AM_COL     = '#4a8fe8'   // Amount type accent (stroke-width slot)
const HANDLE_R  = 5           // handle square/circle half-size (px)
const HIT_R     = 12          // pointer hit radius (px)

const ROT_SNAP_ANGLES: readonly number[] = Array.from({ length: 8 }, (_, i) => i * Math.PI / 4)
const ROT_SNAP_THRESHOLD = Math.PI / 12
const ROT_SNAP_DWELL_MS  = 700
const ROT_SNAP_COL = '#7ecfcf'
const MIN_SIZE  = 20          // minimum width / height (px)
const ROT_OFF   = 24          // rotation handle distance beyond corner (px)

// Stroke/scale control pill, drawn directly below the canvas-space panel pill.
const SLOT_H    = 26
const SLOT_GAP  = 4
const BTN_SZ    = SLOT_H - 6   // square toggle-button size
const SW_LABEL_W = 78
const SW_VALUE_W = 38
const MAX_STROKE_WIDTH = 30    // Amount [0,1] -> stroke width [0.5, 30] px
const MAX_SCALE = 2            // Amount [0,1] -> scale [0, 2], 0.5 -> 1.0×

// Handle index constants
const H_CENTER = 0
const H_LEFT   = 1
const H_RIGHT  = 2
const H_TOP    = 3
const H_BOTTOM = 4
const H_TL     = 5
const H_TR     = 6
const H_BL     = 7
const H_BR     = 8
const H_ROTATE = 9

type BBox = { x: number; y: number; width: number; height: number }

// Resize one axis (width or height) by `delta` in local (unrotated) space,
// returning the new size and the signed shift — along that axis's unit
// vector — needed to keep the *opposite* edge/corner fixed in canvas space.
// sign = +1 for the positive-side handle (right/bottom), -1 for the
// negative-side handle (left/top).
function resizeAxis(startSize: number, delta: number, sign: 1 | -1): { size: number; shift: number } {
  const size = Math.max(MIN_SIZE, startSize + sign * delta)
  return { size, shift: sign * (size - startSize) / 2 }
}

export abstract class ShapeLayer extends Layer implements PointSource, MaskSource, ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point, ValueType.Mask, ValueType.Image])

  protected _cx:     number
  protected _cy:     number
  protected _width:  number
  protected _height: number
  protected _angle:  number = 0   // radians
  protected _scale:  number = 1   // uniform scale multiplier (Amount * 2)

  protected _colour:  Colour = { r: 1, g: 1, b: 1, a: 1 }
  protected _opacity: number = 1

  private _maskCanvas:  OffscreenCanvas = new OffscreenCanvas(1, 1)
  private _imageCanvas: OffscreenCanvas = new OffscreenCanvas(1, 1)

  readonly positionSlot:    ParameterSlot
  readonly colourSlot:      ParameterSlot
  readonly opacitySlot:     ParameterSlot
  readonly scaleSlot:       ParameterSlot
  readonly fillModeSlot:    ParameterSlot
  readonly rotationSlot:    ParameterSlot
  readonly strokeWidthSlot: ParameterSlot

  protected _filled = true
  protected _strokeWidth = 2
  protected _strokeSliderDrag = false
  private   _scaleSliderDrag  = false

  private _lastEventTime:  EventValue = null
  protected _toggleBounds: { x: number; y: number; width: number; height: number } | null = null

  // Drag state
  private _dragHandle          = -1
  private _dragStartPtr:  Point = { x: 0, y: 0 }
  private _dragStartCx         = 0
  private _dragStartCy         = 0
  private _dragStartW          = 0
  private _dragStartH          = 0
  private _dragStartAngle      = 0
  private _rotLocalAngle       = 0   // atan2 of rot handle in local space

  private readonly _rotSnapper = new AngleSnapper(ROT_SNAP_ANGLES, ROT_SNAP_THRESHOLD, ROT_SNAP_DWELL_MS)
  private _snapSnapped  = false
  private _snapProgress = 0
  private _rotDwellTimer: ReturnType<typeof setInterval> | null = null

  constructor(cx: number, cy: number, width: number, height: number, colour?: Colour) {
    super()
    this._cx     = cx
    this._cy     = cy
    this._width  = width
    this._height = height
    if (colour !== undefined) this._colour = colour

    this.positionSlot  = new ParameterSlot(ValueType.Point,     this, 'position')
    this.colourSlot    = new ParameterSlot(ValueType.Colour,    this, 'colour')
    this.opacitySlot   = new ParameterSlot(ValueType.Amount,    this, 'opacity')
    this.scaleSlot     = new ParameterSlot(ValueType.Amount,    this, 'scale')
    this.fillModeSlot  = new ParameterSlot(ValueType.Event,     this, 'outline mode')
    this.rotationSlot  = new ParameterSlot(ValueType.Direction, this, 'rotation')
    this.strokeWidthSlot = new ParameterSlot(ValueType.Amount,  this, 'stroke width')
    this.slots.push(this.positionSlot, this.colourSlot, this.opacitySlot, this.scaleSlot, this.fillModeSlot, this.rotationSlot, this.strokeWidthSlot)
    graph.register(this)
  }

  // ----------------------------------------------------------
  // Subclass contract
  // ----------------------------------------------------------

  /** Draw the shape at the given canvas-space parameters. */
  protected abstract drawShape(
    ctx: Ctx2D,
    cx: number, cy: number,
    w: number, h: number,
    angle: number,
    colour: Colour,
    opacity: number,
    filled: boolean,
    strokeWidth: number,
  ): void

  /** Return canvas coordinate at t ∈ [0, 1) on the shape's perimeter. */
  abstract samplePerimeter(t: number): Point

  getPoint(): Point { return { x: this._cx, y: this._cy } }

  // Seed a newly-created layer (via slot-click-to-create) with the value
  // currently shown by the corresponding manual control, so the binding
  // starts as a no-op.
  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | null {
    if (slot === this.positionSlot) return { x: this._cx, y: this._cy }
    if (slot === this.opacitySlot)  return this._opacity
    if (slot === this.scaleSlot)    return this._scale / MAX_SCALE
    if (slot === this.rotationSlot) return { angle: this._angle, magnitude: 1 }
    if (slot === this.strokeWidthSlot) return Math.max(0, Math.min(1, this._strokeWidth / MAX_STROKE_WIDTH))
    return null
  }

  getMask():  MaskValue  { return this._maskCanvas  }
  getImage(): ImageValue { return this._imageCanvas }

  // Switch between filled and outline rendering — used by the random
  // shape factory (slot-click-to-create) to start new shapes in outline
  // mode, since their main purpose there is to define a region, not to
  // add coloured content.
  setFilled(filled: boolean): void {
    this._filled = filled
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this.positionSlot.isActive) {
      const p = (this.positionSlot.source as PointSource).getPoint()
      this._cx = p.x
      this._cy = p.y
    }
    if (this.colourSlot.isActive) {
      this._colour = (this.colourSlot.source as ColourSource).getColour()
    }
    if (this.opacitySlot.isActive) {
      this._opacity = (this.opacitySlot.source as AmountSource).getAmount() as Amount
    }
    if (this.scaleSlot.isActive) {
      this._scale = (this.scaleSlot.source as AmountSource).getAmount() * MAX_SCALE
    }
    if (this.fillModeSlot.isActive) {
      const t = (this.fillModeSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastEventTime) {
        this._lastEventTime = t
        this._filled = !this._filled
      }
    }
    if (this.rotationSlot.isActive) {
      this._angle = (this.rotationSlot.source as DirectionSource).getDirection().angle
    }
    if (this.strokeWidthSlot.isActive) {
      this._strokeWidth = Math.max(0.5, (this.strokeWidthSlot.source as AmountSource).getAmount() * MAX_STROKE_WIDTH)
    }
    this._updateOffscreens()
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      cx: this._cx, cy: this._cy, width: this._width, height: this._height,
      angle: this._angle, colour: this._colour, opacity: this._opacity,
      filled: this._filled, strokeWidth: this._strokeWidth, scale: this._scale,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.cx === 'number')     this._cx = state.cx
    if (typeof state.cy === 'number')     this._cy = state.cy
    if (typeof state.width === 'number')  this._width = state.width
    if (typeof state.height === 'number') this._height = state.height
    if (typeof state.angle === 'number')  this._angle = state.angle
    if (state.colour)                     this._colour = state.colour as Colour
    if (typeof state.opacity === 'number')     this._opacity = state.opacity
    if (typeof state.filled === 'boolean')     this._filled = state.filled
    if (typeof state.strokeWidth === 'number') this._strokeWidth = state.strokeWidth
    if (typeof state.scale === 'number')       this._scale = state.scale
  }

  private _updateOffscreens(): void {
    const w = Node.canvasWidth
    const h = Node.canvasHeight

    if (this._maskCanvas.width !== w || this._maskCanvas.height !== h) {
      this._maskCanvas = new OffscreenCanvas(w, h)
    }
    const mctx = this._maskCanvas.getContext('2d')!
    mctx.clearRect(0, 0, w, h)
    // White filled shape on transparent — alpha encodes inclusion.
    this.drawShape(mctx, this._cx, this._cy, this._width * this._scale, this._height * this._scale, this._angle,
      { r: 1, g: 1, b: 1, a: 1 }, 1, true, this._strokeWidth)

    if (this._imageCanvas.width !== w || this._imageCanvas.height !== h) {
      this._imageCanvas = new OffscreenCanvas(w, h)
    }
    const ictx = this._imageCanvas.getContext('2d')!
    ictx.clearRect(0, 0, w, h)
    // Shape rendered at its actual colour and fill mode.
    this.drawShape(ictx, this._cx, this._cy, this._width * this._scale, this._height * this._scale, this._angle,
      this._colour, this._opacity, this._filled, this._strokeWidth)
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    this.drawShape(ctx, this._cx, this._cy,
      this._width * this._scale, this._height * this._scale, this._angle, this._colour, this._opacity, this._filled, this._strokeWidth)
  }

  renderPanel(ctx: Ctx2D): void {
    this._drawPill(ctx, this.bounds)
    this._drawPill(ctx, this.canvasBounds)
  }

  override renderOverlay(ctx: Ctx2D): void {
    this._drawHandles(ctx)
  }

  // fillModeSlot, strokeWidthSlot, and scaleSlot are pulled out of the
  // standard slot pill and rendered together in a second pill below the
  // canvas-space panel (see _drawStrokePill).
  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const standardSlots = this.slots.filter(
      s => s !== this.fillModeSlot && s !== this.strokeWidthSlot && s !== this.scaleSlot
    )
    this.renderSlotGroup(ctx, standardSlots, this.panelBottom)
    this._drawStrokePill(ctx)
  }

  override get panelBottom(): number {
    return 50 + this.bounds.height + 8
  }

  protected _strokePillBounds(): BBox {
    const cb = this.canvasBounds
    const standardSlots = this.slots.filter(
      s => s !== this.fillModeSlot && s !== this.strokeWidthSlot && s !== this.scaleSlot
    )
    const standardH = standardSlots.length * (SLOT_H + SLOT_GAP) - SLOT_GAP
    return { x: cb.x, y: this.panelBottom + standardH + 8, width: cb.width, height: 5 * SLOT_H + 4 * SLOT_GAP }
  }

  private _outlineRowBounds(): BBox {
    const pb = this._strokePillBounds()
    return { x: pb.x, y: pb.y, width: pb.width, height: SLOT_H }
  }

  protected _strokeRowBounds(): BBox {
    const pb = this._strokePillBounds()
    return { x: pb.x, y: pb.y + SLOT_H + SLOT_GAP, width: pb.width, height: SLOT_H }
  }

  private _strokeBindRowBounds(): BBox {
    const pb = this._strokePillBounds()
    return { x: pb.x, y: pb.y + 2 * (SLOT_H + SLOT_GAP), width: pb.width, height: SLOT_H }
  }

  private _scaleRowBounds(): BBox {
    const pb = this._strokePillBounds()
    return { x: pb.x, y: pb.y + 3 * (SLOT_H + SLOT_GAP), width: pb.width, height: SLOT_H }
  }

  private _scaleBindRowBounds(): BBox {
    const pb = this._strokePillBounds()
    return { x: pb.x, y: pb.y + 4 * (SLOT_H + SLOT_GAP), width: pb.width, height: SLOT_H }
  }

  protected _strokeSliderGeom() {
    const b = this._strokeRowBounds()
    const midY = b.y + b.height / 2
    const labelX = b.x + 12
    const indX = b.x + b.width - 8
    const valueRight = indX - 14
    const sld0 = labelX + SW_LABEL_W
    const sldR = valueRight - SW_VALUE_W - 6
    return { b, midY, labelX, sld0, sldR, valueRight, indX }
  }

  private _scaleSliderGeom() {
    const b = this._scaleRowBounds()
    const midY       = b.y + b.height / 2
    const labelX     = b.x + 12
    const indX       = b.x + b.width - 8
    const valueRight = indX - 14
    const sld0       = labelX + SW_LABEL_W
    const sldR       = valueRight - SW_VALUE_W - 6
    return { b, midY, labelX, sld0, sldR, valueRight, indX }
  }

  protected _scaleSliderHit(point: Point): boolean {
    return boundingBoxContains(this._scaleRowBounds(), point)
  }

  protected _setScaleFromPointer(px: number): void {
    if (this.scaleSlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this.scaleSlot)?.toggle()
    }
    const g = this._scaleSliderGeom()
    const thumbR = 5
    const lo = g.sld0 + thumbR
    const hi = g.sldR - thumbR
    const range = Math.max(1e-6, hi - lo)
    const v = Math.max(0, Math.min(1, (px - lo) / range))
    this._scale = v * MAX_SCALE
    this.markDirty()
  }

  protected _drawStrokePill(ctx: Ctx2D): void {
    // Row 1 — "outline mode" toggle, moved here from the standard slot pill.
    this.renderSlotGroup(ctx, [this.fillModeSlot], this._outlineRowBounds().y)
    this._drawOutlineToggle(ctx)

    // Row 2 — stroke-width slider.
    this._drawStrokeSlider(ctx)

    // Row 3 — strokeWidthSlot binding row (standard label + drop-target box).
    this.renderSlotGroup(ctx, [this.strokeWidthSlot], this._strokeBindRowBounds().y)

    // Row 4 — scale slider.
    this._drawScaleSlider(ctx)

    // Row 5 — scaleSlot binding row.
    this.renderSlotGroup(ctx, [this.scaleSlot], this._scaleBindRowBounds().y)
  }

  private _drawOutlineToggle(ctx: Ctx2D): void {
    const row = this._outlineRowBounds()
    const midY = row.y + row.height / 2
    const btnX = row.x + row.width - BTN_SZ - 3
    const btnY = row.y + 3
    this._toggleBounds = { x: btnX, y: btnY, width: BTN_SZ, height: BTN_SZ }

    const state   = this.fillModeSlot.state
    const isActive    = state === SlotState.Bound
    const isSuspended = state === SlotState.SuspendedBound
    const outlineMode = !this._filled

    ctx.save()
    if (isActive) {
      ctx.fillStyle = ACCENT + '33'
    } else if (isSuspended) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)'
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.08)'
    }
    ctx.beginPath()
    ctx.roundRect(btnX, btnY, BTN_SZ, BTN_SZ, 3)
    ctx.fill()

    ctx.strokeStyle = isActive ? ACCENT + '99' : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    if (isSuspended) ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.roundRect(btnX + 0.5, btnY + 0.5, BTN_SZ - 1, BTN_SZ - 1, 3)
    ctx.stroke()
    ctx.setLineDash([])

    const cbr = 4
    const colour = isActive ? ACCENT : isSuspended ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.70)'
    ctx.strokeStyle = colour
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.arc(btnX + BTN_SZ / 2, midY, cbr, 0, Math.PI * 2)
    ctx.stroke()
    if (outlineMode) {
      ctx.fillStyle = colour
      ctx.beginPath()
      ctx.arc(btnX + BTN_SZ / 2, midY, cbr - 2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  private _drawStrokeSlider(ctx: Ctx2D): void {
    const g = this._strokeSliderGeom()
    const { x, y, width, height } = g.b

    const active = this.strokeWidthSlot.isActive
    const colour = active ? AM_COL : ACCENT
    const v01 = Math.max(0, Math.min(1, this._strokeWidth / MAX_STROKE_WIDTH))

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

  private _drawScaleSlider(ctx: Ctx2D): void {
    const g = this._scaleSliderGeom()
    const { x, y, width, height } = g.b

    const active = this.scaleSlot.isActive
    const colour = active ? AM_COL : ACCENT
    const v01 = Math.max(0, Math.min(1, this._scale / MAX_SCALE))

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, 6)
    ctx.fill()

    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.62)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('scale', g.labelX, g.midY)

    this._drawSlider(ctx, g.midY, g.sld0, g.sldR, v01, colour)

    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.textAlign = 'right'
    ctx.fillText(`${this._scale.toFixed(2)}×`, g.valueRight, g.midY)

    ctx.font      = '9px monospace'
    ctx.fillStyle = active ? AM_COL : 'rgba(255,255,255,0.22)'
    ctx.textAlign = 'right'
    ctx.fillText(active ? '●' : '○', g.indX, g.midY)

    ctx.restore()
  }

  protected _drawSlider(ctx: Ctx2D, midY: number, x0: number, x1: number, v: number, colour: string): void {
    const thumbR = 5
    const lo = x0 + thumbR
    const hi = x1 - thumbR
    const range = Math.max(0, hi - lo)
    const thumbX = lo + Math.max(0, Math.min(1, v)) * range

    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(lo, midY)
    ctx.lineTo(hi, midY)
    ctx.stroke()

    ctx.strokeStyle = colour
    ctx.beginPath()
    ctx.moveTo(lo, midY)
    ctx.lineTo(thumbX, midY)
    ctx.stroke()

    ctx.fillStyle = colour
    ctx.beginPath()
    ctx.arc(thumbX, midY, thumbR, 0, Math.PI * 2)
    ctx.fill()
  }

  protected _setStrokeWidthFromPointer(px: number): void {
    if (this.strokeWidthSlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this.strokeWidthSlot)?.toggle()
    }
    const g = this._strokeSliderGeom()
    const thumbR = 5
    const lo = g.sld0 + thumbR
    const hi = g.sldR - thumbR
    const range = Math.max(1e-6, hi - lo)
    const v = Math.max(0, Math.min(1, (px - lo) / range))
    this._strokeWidth = Math.max(0.5, v * MAX_STROKE_WIDTH)
    this.markDirty()
  }

  protected _strokeSliderHit(point: Point): boolean {
    return boundingBoxContains(this._strokeRowBounds(), point)
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    // Toggle checkbox
    if (this._toggleBounds !== null) {
      const b = this._toggleBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) return this
    }
    // Stroke-width slider
    if (this._strokeSliderHit(point)) return this
    // Scale slider
    if (this._scaleSliderHit(point)) return this
    // Shape handles
    const r2 = HIT_R * HIT_R
    for (const h of this._handlePositions()) {
      const dx = point.x - h.x
      const dy = point.y - h.y
      if (dx * dx + dy * dy <= r2) return this
    }
    return null
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    // Toggle fill/outline via button click
    if (this._toggleBounds !== null) {
      const b = this._toggleBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) {
        if (this.fillModeSlot.state === SlotState.Bound) {
          this.fillModeSlot.suspend()
        } else if (this.fillModeSlot.state === SlotState.SuspendedBound) {
          this.fillModeSlot.resume()
        } else {
          this._filled = !this._filled
        }
        this.markDirty()
        return true
      }
    }

    // Stroke-width slider
    if (this._strokeSliderHit(point)) {
      this._strokeSliderDrag = true
      this._setStrokeWidthFromPointer(point.x)
      this.markDirty()
      return true
    }

    // Scale slider
    if (this._scaleSliderHit(point)) {
      this._scaleSliderDrag = true
      this._setScaleFromPointer(point.x)
      this.markDirty()
      return true
    }

    const handles = this._handlePositions()
    let best = -1, bestD2 = HIT_R * HIT_R
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i]!
      const d2 = (point.x - h.x) ** 2 + (point.y - h.y) ** 2
      if (d2 < bestD2) { bestD2 = d2; best = i }
    }
    if (best < 0) return false

    this._dragHandle     = best
    this._dragStartPtr   = { ...point }
    this._dragStartCx    = this._cx
    this._dragStartCy    = this._cy
    this._dragStartW     = this._width
    this._dragStartH     = this._height
    this._dragStartAngle = this._angle

    // Pre-compute the local angle of the rotation handle for smooth rotation
    if (best === H_CENTER) {
      if (this.positionSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this.positionSlot)?.toggle()
      }
    }

    if (best === H_ROTATE) {
      if (this.rotationSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this.rotationSlot)?.toggle()
      }
      const hw = this._width * this._scale / 2, hh = this._height * this._scale / 2
      this._rotLocalAngle = Math.atan2(-(hh + ROT_OFF), hw + ROT_OFF)
      this._rotSnapper.reset()
    }

    // Resize handles: suspend scale binding so manual resizing takes over.
    if (best !== H_CENTER && best !== H_ROTATE) {
      if (this.scaleSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this.scaleSlot)?.toggle()
      }
    }

    this.markDirty()
    return true
  }

  handlePointerMove(point: Point): void {
    if (this._strokeSliderDrag) {
      this._setStrokeWidthFromPointer(point.x)
      return
    }
    if (this._scaleSliderDrag) {
      this._setScaleFromPointer(point.x)
      return
    }
    if (this._dragHandle < 0) return

    const dx = point.x - this._dragStartPtr.x
    const dy = point.y - this._dragStartPtr.y

    if (this._dragHandle === H_CENTER && !this.positionSlot.isActive) {
      this._cx = this._dragStartCx + dx
      this._cy = this._dragStartCy + dy

    } else if (this._dragHandle === H_ROTATE) {
      // Angle that places rotation handle at the pointer
      const rawAngle = Math.atan2(point.y - this._cy, point.x - this._cx) - this._rotLocalAngle
      this._applySnapAngle(rawAngle)

    } else {
      // Anchored resize: project delta into local (unrotated) space, then
      // resize along the dragged edge(s) only, shifting the centre so the
      // opposite edge/corner stays fixed in canvas space.
      const cos = Math.cos(-this._dragStartAngle)
      const sin = Math.sin(-this._dragStartAngle)
      const lx  = dx * cos - dy * sin
      const ly  = dx * sin + dy * cos

      // Canvas-space unit vectors for the shape's local x/y axes.
      const ac = Math.cos(this._dragStartAngle)
      const as = Math.sin(this._dragStartAngle)
      const ux = { x: ac,  y: as }
      const uy = { x: -as, y: ac }

      let shiftX = 0   // distance to shift the centre along ux
      let shiftY = 0   // distance to shift the centre along uy

      const applyX = (sign: 1 | -1) => {
        const r = resizeAxis(this._dragStartW, lx, sign)
        this._width = r.size
        shiftX = r.shift
      }
      const applyY = (sign: 1 | -1) => {
        const r = resizeAxis(this._dragStartH, ly, sign)
        this._height = r.size
        shiftY = r.shift
      }

      switch (this._dragHandle) {
        case H_LEFT:    applyX(-1); break
        case H_RIGHT:   applyX(1);  break
        case H_TOP:     applyY(-1); break
        case H_BOTTOM:  applyY(1);  break
        case H_TL:      applyX(-1); applyY(-1); break
        case H_TR:      applyX(1);  applyY(-1); break
        case H_BL:      applyX(-1); applyY(1);  break
        case H_BR:      applyX(1);  applyY(1);  break
      }

      this._cx = this._dragStartCx + shiftX * ux.x + shiftY * uy.x
      this._cy = this._dragStartCy + shiftX * ux.y + shiftY * uy.y
    }

    this.markDirty()
  }

  handlePointerUp(): void {
    this._dragHandle = -1
    this._strokeSliderDrag = false
    this._scaleSliderDrag  = false
    this._clearRotDwellTimer()
  }

  private _applySnapAngle(raw: number): void {
    const result = this._rotSnapper.update(raw)
    this._angle        = result.angle
    this._snapSnapped  = result.snapped
    this._snapProgress = result.progress
    if (result.snapped && this._rotDwellTimer === null) {
      this._rotDwellTimer = setInterval(() => {
        const r = this._rotSnapper.update(this._angle)
        this._snapSnapped  = r.snapped
        this._snapProgress = r.progress
        this.markDirty()
        if (this._rotSnapper.isRefining) this._clearRotDwellTimer()
      }, 16)
    } else if (!result.snapped) {
      this._clearRotDwellTimer()
    }
  }

  private _clearRotDwellTimer(): void {
    if (this._rotDwellTimer !== null) {
      clearInterval(this._rotDwellTimer)
      this._rotDwellTimer = null
    }
    this._snapSnapped  = false
    this._snapProgress = 0
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  /** Ten handle positions in canvas space, accounting for rotation and scale. */
  private _handlePositions(): Point[] {
    const { _cx: cx, _cy: cy, _angle } = this
    const hw  = this._width  * this._scale / 2
    const hh  = this._height * this._scale / 2
    const cos = Math.cos(_angle)
    const sin = Math.sin(_angle)
    const T   = (lx: number, ly: number): Point => ({
      x: cx + lx * cos - ly * sin,
      y: cy + lx * sin + ly * cos,
    })
    return [
      T(0,           0          ),   // 0  center
      T(-hw,         0          ),   // 1  left edge
      T(hw,          0          ),   // 2  right edge
      T(0,          -hh         ),   // 3  top edge
      T(0,           hh         ),   // 4  bottom edge
      T(-hw,        -hh         ),   // 5  top-left corner
      T(hw,         -hh         ),   // 6  top-right corner
      T(-hw,         hh         ),   // 7  bottom-left corner
      T(hw,          hh         ),   // 8  bottom-right corner
      T(hw + ROT_OFF, -(hh + ROT_OFF)),  // 9  rotation
    ]
  }

  private _drawHandles(ctx: Ctx2D): void {
    const handles = this._handlePositions()
    const active  = this._dragHandle

    ctx.save()
    ctx.setLineDash([])

    // Bounding-box outline
    const [, , , , , tl, tr, br, bl] = handles
    if (tl && tr && br && bl) {
      ctx.strokeStyle = 'rgba(255,255,255,0.60)'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.moveTo(tl.x, tl.y)
      ctx.lineTo(tr.x, tr.y)
      ctx.lineTo(br.x, br.y)
      ctx.lineTo(bl.x, bl.y)
      ctx.closePath()
      ctx.stroke()
    }

    // Dashed line from TR corner to rotation handle
    const rot = handles[H_ROTATE]!
    if (tr && rot) {
      ctx.strokeStyle = 'rgba(255,255,255,0.30)'
      ctx.lineWidth   = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(tr.x, tr.y)
      ctx.lineTo(rot.x, rot.y)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Handle markers
    for (let i = 0; i < handles.length; i++) {
      const h  = handles[i]!
      const lit = i === active

      ctx.strokeStyle = 'rgba(0,0,0,0.50)'
      ctx.lineWidth   = 1

      if (i === H_ROTATE) {
        const snapCol = this._snapSnapped ? ROT_SNAP_COL : 'rgba(232,160,74,0.85)'
        ctx.fillStyle = lit ? '#ffffff'
          : this.rotationSlot.isActive ? 'rgba(102,102,136,0.85)' : snapCol
        ctx.beginPath()
        ctx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        if (this._snapSnapped && this._snapProgress > 0) {
          const arcR  = HANDLE_R + 5
          const start = -Math.PI / 2
          const end   = start + this._snapProgress * 2 * Math.PI
          ctx.save()
          ctx.strokeStyle = ROT_SNAP_COL
          ctx.lineWidth   = 1.5
          ctx.globalAlpha = 0.85
          ctx.beginPath()
          ctx.arc(h.x, h.y, arcR, start, end)
          ctx.stroke()
          ctx.restore()
          ctx.strokeStyle = 'rgba(0,0,0,0.50)'
          ctx.lineWidth   = 1
        }
      } else if (i === H_CENTER) {
        ctx.fillStyle = lit ? ACCENT : 'rgba(232,160,74,0.70)'
        ctx.beginPath()
        ctx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      } else {
        ctx.fillStyle = lit ? '#ffffff' : 'rgba(255,255,255,0.80)'
        const s = HANDLE_R
        ctx.fillRect(h.x - s, h.y - s, s * 2, s * 2)
        ctx.strokeRect(h.x - s, h.y - s, s * 2, s * 2)
      }
    }

    ctx.restore()
  }

  private _drawPill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return

    const midY = y + height / 2
    const c    = this._colour

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

    // Colour swatch
    ctx.fillStyle = `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${c.a})`
    ctx.beginPath()
    ctx.arc(x + 16, midY, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth   = 1
    ctx.stroke()

    // Dimensions (scaled)
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      `${Math.round(this._width * this._scale)} × ${Math.round(this._height * this._scale)}`,
      x + 28, midY,
    )

    // Angle (right side), with rotation-slot indicator dot
    const deg = ((this._angle * 180 / Math.PI) % 360 + 360) % 360
    const rotActive = this.rotationSlot.isActive
    ctx.fillStyle = rotActive ? DIR_ACCENT : 'rgba(255,255,255,0.50)'
    ctx.textAlign = 'right'
    ctx.fillText(`∠ ${deg.toFixed(0)}°`, x + width - 8, midY)
    const angleW = ctx.measureText(`∠ ${deg.toFixed(0)}°`).width
    ctx.fillStyle = rotActive ? DIR_ACCENT : 'rgba(255,255,255,0.22)'
    ctx.font = '9px monospace'
    ctx.fillText(rotActive ? '●' : '○', x + width - 12 - angleW, midY)

    ctx.restore()
  }
}
