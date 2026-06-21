import { Layer } from '../core/Layer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  SlotState,
  boundingBoxContains,
  type ImageValue,     type ImageSource,
  type Point,          type PointSource,
  type Amount,         type AmountSource,
  type Direction,      type DirectionSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'

// ------------------------------------------------------------
// ImageLayer — loads and renders a bitmap image on the canvas
// ------------------------------------------------------------
//
// Implements ImageSource so downstream layers can consume the
// loaded bitmap via getImage().
//
// Input slots:
//   positionSlot  (Point)  — canvas anchor (centre of image).
//                            Unbound default: canvas centre.
//   opacitySlot   (Amount) — globalAlpha [0, 1].
//                            Unbound default: 1.0.
//   scaleSlot     (Amount) — maps [0, 1] → [MIN_SCALE, MAX_SCALE].
//                            Unbound default: 1.0 (natural size).
//
// Transform handles (visible on canvas when slot is unbound):
//   ⊕  Move handle    — circle+crosshair at image centre; drag to reposition.
//   □  Scale handle   — square at lower-right; drag distance from centre to scale.
//   ○  Rotate handle  — circle above centre on a dashed arm; drag angle to rotate.
//   Handles glow brightly (shadowBlur) for visibility over any content.

const ACCENT     = '#7ecf7e'
const DIR_ACCENT = '#7ecfcf'
const MIN_SCALE  = 0.05
const MAX_SCALE  = 4.0

// Panel button geometry
const BTN   = 22
const BTN_M = 6

// Handle geometry
const HANDLE_R   = 7    // circle handle radius (px)
const HANDLE_SZ  = 6    // square handle half-size (px)
const ROT_ARM    = 85   // rotate handle arm length from centre (px)
const SCALE_OX   = 70   // scale handle offset in image-local x (px)
const SCALE_OY   = 70   // scale handle offset in image-local y (px)
const HANDLE_HIT = 14   // pointer hit-test radius (px)

type DragState =
  | { type: 'move';   startMouse: Point; startPos: Point }
  | { type: 'scale';  startDist: number; startScale: number; center: Point }
  | { type: 'rotate'; startAngle: number; startRot: number; center: Point }

