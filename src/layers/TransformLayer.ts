import { Layer } from '../core/Layer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type ImageValue,    type ImageSource,
  type Amount,        type AmountSource,
  type Point,         type PointSource,
  type Direction,     type DirectionSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'
import { AngleSnapper } from '../interaction/AngleSnapper.js'
import { collectSnapEdges, snapPointToEdges, drawSnapGuides, EDGE_SNAP_THRESHOLD } from '../interaction/EdgeSnapper.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'

// ------------------------------------------------------------
// TransformLayer — 2-D affine transform applied to an image
// ------------------------------------------------------------
//
// Takes an ImageSource and applies translate + rotate + scale,
// outputting a transformed image on an OffscreenCanvas.
//
// Input slots:
//   sourceSlot    (Image)     — image to transform.
//                              Unbound: empty output.
//   positionSlot  (Point)     — translation (pivot on canvas).
//                              Unbound default: canvas centre, or the
//                              ⊕ move handle's last manual position.
//   scaleSlot     (Amount)    — [0,1] → [MIN_SCALE, MAX_SCALE].
//                              Unbound default: 1.0, or the □ scale
//                              handle's last manual value.
//   directionSlot (Direction) — angle → rotation (magnitude unused).
//                              Unbound default: the ○ rotate handle's
//                              last manual angle (0 initially).
//   opacitySlot   (Amount)    — global alpha [0, 1].
//                              Unbound default: 1.0.
//
// Manual ⊕/□/○ handles (panel-only, edit mode, same geometry as
// ImageLayer/ClipLayer) drive position/scale/rotation when the
// corresponding slot is unbound. Touching a handle while its slot is
// Bound suspends that binding, handing control to the user (same
// suspend-on-touch convention as AmountLayer/ClipLayer/etc).
//
// Visual layout (height ≈ 36 px):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌  ∠ 45°  × 1.00  (320, 240)  src ○ pos ○ sc ○ dir ○ op ○  │
//   └──────────────────────────────────────────────────────────┘
//
// Call resize(w, h) when the canvas dimensions change.

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT = '#e09840'   // warm amber-orange
const AM_COL = '#4a8fe8'   // Amount type accent (opacity slot)
const DIR_COL = '#7ecfcf'  // Direction type accent (reflect slot)

const MIN_SCALE = 0.05
const MAX_SCALE = 4.0

// Opacity slider pill, drawn directly below the standard slot-row pill.
// Mirrors the constants used by Layer.renderSlotGroup, so its position can
// be computed without re-rendering.
const SLOT_H    = 26
const SLOT_GAP  = 4
const PILL_GAP         = 8    // vertical gap between pills
const OPACITY_H        = 36
const REFLECT_TOGGLE_H = 36   // height of the toggle row inside the reflect pill
const REFLECT_SLOT_H   = 26   // height of the axis slot row inside the reflect pill
const REFLECT_SLOT_GAP = 4
const REFLECT_H        = REFLECT_TOGGLE_H + REFLECT_SLOT_GAP + REFLECT_SLOT_H
const OP_LABEL_W = 50
const OP_VALUE_W = 40

// Handle geometry (matches ImageLayer/ClipLayer)
const HANDLE_R   = 7
const HANDLE_SZ  = 6
const ROT_ARM    = 85
const SCALE_OX   = 70
const SCALE_OY   = 70
const HANDLE_HIT = 14

const ROT_SNAP_ANGLES: readonly number[] = Array.from({ length: 8 }, (_, i) => i * Math.PI / 4)
const ROT_SNAP_THRESHOLD = Math.PI / 12
const ROT_SNAP_DWELL_MS  = 700
const ROT_SNAP_COL = '#7ecfcf'

type DragState =
  | { type: 'move';   startMouse: Point; startPos: Point }
  | { type: 'scale';  startDist: number; startScale: number; center: Point }
  | { type: 'rotate'; startAngle: number; startRot: number; center: Point }

function ptDist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// ------------------------------------------------------------------
// TransformLayer
// ------------------------------------------------------------------

