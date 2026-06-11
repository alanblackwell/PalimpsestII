import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type Amount,     type AmountSource,
  type ImageValue, type ImageSource,
  type MaskSource,
  type Point,      type PointSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// ClipLayer — clip an image to a mask region, with transform handles
// ------------------------------------------------------------
//
// Inputs:
//   imageSlot    (Image)  — content to clip
//   maskSlot     (Mask)   — defines the kept region
//   positionSlot (Point)  — centre of the rendered output in canvas space
//                           Unbound default: canvas centre
//   scaleSlot    (Amount) — [0,1] → [MIN_SCALE, MAX_SCALE]
//                           Unbound default: 1.0
//
// The clipped content (what pixels are included) is always determined
// by the mask and source image in their original canvas positions.
// Only the rendered output changes when position / scale / rotation are
// adjusted — the offscreen is drawn with a canvas-centred pivot, then
// translated, scaled, and rotated to the target location.

const ACCENT     = '#7ecf7e'
const MIN_SCALE  = 0.05
const MAX_SCALE  = 4.0

// Handle geometry (matches ImageLayer)
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

export class ClipLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _imageSlot:    ParameterSlot
  private readonly _maskSlot:     ParameterSlot
  private readonly _positionSlot: ParameterSlot
  private readonly _scaleSlot:    ParameterSlot

  private _offscreen: OffscreenCanvas

  // Transform state
  private _rotation:       number       = 0
  private _manualPosition: Point | null = null
  private _manualScale:    number | null = null
  private _drag:           DragState | null = null

  // Resolved each recompute
  private _position: Point  = { x: 0, y: 0 }
  private _scale:    number = 1.0

  constructor() {
    super()
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    this._offscreen  = new OffscreenCanvas(w, h)
    this._position   = { x: w / 2, y: h / 2 }

    this._imageSlot    = new ParameterSlot(ValueType.Image,  this, 'image')
    this._maskSlot     = new ParameterSlot(ValueType.Mask,   this, 'mask')
    this._positionSlot = new ParameterSlot(ValueType.Point,  this, 'position')
    this._scaleSlot    = new ParameterSlot(ValueType.Amount, this, 'scale')

    this.slots.push(this._imageSlot, this._maskSlot, this._positionSlot, this._scaleSlot)
    this.debugName = 'ClipLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue {
    // Return the raw clipped offscreen (pre-transform), so downstream
    // consumers see the content at its source position.
    return this._offscreen
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    if (this._offscreen.width !== w || this._offscreen.height !== h) {
      this._offscreen = new OffscreenCanvas(w, h)
    }

    const ctx = this._offscreen.getContext('2d')!
    ctx.clearRect(0, 0, w, h)

    if (this._imageSlot.isActive) {
      const image = (this._imageSlot.source as ImageSource).getImage()
      if (image !== null) {
        ctx.globalCompositeOperation = 'source-over'
        ctx.drawImage(image as CanvasImageSource, 0, 0, w, h)

        if (this._maskSlot.isActive) {
          const mask = (this._maskSlot.source as MaskSource).getMask()
          if (mask !== null) {
            ctx.globalCompositeOperation = 'destination-in'
            ctx.drawImage(mask as CanvasImageSource, 0, 0, w, h)
            ctx.globalCompositeOperation = 'source-over'
          }
        }
      }
    }

    // Resolve transform parameters
    this._position = this._positionSlot.isActive
      ? (this._positionSlot.source as PointSource).getPoint()
      : this._manualPosition ?? { x: w / 2, y: h / 2 }

    if (this._scaleSlot.isActive) {
      const t = (this._scaleSlot.source as AmountSource).getAmount() as Amount
      this._scale = MIN_SCALE + t * (MAX_SCALE - MIN_SCALE)
    } else {
      this._scale = this._manualScale ?? 1.0
    }
  }

  override autoBindRules() {
    return [
      { slot: this._imageSlot, accepts: (l: Layer) => l.types.has(ValueType.Image), removeAfterBind: true },
      { slot: this._maskSlot,  accepts: (l: Layer) => l.types.has(ValueType.Mask),  removeAfterBind: true },
    ]
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    ctx.save()
    ctx.translate(this._position.x, this._position.y)
    ctx.rotate(this._rotation)
    ctx.scale(this._scale, this._scale)
    // Draw the full-canvas offscreen with its centre aligned to _position.
    ctx.drawImage(this._offscreen as CanvasImageSource, -w / 2, -h / 2, w, h)
    ctx.restore()

    this._renderHandles(ctx)
  }

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.bounds
    if (width <= 0 || height <= 0) return
    const midY = y + height / 2

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
    ctx.fillText('Clip', x + 12, midY)

    const slots = [
      { slot: this._imageSlot,    label: 'img'  },
      { slot: this._maskSlot,     label: 'mask' },
      { slot: this._positionSlot, label: 'pos'  },
      { slot: this._scaleSlot,    label: 'sc'   },
    ]
    let dx = x + width - 8
    ctx.font = '9px monospace'
    for (let i = slots.length - 1; i >= 0; i--) {
      const { slot, label } = slots[i]!
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

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point): this | null {
    if (boundingBoxContains(this.bounds, point)) return this
    if (this._drag !== null) return this
    const hp = this._handlePos()
    if (ptDist(point, hp.move)   <= HANDLE_HIT) return this
    if (ptDist(point, hp.scale)  <= HANDLE_HIT) return this
    if (ptDist(point, hp.rotate) <= HANDLE_HIT) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    const hp = this._handlePos()

    if (ptDist(point, hp.rotate) <= HANDLE_HIT) {
      this._drag = {
        type:       'rotate',
        center:     { ...this._position },
        startAngle: Math.atan2(point.y - this._position.y, point.x - this._position.x),
        startRot:   this._rotation,
      }
      return true
    }

    if (!this._scaleSlot.isActive && ptDist(point, hp.scale) <= HANDLE_HIT) {
      this._drag = {
        type:       'scale',
        center:     { ...this._position },
        startDist:  Math.max(1, ptDist(point, this._position)),
        startScale: this._scale,
      }
      return true
    }

    if (!this._positionSlot.isActive && ptDist(point, hp.move) <= HANDLE_HIT) {
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
    this._drag = null
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

    this._drawGlowCircle(ctx, hp.rotate, HANDLE_R, '#ffb74d')

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
}