function ptDist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export class ImageLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _positionSlot: ParameterSlot
  private readonly _opacitySlot:  ParameterSlot
  private readonly _scaleSlot:    ParameterSlot
  private readonly _rotationSlot: ParameterSlot

  private _bitmap:     ImageValue      = null
  private _offscreen:  OffscreenCanvas = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)
  private _filename:   string          = ''
  private _natW:       number          = 0
  private _natH:       number          = 0
  private _dragOver:   boolean         = false

  // Direct-manipulation state (persist across recompute when slot is unbound)
  private _rotation:       number       = 0
  private _manualPosition: Point | null = null
  private _manualScale:    number | null = null
  private _drag:           DragState | null = null

  // Resolved values (updated in recompute)
  private _position: Point  = { x: Node.viewportWidth / 2, y: Node.viewportHeight / 2 }
  private _opacity:  number = 1.0
  private _scale:    number = 1.0

  constructor() {
    super()
    this._positionSlot = new ParameterSlot(ValueType.Point,     this)
    this._opacitySlot  = new ParameterSlot(ValueType.Amount,    this)
    this._scaleSlot    = new ParameterSlot(ValueType.Amount,    this)
    this._rotationSlot = new ParameterSlot(ValueType.Direction, this)
    this.slots.push(this._positionSlot, this._opacitySlot, this._scaleSlot, this._rotationSlot)
    this.debugName = 'ImageLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._bitmap !== null ? this._offscreen : null }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get positionSlot(): ParameterSlot { return this._positionSlot }
  get opacitySlot():  ParameterSlot { return this._opacitySlot  }
  get scaleSlot():    ParameterSlot { return this._scaleSlot    }
  get rotationSlot(): ParameterSlot { return this._rotationSlot }

  // Seed a newly-created layer (via slot-click-to-create) with the value
  // currently shown by the corresponding manual control, so the binding
  // starts as a no-op.
  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | null {
    if (slot === this._positionSlot)  return this._manualPosition ?? this._position
    if (slot === this._opacitySlot)   return this._opacity
    if (slot === this._scaleSlot) {
      const scale = this._manualScale ?? this._scale
      return Math.max(0, Math.min(1, (scale - MIN_SCALE) / (MAX_SCALE - MIN_SCALE)))
    }
    if (slot === this._rotationSlot)  return { angle: this._rotation, magnitude: 1 }
    return null
  }

  // ----------------------------------------------------------
  // Image loading
  // ----------------------------------------------------------

  async loadFile(file: File): Promise<void> {
    try {
      const bitmap = await createImageBitmap(file)
      this._bitmap?.close()
      this._bitmap   = bitmap
      this._filename = file.name
      this._natW     = bitmap.width
      this._natH     = bitmap.height
      this.markDirty()
    } catch {
      // Unsupported format or decode error — leave previous bitmap intact.
    }
  }

  openFilePicker(): void {
    const input = document.createElement('input')
    input.type   = 'file'
    input.accept = 'image/*'
    input.style.display = 'none'
    document.body.appendChild(input)
    input.onchange = () => {
      const file = input.files?.[0]
      document.body.removeChild(input)
      if (file) this.loadFile(file)
    }
    input.click()
  }

  setDragOver(v: boolean): void {
    if (this._dragOver !== v) {
      this._dragOver = v
      this.markDirty()
    }
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    this._position = this._positionSlot.isActive
      ? (this._positionSlot.source as PointSource).getPoint()
      : this._manualPosition ?? { x: Node.viewportWidth / 2, y: Node.viewportHeight / 2 }

    this._opacity = this._opacitySlot.isActive
      ? (this._opacitySlot.source as AmountSource).getAmount() as Amount
      : 1.0

    if (this._scaleSlot.isActive) {
      const t = (this._scaleSlot.source as AmountSource).getAmount() as Amount
      this._scale = MIN_SCALE + t * (MAX_SCALE - MIN_SCALE)
    } else {
      this._scale = this._manualScale ?? 1.0
    }

    if (this._rotationSlot.isActive) {
      this._rotation = (this._rotationSlot.source as DirectionSource).getDirection().angle
    }

    this._updateOffscreen()
  }

  private _updateOffscreen(): void {
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    if (this._offscreen.width !== w || this._offscreen.height !== h) {
      this._offscreen = new OffscreenCanvas(w, h)
    }
    const ctx = this._offscreen.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    if (this._bitmap === null) return
    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, this._opacity))
    ctx.translate(this._position.x, this._position.y)
    ctx.rotate(this._rotation)
    const bw = this._natW * this._scale
    const bh = this._natH * this._scale
    ctx.drawImage(this._bitmap, -bw / 2, -bh / 2, bw, bh)
    ctx.restore()
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      bitmap:         this._bitmap,
      filename:       this._filename,
      natW:           this._natW,
      natH:           this._natH,
      rotation:       this._rotation,
      manualPosition: this._manualPosition,
      manualScale:    this._manualScale,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (state.bitmap instanceof ImageBitmap) this._bitmap = state.bitmap
    if (typeof state.filename === 'string') this._filename = state.filename
    if (typeof state.natW === 'number') this._natW = state.natW
    if (typeof state.natH === 'number') this._natH = state.natH
    if (typeof state.rotation === 'number') this._rotation = state.rotation
    if (state.manualPosition && typeof state.manualPosition === 'object') {
      this._manualPosition = state.manualPosition as Point
    }
    if (typeof state.manualScale === 'number') this._manualScale = state.manualScale
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    // Load button (panel strip) — highest priority
    if (boundingBoxContains(this._loadBtnBounds(), point)) {
      this.openFilePicker()
      return true
    }

    const hp = this._handlePos()

    // Rotate handle — suspends rotationSlot binding (if any) and takes manual control
    if (ptDist(point, hp.rotate) <= HANDLE_HIT) {
      if (this._rotationSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._rotationSlot)?.toggle()
      }
      this._drag = {
        type: 'rotate',
        center:     { ...this._position },
        startAngle: Math.atan2(point.y - this._position.y, point.x - this._position.x),
        startRot:   this._rotation,
      }
      return true
    }

    // Scale handle — only when scaleSlot is unbound
    if (!this._scaleSlot.isActive && ptDist(point, hp.scale) <= HANDLE_HIT) {
      this._drag = {
        type:       'scale',
        center:     { ...this._position },
        startDist:  Math.max(1, ptDist(point, this._position)),
        startScale: this._scale,
      }
      return true
    }

    // Move handle — only when positionSlot is unbound
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
      // rotate
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

  protected override hitTestSelf(point: { x: number; y: number }) {
    // Panel strip
    if (boundingBoxContains(this.canvasBounds, point)) return this
    // Capture all events while dragging
    if (this._drag !== null) return this
    // Transform handles (canvas space)
    const hp = this._handlePos()
    if (ptDist(point, hp.move)   <= HANDLE_HIT) return this
    if (ptDist(point, hp.scale)  <= HANDLE_HIT) return this
    if (ptDist(point, hp.rotate) <= HANDLE_HIT) return this
    return null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    this._renderCanvas(ctx)
  }

  renderPanel(ctx: Ctx2D): void {
    this._renderPanelImpl(ctx)
  }

  override renderOverlay(ctx: Ctx2D): void {
    this._renderHandles(ctx)
  }

  // ── Stack panel ─────────────────────────────────────────────

  private _renderPanelImpl(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds
    if (width <= 0 || height <= 0) return

    const midY = y + height / 2

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

    // Filename / placeholder
    const loadB = this._loadBtnBounds()
    const textL = x + 12
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'

    if (this._bitmap === null) {
      ctx.fillStyle = 'rgba(255,255,255,0.30)'
      ctx.fillText('no image loaded', textL, midY)
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.fillText(this._filename, textL, midY - 6)
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.font      = '10px monospace'
      ctx.fillText(`${this._natW} × ${this._natH}`, textL, midY + 6)
    }

    // Slot indicators — pos / α / sc / rot
    const slots = [
      { slot: this._positionSlot, label: 'pos', accent: ACCENT },
      { slot: this._opacitySlot,  label: 'α',   accent: ACCENT },
      { slot: this._scaleSlot,    label: 'sc',  accent: ACCENT },
      { slot: this._rotationSlot, label: 'rot', accent: DIR_ACCENT },
    ]
    let dx = loadB.x - 6
    ctx.font = '9px monospace'
    for (let i = slots.length - 1; i >= 0; i--) {
      const { slot, label, accent } = slots[i]!
      const active = slot.isActive
      ctx.fillStyle    = active ? accent : 'rgba(255,255,255,0.22)'
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(active ? '●' : '○', dx, midY)
      dx -= 12
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText(label, dx, midY)
      dx -= ctx.measureText(label).width + 6
    }

    // [📁] load button
    this._drawBtn(ctx, loadB, '📁', 'rgba(255,255,255,0.75)')

    ctx.restore()
  }

  // ── Canvas image ─────────────────────────────────────────────

  private _renderCanvas(ctx: Ctx2D): void {
    const { x: px, y: py } = this._position

    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, this._opacity))
    ctx.translate(px, py)
    ctx.rotate(this._rotation)

    if (this._bitmap !== null) {
      const w = this._natW * this._scale
      const h = this._natH * this._scale
      ctx.drawImage(this._bitmap, -w / 2, -h / 2, w, h)
    } else {
      // Placeholder: dashed rectangle centred on the position.
      const pw = 120, ph = 80
      ctx.strokeStyle = 'rgba(126,207,126,0.40)'
      ctx.lineWidth   = 1.5
      ctx.setLineDash([4, 4])
      ctx.strokeRect(-pw / 2, -ph / 2, pw, ph)
      ctx.setLineDash([])
      ctx.font         = '11px monospace'
      ctx.fillStyle    = 'rgba(126,207,126,0.50)'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('no image', 0, 0)
    }

    ctx.restore()

    // Drop zone overlay — rendered on top of image/placeholder.
    if (this._dragOver) {
      const cw = ctx.canvas.width
      const ch = ctx.canvas.height
      const pad = 24
      ctx.save()
      ctx.fillStyle = 'rgba(126,207,126,0.10)'
      ctx.fillRect(0, 0, cw, ch)
      ctx.strokeStyle = 'rgba(126,207,126,0.80)'
      ctx.lineWidth   = 2
      ctx.setLineDash([10, 6])
      ctx.strokeRect(pad, pad, cw - pad * 2, ch - pad * 2)
      ctx.setLineDash([])
      ctx.font         = 'bold 20px monospace'
      ctx.fillStyle    = 'rgba(126,207,126,0.90)'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('Drop image here', cw / 2, ch / 2)
      ctx.restore()
    }
  }

  // ── Transform handles ────────────────────────────────────────

  private _handlePos() {
    const { x: px, y: py } = this._position
    const cos = Math.cos(this._rotation)
    const sin = Math.sin(this._rotation)

    return {
      move: { x: px, y: py },
      // Scale handle: (SCALE_OX, SCALE_OY) rotated into world space → lower-right
      scale: {
        x: px + SCALE_OX * cos - SCALE_OY * sin,
        y: py + SCALE_OX * sin + SCALE_OY * cos,
      },
      // Rotate handle: (0, -ROT_ARM) rotated into world space → directly above when rot=0
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

    // Dashed arm lines
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

    // Scale handle — square, cyan glow (dimmed when slot bound)
    this._drawGlowSquare(ctx, hp.scale, HANDLE_SZ,
      this._scaleSlot.isActive ? '#666688' : '#81d4fa')

    // Rotate handle — circle, orange glow (dimmed when slot bound)
    this._drawGlowCircle(ctx, hp.rotate, HANDLE_R,
      this._rotationSlot.isActive ? '#666688' : '#ffb74d')

    // Move handle — circle + crosshair, white glow (dimmed when slot bound)
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
    // Dark outline drawn without shadow
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
  // Private helpers
  // ----------------------------------------------------------

  private _loadBtnBounds() {
    const { x, y, width, height } = this.canvasBounds
    return { x: x + width - BTN_M - BTN, y: y + (height - BTN) / 2, width: BTN, height: BTN }
  }

  private _drawBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    colour: string,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    ctx.font         = '14px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }
}