export class TransformLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _sourceSlot:   ParameterSlot
  private readonly _positionSlot: ParameterSlot
  private readonly _scaleSlot:    ParameterSlot
  private readonly _rotateSlot:   ParameterSlot
  private readonly _centreSlot:   ParameterSlot
  private readonly _opacitySlot:  ParameterSlot
  private readonly _reflectSlot:  ParameterSlot

  private _offscreen:     OffscreenCanvas
  private _reflectCanvas: OffscreenCanvas | null = null

  // Resolved each recompute
  private _position:    Point  = { x: 0, y: 0 }
  private _centrePoint: Point  = { x: 0, y: 0 }
  private _scale:       number = 1.0
  private _rotation:    number = 0

  // Manual fallbacks, set by handle drags
  private _manualPosition: Point | null = null
  private _manualScale:    number | null = null

  // Manual opacity, used while opacitySlot is unbound.
  private _opacity: number = 1   // [0, 1]
  private _opacityDrag = false

  private _reflectEnabled = false
  private _reflectBtnBounds: { x: number; y: number; width: number; height: number } | null = null
  private _reflectSlotWasActive = false

  private _drag: DragState | null = null

  private readonly _rotSnapper = new AngleSnapper(ROT_SNAP_ANGLES, ROT_SNAP_THRESHOLD, ROT_SNAP_DWELL_MS)
  private _snapSnapped  = false
  private _snapProgress = 0
  private _rotDwellTimer: ReturnType<typeof setInterval> | null = null

  // Edge snap guide lines
  private _edgeSnapX: number | null = null
  private _edgeSnapY: number | null = null

  constructor(canvasWidth = 1920, canvasHeight = 1080) {
    super()
    this._offscreen      = new OffscreenCanvas(canvasWidth, canvasHeight)
    this._position       = { x: canvasWidth / 2, y: canvasHeight / 2 }
    this._centrePoint    = { x: canvasWidth / 2, y: canvasHeight / 2 }
    this._sourceSlot     = new ParameterSlot(ValueType.Image,     this)
    this._positionSlot   = new ParameterSlot(ValueType.Point,     this)
    this._scaleSlot      = new ParameterSlot(ValueType.Amount,    this, 'scale')
    this._rotateSlot     = new ParameterSlot(ValueType.Direction, this, 'rotate')
    this._centreSlot     = new ParameterSlot(ValueType.Point,     this, 'centre')
    this._opacitySlot    = new ParameterSlot(ValueType.Amount,    this, 'opacity')
    this._reflectSlot    = new ParameterSlot(ValueType.Direction, this, 'reflect')
    // _reflectSlot is included so evaluate() calls source.evaluate() on it,
    // keeping the direction value fresh. renderSlots filters it out of the
    // standard slot-row group and draws it inside the reflect pill instead.
    this.slots.push(this._sourceSlot, this._positionSlot, this._scaleSlot,
                    this._rotateSlot, this._centreSlot, this._opacitySlot, this._reflectSlot)
    this.debugName = 'TransformLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue {
    return (this._reflectEnabled && this._reflectCanvas !== null)
      ? this._reflectCanvas
      : this._offscreen
  }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get sourceSlot():   ParameterSlot { return this._sourceSlot   }
  get positionSlot(): ParameterSlot { return this._positionSlot }
  get scaleSlot():    ParameterSlot { return this._scaleSlot    }
  get rotateSlot():   ParameterSlot { return this._rotateSlot   }
  get centreSlot():   ParameterSlot { return this._centreSlot   }
  get opacitySlot():  ParameterSlot { return this._opacitySlot  }
  get reflectSlot():  ParameterSlot { return this._reflectSlot  }

  // Touching the slider while opacitySlot is bound suspends the binding
  // and hands manual control to the user (suspend-on-touch convention).
  setOpacity(v: number): void {
    if (this._opacitySlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this._opacitySlot)?.toggle()
    }
    this._opacity = Math.max(0, Math.min(1, v))
    this.markDirty()
  }

  // Seed a newly-created layer (via slot-click-to-create) with the value
  // currently shown by the corresponding manual control, so the binding
  // starts as a no-op.
  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | null {
    if (slot === this._positionSlot) return this._manualPosition ?? this._position
    if (slot === this._scaleSlot) {
      const scale = this._manualScale ?? this._scale
      return Math.max(0, Math.min(1, (scale - MIN_SCALE) / (MAX_SCALE - MIN_SCALE)))
    }
    if (slot === this._rotateSlot)  return { angle: this._rotation, magnitude: 1 }
    if (slot === this._centreSlot)  return { ...this._centrePoint }
    if (slot === this._opacitySlot) return this._opacity
    if (slot === this._reflectSlot) return { angle: 0, magnitude: 1 }
    return null
  }

  // On creation, bind the source slot to the nearest Image-producing layer
  // below and send it to the Background collection — "wire up whatever's
  // already there" convenience, same pattern as TileLayer/ClipLayer.
  override autoBindRules(): ReturnType<Layer['autoBindRules']> {
    return [
      { slot: this._sourceSlot, accepts: (l: Layer) => l.types.has(ValueType.Image), sendToBackgroundAfterBind: true },
    ]
  }

  // ----------------------------------------------------------
  // Resize
  // ----------------------------------------------------------

  resize(w: number, h: number): void {
    this._offscreen = new OffscreenCanvas(w, h)
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      manualPosition: this._manualPosition,
      manualScale:    this._manualScale,
      rotation:       this._rotation,
      opacity:        this._opacity,
      reflectEnabled: this._reflectEnabled,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (state.manualPosition && typeof state.manualPosition === 'object') {
      this._manualPosition = state.manualPosition as Point
    }
    if (typeof state.manualScale    === 'number')  this._manualScale    = state.manualScale
    if (typeof state.rotation       === 'number')  this._rotation       = state.rotation
    if (typeof state.opacity        === 'number')  this._opacity        = state.opacity
    if (typeof state.reflectEnabled === 'boolean') this._reflectEnabled = state.reflectEnabled
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    const w = this._offscreen.width
    const h = this._offscreen.height

    const src: ImageValue = this._sourceSlot.isActive
      ? (this._sourceSlot.source as ImageSource).getImage()
      : null

    this._position = this._positionSlot.isActive
      ? (this._positionSlot.source as PointSource).getPoint()
      : this._manualPosition ?? { x: w / 2, y: h / 2 }

    if (this._scaleSlot.isActive) {
      const t = (this._scaleSlot.source as AmountSource).getAmount() as Amount
      this._scale = MIN_SCALE + t * (MAX_SCALE - MIN_SCALE)
    } else {
      this._scale = this._manualScale ?? 1.0
    }

    if (this._rotateSlot.isActive) {
      const dir: Direction = (this._rotateSlot.source as DirectionSource).getDirection()
      this._rotation = dir.angle
    }

    this._centrePoint = this._centreSlot.isActive
      ? (this._centreSlot.source as PointSource).getPoint()
      : this._position

    const opacity: number = this._opacitySlot.isActive
      ? (this._opacitySlot.source as AmountSource).getAmount() as Amount
      : this._opacity

    const ctx = this._offscreen.getContext('2d')! as unknown as CanvasRenderingContext2D
    ctx.clearRect(0, 0, w, h)

    if (src != null) {
      const sw = src instanceof OffscreenCanvas ? src.width  : (src as ImageBitmap).width
      const sh = src instanceof OffscreenCanvas ? src.height : (src as ImageBitmap).height

      ctx.save()
      ctx.globalAlpha = Math.max(0, Math.min(1, opacity))
      // Rotate about centrePoint, then translate to position.
      // When centrePoint === position this reduces to the previous transform.
      ctx.translate(this._centrePoint.x, this._centrePoint.y)
      ctx.rotate(this._rotation)
      ctx.translate(-this._centrePoint.x + this._position.x, -this._centrePoint.y + this._position.y)
      ctx.scale(this._scale, this._scale)
      ctx.drawImage(src as CanvasImageSource, -sw / 2, -sh / 2, sw, sh)
      ctx.restore()
    }

    // Auto-enable reflect when the axis slot is first bound.
    if (this._reflectSlot.isActive && !this._reflectSlotWasActive) {
      this._reflectEnabled = true
    }
    this._reflectSlotWasActive = this._reflectSlot.isActive

    if (this._reflectEnabled) {
      if (!this._reflectCanvas || this._reflectCanvas.width !== w || this._reflectCanvas.height !== h) {
        this._reflectCanvas = new OffscreenCanvas(w, h)
      }
      // Axis of reflection is perpendicular to the direction.
      // dirAngle=0 (pointing right) → axisAngle=π/2 (vertical) → left-right flip.
      const dirAngle = this._reflectSlot.isActive
        ? (this._reflectSlot.source as DirectionSource).getDirection().angle
        : 0
      const axisAngle = dirAngle + Math.PI / 2
      const cx = w / 2
      const cy = h / 2
      const rctx = this._reflectCanvas.getContext('2d')! as unknown as CanvasRenderingContext2D
      rctx.clearRect(0, 0, w, h)
      rctx.save()
      rctx.translate(cx, cy)
      rctx.rotate(axisAngle)
      rctx.scale(1, -1)
      rctx.rotate(-axisAngle)
      rctx.translate(-cx, -cy)
      rctx.drawImage(this._offscreen as CanvasImageSource, 0, 0)
      rctx.restore()
    }
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point): this | null {
    if (boundingBoxContains(this.canvasBounds, point)) return this
    if (boundingBoxContains(this._opacityPillBounds(), point)) return this
    if (boundingBoxContains(this._reflectPillBounds(), point)) return this
    if (this._drag !== null || this._opacityDrag) return this
    const hp = this._handlePos()
    if (ptDist(point, hp.move)   <= HANDLE_HIT) return this
    if (ptDist(point, hp.scale)  <= HANDLE_HIT) return this
    if (ptDist(point, hp.rotate) <= HANDLE_HIT) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    if (this._reflectBtnBounds !== null && boundingBoxContains(this._reflectBtnBounds, point)) {
      const turningOff = this._reflectEnabled
      this._reflectEnabled = !this._reflectEnabled
      if (turningOff && this._reflectSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._reflectSlot)?.toggle()
      }
      this.markDirty()
      return true
    }

    const og = this._opacitySliderGeom()
    if (point.x >= og.sld0 - 6 && point.x <= og.sldR + 6 &&
        point.y >= og.b.y    && point.y <= og.b.y + og.b.height) {
      this._opacityDrag = true
      this._setOpacityFromPointer(point.x)
      return true
    }

    const hp = this._handlePos()

    if (ptDist(point, hp.rotate) <= HANDLE_HIT) {
      if (this._rotateSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._rotateSlot)?.toggle()
      }
      if (this._centreSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._centreSlot)?.toggle()
      }
      this._rotSnapper.reset()
      this._drag = {
        type:       'rotate',
        center:     { ...this._centrePoint },
        startAngle: Math.atan2(point.y - this._centrePoint.y, point.x - this._centrePoint.x),
        startRot:   this._rotation,
      }
      return true
    }

    if (ptDist(point, hp.scale) <= HANDLE_HIT) {
      if (this._scaleSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._scaleSlot)?.toggle()
      }
      this._manualScale = this._scale
      this._drag = {
        type:       'scale',
        center:     { ...this._position },
        startDist:  Math.max(1, ptDist(point, this._position)),
        startScale: this._scale,
      }
      return true
    }

    if (ptDist(point, hp.move) <= HANDLE_HIT) {
      if (this._positionSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._positionSlot)?.toggle()
      }
      this._manualPosition = { ...this._position }
      this._drag = {
        type:       'move',
        startMouse: { ...point },
        startPos:   { ...this._position },
      }
      return true
    }

    return false
  }

  handlePointerMove(point: Point): void {
    if (this._opacityDrag) {
      this._setOpacityFromPointer(point.x)
      return
    }
    if (this._drag === null) return

    if (this._drag.type === 'move') {
      const rawPos = {
        x: this._drag.startPos.x + point.x - this._drag.startMouse.x,
        y: this._drag.startPos.y + point.y - this._drag.startMouse.y,
      }
      const edges = collectSnapEdges(this, 3)
      if (edges.xs.length > 0 || edges.ys.length > 0) {
        const b = this._transformedSnapBounds(rawPos)
        const offsetsX = b ? [b.cx - rawPos.x - b.extX, b.cx - rawPos.x, b.cx - rawPos.x + b.extX] : [0]
        const offsetsY = b ? [b.cy - rawPos.y - b.extY, b.cy - rawPos.y, b.cy - rawPos.y + b.extY] : [0]
        const snapped = snapPointToEdges(rawPos, edges, EDGE_SNAP_THRESHOLD, offsetsX, offsetsY)
        this._manualPosition = { x: snapped.x, y: snapped.y }
        this._edgeSnapX = snapped.snapLineX; this._edgeSnapY = snapped.snapLineY
      } else {
        this._manualPosition = rawPos
        this._edgeSnapX = null; this._edgeSnapY = null
      }
    } else if (this._drag.type === 'scale') {
      const d = Math.max(1, ptDist(point, this._drag.center))
      const s = this._drag.startScale * (d / this._drag.startDist)
      this._manualScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s))
    } else {
      const angle  = Math.atan2(point.y - this._drag.center.y, point.x - this._drag.center.x)
      const rawRot = this._drag.startRot + (angle - this._drag.startAngle)
      this._applySnapRotation(rawRot)
    }
    this.markDirty()
  }

  handlePointerUp(): void {
    this._opacityDrag = false
    this._drag = null
    this._clearRotDwellTimer()
    this._edgeSnapX = null; this._edgeSnapY = null
  }

  private _applySnapRotation(raw: number): void {
    const result = this._rotSnapper.update(raw)
    this._rotation     = result.angle
    this._snapSnapped  = result.snapped
    this._snapProgress = result.progress
    if (result.snapped && this._rotDwellTimer === null) {
      this._rotDwellTimer = setInterval(() => {
        const r = this._rotSnapper.update(this._rotation)
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

  private _setOpacityFromPointer(px: number): void {
    const g      = this._opacitySliderGeom()
    const thumbR = 5
    const lo     = g.sld0 + thumbR
    const hi     = g.sldR - thumbR
    const range  = Math.max(1e-6, hi - lo)
    this.setOpacity((px - lo) / range)
  }

  // ----------------------------------------------------------
  // Handle helpers
  // ----------------------------------------------------------

  private _handlePos() {
    const { x: px, y: py } = this._position
    const cos = Math.cos(this._rotation)
    const sin = Math.sin(this._rotation)
    return {
      move: { x: px, y: py },
      scale: {
        x: px + SCALE_OX * cos - SCALE_OY * sin,
        y: py + SCALE_OX * sin + SCALE_OY * cos,
      },
      rotate: {
        x: px + ROT_ARM * sin,
        y: py - ROT_ARM * cos,
      },
    }
  }

  private _renderHandles(ctx: Ctx2D): void {
    const hp = this._handlePos()

    ctx.save()
    ctx.setLineDash([])

    ctx.strokeStyle = 'rgba(255,255,255,0.38)'
    ctx.lineWidth   = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(hp.move.x, hp.move.y)
    ctx.lineTo(hp.rotate.x, hp.rotate.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(hp.move.x, hp.move.y)
    ctx.lineTo(hp.scale.x, hp.scale.y)
    ctx.stroke()
    ctx.setLineDash([])

    this._drawGlowSquare(ctx, hp.scale, HANDLE_SZ,
      this._scaleSlot.isActive ? '#666688' : '#81d4fa')

    const rotCol = this._rotateSlot.isActive ? '#666688'
                 : this._snapSnapped         ? ROT_SNAP_COL
                 : '#ffb74d'
    this._drawGlowCircle(ctx, hp.rotate, HANDLE_R, rotCol)
    if (this._snapSnapped && this._snapProgress > 0) {
      const arcR  = HANDLE_R + 5
      const start = -Math.PI / 2
      const end   = start + this._snapProgress * 2 * Math.PI
      ctx.save()
      ctx.strokeStyle = ROT_SNAP_COL
      ctx.lineWidth   = 2
      ctx.globalAlpha = 0.85
      ctx.beginPath()
      ctx.arc(hp.rotate.x, hp.rotate.y, arcR, start, end)
      ctx.stroke()
      ctx.restore()
    }

    this._drawGlowCircle(ctx, hp.move, HANDLE_R,
      this._positionSlot.isActive ? '#666688' : '#ffffff')
    const cr = HANDLE_R - 2
    ctx.strokeStyle = 'rgba(0,0,0,0.80)'
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.moveTo(hp.move.x - cr, hp.move.y)
    ctx.lineTo(hp.move.x + cr, hp.move.y)
    ctx.moveTo(hp.move.x, hp.move.y - cr)
    ctx.lineTo(hp.move.x, hp.move.y + cr)
    ctx.stroke()

    ctx.restore()
  }

  private _drawGlowCircle(ctx: Ctx2D, pt: Point, r: number, glowColour: string): void {
    ctx.save()
    ctx.shadowColor = glowColour
    ctx.shadowBlur  = 14
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,255,255,0.95)'
    ctx.fill()
    ctx.restore()
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(0,0,0,0.65)'
    ctx.lineWidth   = 1.5
    ctx.stroke()
  }

  private _drawGlowSquare(ctx: Ctx2D, pt: Point, s: number, glowColour: string): void {
    ctx.save()
    ctx.shadowColor = glowColour
    ctx.shadowBlur  = 14
    ctx.fillStyle   = 'rgba(255,255,255,0.95)'
    ctx.fillRect(pt.x - s, pt.y - s, s * 2, s * 2)
    ctx.restore()
    ctx.strokeStyle = 'rgba(0,0,0,0.65)'
    ctx.lineWidth   = 1.5
    ctx.strokeRect(pt.x - s, pt.y - s, s * 2, s * 2)
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    const img = this.getImage()
    if (img === null) return
    ctx.save()
    ctx.drawImage(img as CanvasImageSource, 0, 0)
    ctx.restore()
  }

  // ── Stack panel ─────────────────────────────────────────────

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds
    if (width <= 0 || height <= 0) return

    const midY = y + height / 2

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    const angleDeg = Math.round(this._rotation * 180 / Math.PI)

    // Transform readout
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    const readout = `∠ ${angleDeg}°  × ${this._scale.toFixed(2)}  (${Math.round(this._position.x)}, ${Math.round(this._position.y)})`
    ctx.fillText(readout, x + 12, midY)

    // Slot indicators (right side)
    const slots = [
      { slot: this._sourceSlot,   label: 'src' },
      { slot: this._positionSlot, label: 'pos' },
      { slot: this._scaleSlot,    label: 'sc'  },
      { slot: this._rotateSlot,   label: 'rot' },
      { slot: this._centreSlot,   label: 'ctr' },
      { slot: this._opacitySlot,  label: 'op'  },
    ]
    let dx = x + width - 6
    ctx.font = '9px monospace'
    for (let i = slots.length - 1; i >= 0; i--) {
      const entry = slots[i]; if (!entry) continue
      const { slot, label } = entry
      const active = slot.isActive
      ctx.fillStyle    = active ? ACCENT : 'rgba(255,255,255,0.22)'
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(active ? '●' : '○', dx, midY)
      dx -= 12
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText(label, dx, midY)
      dx -= ctx.measureText(label).width + 6
    }

    ctx.restore()
  }

  // Compute the canvas-space AABB of the transformed source content.
  // Returns null when there is no source or no source snap bounds to work from.
  private _transformedSnapBounds(pos: Point): { cx: number; cy: number; extX: number; extY: number } | null {
    if (!this._sourceSlot.isActive) return null
    const src = this._sourceSlot.source
    const srcBounds = (src instanceof Layer) ? src.getSnapBounds() : null

    let srcCX: number, srcCY: number, halfSW: number, halfSH: number
    if (srcBounds !== null) {
      srcCX  = (srcBounds.minX + srcBounds.maxX) / 2
      srcCY  = (srcBounds.minY + srcBounds.maxY) / 2
      halfSW = (srcBounds.maxX - srcBounds.minX) / 2
      halfSH = (srcBounds.maxY - srcBounds.minY) / 2
    } else {
      // Source fills the canvas (e.g. FillLayer, NoiseLayer)
      srcCX  = Node.canvasWidth  / 2
      srcCY  = Node.canvasHeight / 2
      halfSW = Node.canvasWidth  / 2
      halfSH = Node.canvasHeight / 2
    }

    // The drawImage call is ctx.drawImage(src, -sw/2, -sh/2, sw, sh),
    // centering the source at the origin. A source pixel at (srcCX, srcCY)
    // is offset (srcCX - cw/2, srcCY - ch/2) from that origin. Apply scale,
    // then the translate/rotate of the TransformLayer (assuming centrePoint ≈ pos).
    const s    = this._scale
    const cosR = Math.cos(this._rotation), sinR = Math.sin(this._rotation)
    const cx   = this._centrePoint.x, cy = this._centrePoint.y

    const pu = (srcCX - Node.canvasWidth  / 2) * s + (pos.x - cx)
    const pv = (srcCY - Node.canvasHeight / 2) * s + (pos.y - cy)

    return {
      cx:   pu * cosR - pv * sinR + cx,
      cy:   pu * sinR + pv * cosR + cy,
      extX: Math.abs(halfSW * s * cosR) + Math.abs(halfSH * s * sinR),
      extY: Math.abs(halfSW * s * sinR) + Math.abs(halfSH * s * cosR),
    }
  }

  override getSnapBounds(): { minX: number; maxX: number; minY: number; maxY: number } | null {
    const b = this._transformedSnapBounds(this._position)
    if (b === null) return null
    return { minX: b.cx - b.extX, maxX: b.cx + b.extX, minY: b.cy - b.extY, maxY: b.cy + b.extY }
  }

  override renderOverlay(ctx: Ctx2D): void {
    this._renderHandles(ctx)
    drawSnapGuides(ctx, this._edgeSnapX, this._edgeSnapY, Node.canvasWidth, Node.canvasHeight)
  }

  // Standard slot-row pill, then an opacity slider pill, then a reflect pill.
  // _reflectSlot is kept in this.slots for evaluation ordering but drawn
  // inside the reflect pill, so it is filtered out of the standard group.
  override renderSlots(ctx: Ctx2D): void {
    if (this.slots.length === 0) return
    this._slotBounds.clear()
    const standardSlots = this.slots.filter(s => s !== this._reflectSlot)
    this.renderSlotGroup(ctx, standardSlots, this.panelBottom)
    this._drawOpacityPill(ctx)
    this._drawReflectPill(ctx)
  }

  private _drawOpacityPill(ctx: Ctx2D): void {
    const g = this._opacitySliderGeom()
    const { x, y, width, height } = g.b

    const active = this._opacitySlot.isActive
    const value  = active
      ? (this._opacitySlot.source as AmountSource).getAmount() as Amount
      : this._opacity
    const colour = active ? AM_COL : ACCENT

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = colour
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // Label
    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.50)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('opacity', g.labelX, g.midY)

    // Slider
    this._drawSlider(ctx, g.midY, g.sld0, g.sldR, value, colour)

    // Value text
    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.textAlign = 'right'
    ctx.fillText(value.toFixed(2), g.valueRight, g.midY)

    // Bind indicator
    ctx.font      = '9px monospace'
    ctx.fillStyle = active ? AM_COL : 'rgba(255,255,255,0.22)'
    ctx.textAlign = 'right'
    ctx.fillText(active ? '●' : '○', g.indX, g.midY)

    ctx.restore()
  }

  // Track + filled portion + thumb, FilterLayer/NoiseLayer slider style.
  private _drawSlider(ctx: Ctx2D, midY: number, x0: number, x1: number, v: number, colour: string): void {
    const thumbR = 5
    const lo     = x0 + thumbR
    const hi     = x1 - thumbR
    const range  = Math.max(0, hi - lo)
    const thumbX = lo + Math.max(0, Math.min(1, v)) * range

    ctx.lineCap = 'round'

    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth   = 3
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

  // Opacity pill — directly below the standard slot-row pill.
  private _opacityPillBounds() {
    const groupH = this.slots.length * (SLOT_H + SLOT_GAP) - SLOT_GAP
    const y = this.panelBottom + groupH + PILL_GAP
    return { x: contentLeft(Node.canvasWidth), y, width: panelWidth(Node.canvasWidth), height: OPACITY_H }
  }

  private _opacitySliderGeom() {
    const b      = this._opacityPillBounds()
    const midY   = b.y + b.height / 2
    const labelX = b.x + 12
    const indX   = b.x + b.width - 8
    const valueRight = indX - 14
    const sld0   = labelX + OP_LABEL_W
    const sldR   = valueRight - OP_VALUE_W - 6
    return { b, midY, labelX, sld0, sldR, valueRight, indX }
  }

  // Reflect pill — directly below the opacity pill.
  private _reflectPillBounds() {
    const op = this._opacityPillBounds()
    return { x: op.x, y: op.y + OPACITY_H + PILL_GAP, width: op.width, height: REFLECT_H }
  }

  private _drawReflectPill(ctx: Ctx2D): void {
    const b      = this._reflectPillBounds()
    const active = this._reflectSlot.isActive

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 8)
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = active ? DIR_COL : ACCENT
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, 4, b.height, [4, 0, 0, 4])
    ctx.fill()

    // ── Toggle row ────────────────────────────────────────────
    const toggleMidY = b.y + REFLECT_TOGGLE_H / 2

    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.50)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('reflect', b.x + 12, toggleMidY)

    const btnW = 22
    const btnH = REFLECT_TOGGLE_H - 10
    const btnX = b.x + b.width - 8 - btnW
    const btnY = toggleMidY - btnH / 2
    this._reflectBtnBounds = { x: btnX, y: btnY, width: btnW, height: btnH }

    ctx.strokeStyle = this._reflectEnabled ? DIR_COL : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.roundRect(btnX, btnY, btnW, btnH, 3)
    ctx.stroke()

    ctx.font      = '11px monospace'
    ctx.fillStyle = this._reflectEnabled ? DIR_COL : 'rgba(255,255,255,0.40)'
    ctx.textAlign = 'center'
    ctx.fillText('↔', btnX + btnW / 2, toggleMidY)

    // ── Axis slot row ─────────────────────────────────────────
    const slotY   = b.y + REFLECT_TOGGLE_H + REFLECT_SLOT_GAP
    const slotMidY = slotY + REFLECT_SLOT_H / 2
    const LABEL_W  = 78
    const vx       = b.x + LABEL_W
    const vw       = b.width - LABEL_W - 2
    const by       = slotY + 3
    const bh       = REFLECT_SLOT_H - 6
    const drag     = Node.bindDrag
    const isCompat = drag.active && drag.source !== null &&
                     drag.source.types.has(ValueType.Direction)

    const slotBounds = { x: b.x, y: slotY, width: b.width, height: REFLECT_SLOT_H }
    this._slotBounds.set(this._reflectSlot, slotBounds)

    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.62)'
    ctx.textAlign = 'left'
    ctx.fillText('axis', b.x + 6, slotMidY)

    if (active && !isCompat) {
      const srcName = (this._reflectSlot.source as { debugName?: string } | null)?.debugName ?? '?'
      ctx.fillStyle = DIR_COL + '22'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = DIR_COL + 'cc'; ctx.lineWidth = 1; ctx.setLineDash([])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.textAlign = 'left'
      ctx.fillText(srcName, vx + 6, slotMidY)
    } else if (isCompat) {
      ctx.fillStyle = 'rgba(50,200,70,0.18)'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = 'rgba(50,200,70,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.fillStyle = 'rgba(100,255,120,0.75)'; ctx.textAlign = 'left'
      ctx.fillText(active ? 'replace binding' : 'drop to bind', vx + 6, slotMidY)
    } else if (this._reflectSlot.state === SlotState.SuspendedBound) {
      const srcName = (this._reflectSlot.source as { debugName?: string } | null)?.debugName ?? '?'
      ctx.fillStyle = DIR_COL + '11'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.40)'; ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.60)'; ctx.textAlign = 'left'
      ctx.fillText('⏸ ' + srcName, vx + 6, slotMidY)
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.textAlign = 'left'
      ctx.fillText('unbound', vx + 6, slotMidY)
    }

    ctx.restore()
  }
}
