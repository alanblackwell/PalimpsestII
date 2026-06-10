import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type Point,      type PointSource,
  type Amount,     type AmountSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// ImageLayer — loads and renders a bitmap image on the canvas
// ------------------------------------------------------------
//
// Implements ImageSource so downstream layers can consume the
// loaded bitmap via getImage().
//
// Input slots:
//   positionSlot  (Point)  — canvas anchor (centre of image).
//                            Unbound default: { x: 400, y: 300 }.
//   opacitySlot   (Amount) — globalAlpha [0, 1].
//                            Unbound default: 1.0.
//   scaleSlot     (Amount) — maps [0, 1] → [MIN_SCALE, MAX_SCALE].
//                            Unbound default: 1.0 (natural size).
//
// Image loading:
//   Click [📁] to open a native file picker and load any browser-
//   supported image format via createImageBitmap().  The previous
//   bitmap is closed to free GPU memory.
//
// Rendering:
//   Two components like PointLayer / TextLayer:
//     1. Stack panel at this.bounds — filename, dimensions, slot
//        indicators, [📁] load button.
//     2. Canvas image drawn centred on the position point, at the
//        resolved scale and opacity.  A thin border is drawn when
//        no image is loaded yet.
//
// Visual layout of the stack panel (height ≈ 36 px):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌  sunset.jpg  800×600       pos ●  α ●  sc ●   [📁]  │
//   └──────────────────────────────────────────────────────────┘

const ACCENT     = '#7ecf7e'   // Image type colour (from BindingLayer table)
const MIN_SCALE  = 0.05
const MAX_SCALE  = 4.0
const DEFAULT_POS: Point = { x: 400, y: 300 }

// Button geometry
const BTN   = 22
const BTN_M = 6

export class ImageLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _positionSlot: ParameterSlot
  private readonly _opacitySlot:  ParameterSlot
  private readonly _scaleSlot:    ParameterSlot

  private _bitmap:   ImageValue = null
  private _filename: string     = ''
  private _natW:     number     = 0
  private _natH:     number     = 0
  private _dragOver: boolean    = false

  // Resolved values (updated in recompute)
  private _position: Point  = { ...DEFAULT_POS }
  private _opacity:  number = 1.0
  private _scale:    number = 1.0

  constructor() {
    super()
    this._positionSlot = new ParameterSlot(ValueType.Point,  this)
    this._opacitySlot  = new ParameterSlot(ValueType.Amount, this)
    this._scaleSlot    = new ParameterSlot(ValueType.Amount, this)
    this.slots.push(this._positionSlot, this._opacitySlot, this._scaleSlot)
    this.debugName = 'ImageLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._bitmap }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get positionSlot(): ParameterSlot { return this._positionSlot }
  get opacitySlot():  ParameterSlot { return this._opacitySlot  }
  get scaleSlot():    ParameterSlot { return this._scaleSlot    }

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
      : { ...DEFAULT_POS }

    this._opacity = this._opacitySlot.isActive
      ? (this._opacitySlot.source as AmountSource).getAmount() as Amount
      : 1.0

    if (this._scaleSlot.isActive) {
      const t = (this._scaleSlot.source as AmountSource).getAmount() as Amount
      this._scale = MIN_SCALE + t * (MAX_SCALE - MIN_SCALE)
    } else {
      this._scale = 1.0
    }
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._loadBtnBounds(), point)) {
      this.openFilePicker()
      return true
    }
    return false
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    return boundingBoxContains(this.bounds, point) ? this : null
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

  // ── Stack panel ─────────────────────────────────────────────

  private _renderPanelImpl(ctx: Ctx2D): void {
    const { x, y, width, height } = this.bounds
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
    const loadB   = this._loadBtnBounds()
    const textL   = x + 12
    const textR   = loadB.x - 60   // leave room for slot indicators
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

    // Slot indicators — pos / α / sc
    const slots = [
      { slot: this._positionSlot, label: 'pos' },
      { slot: this._opacitySlot,  label: 'α'   },
      { slot: this._scaleSlot,    label: 'sc'  },
    ]
    let dx = loadB.x - 6
    ctx.font = '9px monospace'
    for (let i = slots.length - 1; i >= 0; i--) {
      const { slot, label } = slots[i]
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

    // [📁] load button
    this._drawBtn(ctx, loadB, '📁', 'rgba(255,255,255,0.75)')

    ctx.restore()
  }

  // ── Canvas image ─────────────────────────────────────────────

  private _renderCanvas(ctx: Ctx2D): void {
    const { x: px, y: py } = this._position

    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, this._opacity))

    if (this._bitmap !== null) {
      const w = this._natW * this._scale
      const h = this._natH * this._scale
      ctx.drawImage(this._bitmap, px - w / 2, py - h / 2, w, h)
    } else {
      // Placeholder: dashed rectangle centred on the position.
      const pw = 120, ph = 80
      ctx.strokeStyle = 'rgba(126,207,126,0.40)'
      ctx.lineWidth   = 1.5
      ctx.setLineDash([4, 4])
      ctx.strokeRect(px - pw / 2, py - ph / 2, pw, ph)
      ctx.setLineDash([])
      ctx.font         = '11px monospace'
      ctx.fillStyle    = 'rgba(126,207,126,0.50)'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('no image', px, py)
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

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _loadBtnBounds() {
    const { x, y, width, height } = this.bounds
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
