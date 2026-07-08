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
import { drawIcon } from '../ui/icons.js'
import { SliderSlot } from '../ui/SliderSlot.js'

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
const SLOT_H    = 30
const SLOT_GAP  = 4
const PILL_GAP         = 8    // vertical gap between pills
const OPACITY_H        = 36
const REFLECT_TOGGLE_H = 36   // height of the toggle row inside the reflect pill
const REFLECT_SLOT_H   = 30   // height of the axis slot row inside the reflect pill
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
  private readonly _opacityWidget: SliderSlot

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
    this.displayBaseName = 'Move'
    this.debugName = 'Move'
    this._opacityWidget = new SliderSlot(
      this._opacitySlot, 'opacity', AM_COL,
      () => this._opacitySlot.isActive
        ? (this._opacitySlot.source as AmountSource).getAmount() as number
        : this._opacity,
      v => this.setOpacity(v),
      () => this.markDirty(),
    )
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
  get opacityWidget(): SliderSlot   { return this._opacityWidget }

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
    if (slot === this._positionSlot) { const hp = this._handlePos(); return { ...hp.move } }
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

    // Scale and rotation must be resolved before position: _pivotFromContentCentre
    // uses them to back-compute the canvas-transform pivot.
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

    // positionSlot and _manualPosition store the *content centre* (the visible
    // handle position). _position (the canvas-transform pivot) is back-computed
    // from that so the image actually lands at the content centre.
    const contentCentre: Point | null = this._positionSlot.isActive
      ? (this._positionSlot.source as PointSource).getPoint()
      : this._manualPosition
    this._position = contentCentre !== null
      ? this._pivotFromContentCentre(contentCentre)
      : { x: w / 2, y: h / 2 }

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
    if (this._drag !== null) return this
    // Handles take priority over pill controls
    const hp = this._handlePos()
    if (ptDist(point, hp.move)   <= HANDLE_HIT) return this
    if (ptDist(point, hp.scale)  <= HANDLE_HIT) return this
    if (ptDist(point, hp.rotate) <= HANDLE_HIT) return this
    if (boundingBoxContains(this.canvasBounds, point)) return this
    if (boundingBoxContains(this._opacityPillBounds(), point)) return this
    if (boundingBoxContains(this._reflectPillBounds(), point)) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    const hp = this._handlePos()

    // Handles take priority over pills so a handle rendered on top of a control wins
    if (ptDist(point, hp.rotate) <= HANDLE_HIT) {
      if (this._rotateSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._rotateSlot)?.toggle()
      }
      if (this._centreSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._centreSlot)?.toggle()
      }
      if (this._positionSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._positionSlot)?.toggle()
      }
      this._manualPosition = { ...hp.move }  // content centre stays fixed
      this._rotSnapper.reset()
      this._drag = {
        type:       'rotate',
        center:     { ...hp.move },
        startAngle: Math.atan2(point.y - hp.move.y, point.x - hp.move.x),
        startRot:   this._rotation,
      }
      return true
    }

    if (ptDist(point, hp.scale) <= HANDLE_HIT) {
      if (this._scaleSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._scaleSlot)?.toggle()
      }
      if (this._positionSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._positionSlot)?.toggle()
      }
      this._manualPosition = { ...hp.move }  // content centre stays fixed
      this._manualScale = this._scale
      this._drag = {
        type:       'scale',
        center:     { ...hp.move },
        startDist:  Math.max(1, ptDist(point, hp.move)),
        startScale: this._scale,
      }
      return true
    }

    if (ptDist(point, hp.move) <= HANDLE_HIT) {
      if (this._positionSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._positionSlot)?.toggle()
      }
      this._manualPosition = { ...hp.move }  // content centre
      this._drag = {
        type:       'move',
        startMouse: { ...point },
        startPos:   { ...hp.move },  // track content centre, not pivot
      }
      return true
    }

    // Pill controls — checked after handles so a handle rendered on top wins
    if (this._reflectBtnBounds !== null && boundingBoxContains(this._reflectBtnBounds, point)) {
      const turningOff = this._reflectEnabled
      this._reflectEnabled = !this._reflectEnabled
      if (turningOff && this._reflectSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._reflectSlot)?.toggle()
      }
      this.markDirty()
      return true
    }

    if (this._opacityWidget.handlePointerDown(point, this._opacityPillBounds())) return true

    return false
  }

  handlePointerMove(point: Point): void {
    this._opacityWidget.handlePointerMove(point, this._opacityPillBounds())
    if (this._drag === null) return

    if (this._drag.type === 'move') {
      const rawPos = {
        x: this._drag.startPos.x + point.x - this._drag.startMouse.x,
        y: this._drag.startPos.y + point.y - this._drag.startMouse.y,
      }
      // rawPos is content centre; derive pivot to compute actual snap bounds
      const edges = collectSnapEdges(this, 3)
      if (edges.xs.length > 0 || edges.ys.length > 0) {
        const b = this._transformedSnapBounds(this._pivotFromContentCentre(rawPos))
        const offsetsX = b ? [-b.extX, 0, b.extX] : [0]
        const offsetsY = b ? [-b.extY, 0, b.extY] : [0]
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
      // _manualPosition (content centre) stays fixed; recompute() back-computes pivot
    } else {
      const angle  = Math.atan2(point.y - this._drag.center.y, point.x - this._drag.center.x)
      const rawRot = this._drag.startRot + (angle - this._drag.startAngle)
      this._applySnapRotation(rawRot)
      // _manualPosition (content centre) stays fixed; recompute() back-computes pivot
    }
    this.markDirty()
  }

  handlePointerUp(): void {
    this._opacityWidget.handlePointerUp()
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

  // ----------------------------------------------------------
  // Handle helpers
  // ----------------------------------------------------------

  // Inverse of the content-centre forward transform: given the desired canvas
  // position of the source-content centre (cc), return the pivot (_position)
  // that achieves it under the current rotation and scale.
  // Returns cc unchanged when the source has no offset snap bounds or when
  // centreSlot is active (separate pivot semantics apply).
  private _pivotFromContentCentre(cc: Point): Point {
    if (!this._sourceSlot.isActive || this._centreSlot.isActive) return { ...cc }
    const src = this._sourceSlot.source
    if (!(src instanceof Layer)) return { ...cc }
    const srcBounds = src.getSnapBounds()
    if (srcBounds === null) return { ...cc }
    const w    = this._offscreen.width, h = this._offscreen.height
    const offX = (srcBounds.minX + srcBounds.maxX) / 2 - w / 2
    const offY = (srcBounds.minY + srcBounds.maxY) / 2 - h / 2
    const cos  = Math.cos(this._rotation), sin = Math.sin(this._rotation)
    const s    = this._scale
    return {
      x: cc.x - (offX * s * cos - offY * s * sin),
      y: cc.y - (offX * s * sin + offY * s * cos),
    }
  }

  private _handlePos() {
    const snapB = this._transformedSnapBounds(this._position)
    const { x: px, y: py } = snapB !== null
      ? { x: snapB.cx, y: snapB.cy }
      : this._position
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

  // Standard slot-row pill, then an opacity SliderSlot pill, then a reflect pill.
  // Both _reflectSlot and _opacitySlot are filtered out of the standard group:
  // _reflectSlot is drawn inside the reflect pill; _opacitySlot uses a SliderSlot.
  override renderSlots(ctx: Ctx2D): void {
    if (this.slots.length === 0) return
    this._slotBounds.clear()
    const standardSlots = this.slots.filter(s => s !== this._reflectSlot && s !== this._opacitySlot)
    this.renderSlotGroup(ctx, standardSlots, this.panelBottom)
    this._drawOpacityPill(ctx)
    this._drawReflectPill(ctx)
  }

  private _drawOpacityPill(ctx: Ctx2D): void {
    const b = this._opacityPillBounds()
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath(); ctx.roundRect(b.x, b.y, b.width, b.height, 8); ctx.fill()
    ctx.fillStyle = AM_COL
    ctx.beginPath(); ctx.roundRect(b.x, b.y, 4, b.height, [4, 0, 0, 4]); ctx.fill()
    ctx.restore()
    this._slotBounds.set(this._opacitySlot, b)
    this._opacityWidget.render(ctx, b)
  }

  // Opacity SliderSlot pill — directly below the standard slot-row pill.
  private _opacityPillBounds() {
    const n = this.slots.filter(s => s !== this._reflectSlot && s !== this._opacitySlot).length
    const groupH = n * (SLOT_H + SLOT_GAP) - SLOT_GAP
    const y = this.panelBottom + groupH + PILL_GAP
    return { x: contentLeft(Node.canvasWidth), y, width: panelWidth(Node.canvasWidth), height: OPACITY_H }
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

    ctx.fillStyle = this._reflectEnabled ? DIR_COL : 'rgba(255,255,255,0.40)'
    drawIcon(ctx, 'arrows-left-right', btnX + btnW / 2, toggleMidY, btnH - 6)

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
