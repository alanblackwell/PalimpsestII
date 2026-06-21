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

const MIN_SCALE = 0.05
const MAX_SCALE = 4.0

// Opacity slider pill, drawn directly below the standard slot-row pill.
// Mirrors the constants used by Layer.renderSlotGroup, so its position can
// be computed without re-rendering.
const SLOT_H    = 26
const SLOT_GAP  = 4
const PILL_GAP  = 8    // vertical gap between the slot pill and the opacity pill
const OPACITY_H = 36
const OP_LABEL_W = 50
const OP_VALUE_W = 40

// Handle geometry (matches ImageLayer/ClipLayer)
const HANDLE_R   = 7
const HANDLE_SZ  = 6
const ROT_ARM    = 85
const SCALE_OX   = 70
const SCALE_OY   = 70
const HANDLE_HIT = 14

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

  private readonly _sourceSlot:    ParameterSlot
  private readonly _positionSlot:  ParameterSlot
  private readonly _scaleSlot:     ParameterSlot
  private readonly _directionSlot: ParameterSlot
  private readonly _opacitySlot:   ParameterSlot

  private _offscreen: OffscreenCanvas

  // Resolved each recompute
  private _position: Point  = { x: 0, y: 0 }
  private _scale:    number = 1.0
  private _rotation: number = 0

  // Manual fallbacks, set by handle drags
  private _manualPosition: Point | null = null
  private _manualScale:    number | null = null

  // Manual opacity, used while opacitySlot is unbound.
  private _opacity: number = 1   // [0, 1]
  private _opacityDrag = false

  private _drag: DragState | null = null

  constructor(canvasWidth = 1920, canvasHeight = 1080) {
    super()
    this._offscreen      = new OffscreenCanvas(canvasWidth, canvasHeight)
    this._position       = { x: canvasWidth / 2, y: canvasHeight / 2 }
    this._sourceSlot     = new ParameterSlot(ValueType.Image,     this)
    this._positionSlot   = new ParameterSlot(ValueType.Point,     this)
    this._scaleSlot      = new ParameterSlot(ValueType.Amount,    this, 'scale')
    this._directionSlot  = new ParameterSlot(ValueType.Direction, this)
    this._opacitySlot    = new ParameterSlot(ValueType.Amount,    this, 'opacity')
    this.slots.push(this._sourceSlot, this._positionSlot, this._scaleSlot,
                    this._directionSlot, this._opacitySlot)
    this.debugName = 'TransformLayer'
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
  get positionSlot():  ParameterSlot { return this._positionSlot  }
  get scaleSlot():     ParameterSlot { return this._scaleSlot     }
  get directionSlot(): ParameterSlot { return this._directionSlot }
  get opacitySlot():   ParameterSlot { return this._opacitySlot   }

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
    if (slot === this._positionSlot)  return this._manualPosition ?? this._position
    if (slot === this._scaleSlot) {
      const scale = this._manualScale ?? this._scale
      return Math.max(0, Math.min(1, (scale - MIN_SCALE) / (MAX_SCALE - MIN_SCALE)))
    }
    if (slot === this._directionSlot) return { angle: this._rotation, magnitude: 1 }
    if (slot === this._opacitySlot)   return this._opacity
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
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (state.manualPosition && typeof state.manualPosition === 'object') {
      this._manualPosition = state.manualPosition as Point
    }
    if (typeof state.manualScale === 'number') this._manualScale = state.manualScale
    if (typeof state.rotation === 'number')    this._rotation    = state.rotation
    if (typeof state.opacity === 'number')     this._opacity     = state.opacity
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

    if (this._directionSlot.isActive) {
      const dir: Direction = (this._directionSlot.source as DirectionSource).getDirection()
      this._rotation = dir.angle
    }

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
      ctx.translate(this._position.x, this._position.y)
      ctx.rotate(this._rotation)
      ctx.scale(this._scale, this._scale)
      ctx.drawImage(src as CanvasImageSource, -sw / 2, -sh / 2, sw, sh)
      ctx.restore()
    }
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point): this | null {
    if (boundingBoxContains(this.canvasBounds, point)) return this
    if (boundingBoxContains(this._opacityPillBounds(), point)) return this
    if (this._drag !== null || this._opacityDrag) return this
    const hp = this._handlePos()
    if (ptDist(point, hp.move)   <= HANDLE_HIT) return this
    if (ptDist(point, hp.scale)  <= HANDLE_HIT) return this
    if (ptDist(point, hp.rotate) <= HANDLE_HIT) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    const og = this._opacitySliderGeom()
    if (point.x >= og.sld0 - 6 && point.x <= og.sldR + 6 &&
        point.y >= og.b.y    && point.y <= og.b.y + og.b.height) {
      this._opacityDrag = true
      this._setOpacityFromPointer(point.x)
      return true
    }

    const hp = this._handlePos()

    if (ptDist(point, hp.rotate) <= HANDLE_HIT) {
      if (this._directionSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._directionSlot)?.toggle()
      }
      this._drag = {
        type:       'rotate',
        center:     { ...this._position },
        startAngle: Math.atan2(point.y - this._position.y, point.x - this._position.x),
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
      this._manualPosition = {
        x: this._drag.startPos.x + point.x - this._drag.startMouse.x,
        y: this._drag.startPos.y + point.y - this._drag.startMouse.y,
      }
    } else if (this._drag.type === 'scale') {
      const d = Math.max(1, ptDist(point, this._drag.center))
      const s = this._drag.startScale * (d / this._drag.startDist)
      this._manualScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s))
    } else {
      const angle = Math.atan2(
        point.y - this._drag.center.y,
        point.x - this._drag.center.x,
      )
      this._rotation = this._drag.startRot + (angle - this._drag.startAngle)
    }
    this.markDirty()
  }

  handlePointerUp(): void {
    this._opacityDrag = false
    this._drag = null
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

    this._drawGlowCircle(ctx, hp.rotate, HANDLE_R,
      this._directionSlot.isActive ? '#666688' : '#ffb74d')

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
    ctx.save()
    ctx.drawImage(this._offscreen as CanvasImageSource, 0, 0)
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
      { slot: this._sourceSlot,    label: 'src' },
      { slot: this._positionSlot,  label: 'pos' },
      { slot: this._scaleSlot,     label: 'sc'  },
      { slot: this._directionSlot, label: 'dir' },
      { slot: this._opacitySlot,   label: 'op'  },
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

  override renderOverlay(ctx: Ctx2D): void {
    this._renderHandles(ctx)
  }

  // Standard slot-row pill, then an opacity slider pill directly below it.
  override renderSlots(ctx: Ctx2D): void {
    if (this.slots.length === 0) return
    this._slotBounds.clear()
    this.renderSlotGroup(ctx, this.slots, this.panelBottom)
    this._drawOpacityPill(ctx)
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

  // Opacity pill — directly below the standard slot-row pill. Geometry is
  // computed from the same constants as Layer.renderSlotGroup, so it can be
  // derived without re-rendering.
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
}
