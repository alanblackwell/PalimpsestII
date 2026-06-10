import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type MaskValue, type MaskSource,
  type Point,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// MaskLayer — compositing mask editor
// ------------------------------------------------------------
//
// Produces a greyscale mask (white = included, black = excluded)
// by combining two sources:
//
//   1. Shape slots  — up to 4 MaskSource inputs (e.g. RectLayer,
//                     EllipseLayer) dropped onto the slot rows.
//   2. Painted layer — freehand strokes drawn directly on the canvas.
//
// The final mask is the union of all active shapes plus the painted layer.
//
// Controls (panel above the slot rows at x=300):
//   [✎ paint]  — activate paint tool (white / include)
//   [◻ erase]  — activate erase tool (removes painted areas)
//   sz ──●──   — brush-size slider (4–100 px), drag to adjust
//   [✕]        — clear all freehand paint
//   [↺]        — clear paint and unbind all shape slots
//
// Press H to hide/show the LayerStackWidget if it covers the canvas.

const ACCENT        = '#cfcf7e'
const BRUSH_MIN     =  4
const BRUSH_MAX     = 100
const BRUSH_DEFAULT = 20
const N_SHAPES      =  4

// Tools-panel geometry (drawn at x=300, above the slot rows)
const PANEL_X   = 300
const TOOLS_H   = 44
const TOOLS_GAP =  6

export class MaskLayer extends Layer implements MaskSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Mask])

  private readonly _shapeSlots: ParameterSlot[]

  private _painted:   OffscreenCanvas
  private _offscreen: OffscreenCanvas

  private _activeTool:    'paint' | 'erase' | null = null
  private _brushSize      = BRUSH_DEFAULT
  private _isDrawing      = false
  private _sliderDragging = false
  private _lastPoint:   Point | null = null
  private _cursorPoint: Point | null = null

  constructor() {
    super()
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    this._painted   = new OffscreenCanvas(w, h)
    this._offscreen = new OffscreenCanvas(w, h)

    this._shapeSlots = Array.from({ length: N_SHAPES }, (_, i) =>
      new ParameterSlot(ValueType.Mask, this, `shape ${i + 1}`),
    )
    this.slots.push(...this._shapeSlots)
    this.debugName = 'MaskLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // MaskSource
  // ----------------------------------------------------------

  getMask(): MaskValue { return this._offscreen }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    this._ensureCanvases()
    const w = this._offscreen.width
    const h = this._offscreen.height
    const ctx = this._offscreen.getContext('2d')!

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, w, h)

    ctx.drawImage(this._painted, 0, 0)

    for (const slot of this._shapeSlots) {
      if (slot.isActive) {
        const mask = (slot.source as MaskSource).getMask()
        if (mask !== null) ctx.drawImage(mask, 0, 0)
      }
    }
  }

  // ----------------------------------------------------------
  // Panel layout
  // ----------------------------------------------------------

  private get _toolsY(): number {
    return 50 + this.bounds.height + 8
  }

  override get panelBottom(): number {
    return this._toolsY + TOOLS_H + TOOLS_GAP
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(_ctx: Ctx2D): void {}

  renderPanel(ctx: Ctx2D): void {
    this._drawMaskOverlay(ctx)
    this._drawStripPill(ctx)
    this._drawToolsPanel(ctx)
    if (this._activeTool !== null && this._cursorPoint !== null) {
      this._drawBrushCursor(ctx)
    }
  }

  private _drawMaskOverlay(ctx: Ctx2D): void {
    if (this._offscreen.width <= 1) return
    ctx.save()
    ctx.globalAlpha = 0.28
    ctx.drawImage(this._offscreen, 0, 0)
    ctx.restore()
  }

  private _drawStripPill(ctx: Ctx2D): void {
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

    ctx.fillStyle    = 'rgba(255,255,255,0.70)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Mask', x + 12, midY)

    // Slot indicator dots
    let dx = x + width - 10
    ctx.font = '9px monospace'
    for (let i = this._shapeSlots.length - 1; i >= 0; i--) {
      const active = this._shapeSlots[i]!.isActive
      ctx.fillStyle    = active ? ACCENT : 'rgba(255,255,255,0.22)'
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(active ? '●' : '○', dx, midY)
      dx -= 10
      ctx.fillStyle = 'rgba(255,255,255,0.30)'
      ctx.fillText(`s${i + 1}`, dx, midY)
      dx -= ctx.measureText(`s${i + 1}`).width + 6
    }

    ctx.restore()
  }

  private _drawToolsPanel(ctx: Ctx2D): void {
    const ty  = this._toolsY
    const tw  = 260
    const midY = ty + TOOLS_H / 2

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.40)'
    ctx.beginPath()
    ctx.roundRect(PANEL_X, ty, tw, TOOLS_H, 6)
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(PANEL_X, ty, 4, TOOLS_H, [4, 0, 0, 4])
    ctx.fill()

    // Tool buttons
    this._drawToolBtn(ctx, this._paintBtnBounds(), '✎  paint', this._activeTool === 'paint', midY)
    this._drawToolBtn(ctx, this._eraseBtnBounds(), '◻  erase', this._activeTool === 'erase', midY)

    // "sz" label
    ctx.fillStyle    = 'rgba(255,255,255,0.35)'
    ctx.font         = '9px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('sz', PANEL_X + 128, midY)

    // Brush-size slider
    this._drawSlider(ctx)

    // [✕] clear and [↺] reset
    this._drawBtn(ctx, this._clearBtnBounds(), '✕', 'rgba(255,180,180,0.70)')
    this._drawBtn(ctx, this._resetBtnBounds(), '↺', 'rgba(255,255,255,0.50)')

    ctx.restore()
  }

  private _drawSlider(ctx: Ctx2D): void {
    const b      = this._sliderBounds()
    const t      = (this._brushSize - BRUSH_MIN) / (BRUSH_MAX - BRUSH_MIN)
    const thumbR = 7
    const midY   = b.y + b.height / 2
    const x1     = b.x + thumbR
    const x2     = b.x + b.width - thumbR
    const thumbX = x1 + t * (x2 - x1)

    ctx.save()

    // Track background
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth   = 4
    ctx.lineCap     = 'round'
    ctx.beginPath()
    ctx.moveTo(x1, midY)
    ctx.lineTo(x2, midY)
    ctx.stroke()

    // Filled portion
    ctx.strokeStyle = ACCENT
    ctx.lineWidth   = 4
    ctx.beginPath()
    ctx.moveTo(x1, midY)
    ctx.lineTo(thumbX, midY)
    ctx.stroke()

    // Thumb
    ctx.fillStyle = '#e8e8e8'
    ctx.beginPath()
    ctx.arc(thumbX, midY, thumbR, 0, Math.PI * 2)
    ctx.fill()

    if (this._sliderDragging) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.arc(thumbX, midY, thumbR + 2.5, 0, Math.PI * 2)
      ctx.stroke()
    }

    // Size value above the thumb
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.font         = '9px monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(String(this._brushSize), thumbX, midY - thumbR - 1)

    ctx.restore()
  }

  private _drawBrushCursor(ctx: Ctx2D): void {
    const { x, y } = this._cursorPoint!
    ctx.save()
    ctx.strokeStyle = this._activeTool === 'paint'
      ? 'rgba(255,255,255,0.80)'
      : 'rgba(255,140,140,0.80)'
    ctx.lineWidth   = 1.5
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.arc(x, y, this._brushSize / 2, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point): this | null {
    if (this._activeTool !== null || this._sliderDragging) return this
    if (boundingBoxContains(this.bounds, point))            return this
    if (boundingBoxContains(this._paintBtnBounds(), point)) return this
    if (boundingBoxContains(this._eraseBtnBounds(), point)) return this
    if (boundingBoxContains(this._sliderBounds(),   point)) return this
    if (boundingBoxContains(this._clearBtnBounds(), point)) return this
    if (boundingBoxContains(this._resetBtnBounds(), point)) return this
    return null
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._paintBtnBounds(), point)) {
      this._activeTool = this._activeTool === 'paint' ? null : 'paint'
      this.markDirty(); return true
    }
    if (boundingBoxContains(this._eraseBtnBounds(), point)) {
      this._activeTool = this._activeTool === 'erase' ? null : 'erase'
      this.markDirty(); return true
    }
    if (boundingBoxContains(this._sliderBounds(), point)) {
      this._sliderDragging = true
      this._applySlider(point.x)
      return true
    }
    if (boundingBoxContains(this._clearBtnBounds(), point)) {
      this._clearPaint(); return true
    }
    if (boundingBoxContains(this._resetBtnBounds(), point)) {
      this._reset(); return true
    }

    if (this._activeTool !== null) {
      this._isDrawing   = true
      this._lastPoint   = null
      this._cursorPoint = point
      this._applyBrush(point)
      return true
    }

    return false
  }

  handlePointerMove(point: Point): void {
    if (this._sliderDragging) {
      this._applySlider(point.x)
      return
    }
    this._cursorPoint = point
    if (this._isDrawing) this._applyBrush(point)
    this.markDirty()
  }

  handlePointerUp(): void {
    this._sliderDragging = false
    this._isDrawing      = false
    this._lastPoint      = null
  }

  // ----------------------------------------------------------
  // Slider
  // ----------------------------------------------------------

  private _applySlider(px: number): void {
    const b = this._sliderBounds()
    const t = Math.max(0, Math.min(1, (px - b.x) / b.width))
    this._brushSize = Math.round(BRUSH_MIN + t * (BRUSH_MAX - BRUSH_MIN))
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Paint operations
  // ----------------------------------------------------------

  private _applyBrush(point: Point): void {
    this._ensureCanvases()
    const ctx = this._painted.getContext('2d')!
    const r   = this._brushSize / 2

    if (this._activeTool === 'paint') {
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = 'white'
    } else {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = 'rgba(0,0,0,1)'
    }

    if (this._lastPoint === null) {
      ctx.beginPath()
      ctx.arc(point.x, point.y, r, 0, Math.PI * 2)
      ctx.fill()
    } else {
      const dx    = point.x - this._lastPoint.x
      const dy    = point.y - this._lastPoint.y
      const dist  = Math.sqrt(dx * dx + dy * dy)
      const step  = Math.max(1, r * 0.4)
      const steps = Math.ceil(dist / step)
      for (let i = 0; i <= steps; i++) {
        const t = i / Math.max(1, steps)
        ctx.beginPath()
        ctx.arc(
          this._lastPoint.x + dx * t,
          this._lastPoint.y + dy * t,
          r, 0, Math.PI * 2,
        )
        ctx.fill()
      }
    }

    ctx.globalCompositeOperation = 'source-over'
    this._lastPoint = { ...point }
    this.markDirty()
  }

  private _clearPaint(): void {
    const ctx = this._painted.getContext('2d')!
    ctx.clearRect(0, 0, this._painted.width, this._painted.height)
    this.markDirty()
  }

  private _reset(): void {
    this._clearPaint()
    for (const slot of this._shapeSlots) {
      if (slot.isActive) slot.unbind()
    }
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Canvas management
  // ----------------------------------------------------------

  private _ensureCanvases(): void {
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    if (this._painted.width !== w || this._painted.height !== h) {
      const next = new OffscreenCanvas(w, h)
      next.getContext('2d')!.drawImage(this._painted, 0, 0)
      this._painted = next
    }
    if (this._offscreen.width !== w || this._offscreen.height !== h) {
      this._offscreen = new OffscreenCanvas(w, h)
    }
  }

  // ----------------------------------------------------------
  // Button / slider bounds
  // ----------------------------------------------------------

  private _paintBtnBounds() {
    const ty = this._toolsY
    return { x: PANEL_X + 8, y: ty + 8, width: 54, height: 28 }
  }

  private _eraseBtnBounds() {
    const ty = this._toolsY
    return { x: PANEL_X + 66, y: ty + 8, width: 54, height: 28 }
  }

  // Slider track area (pointer hit zone).
  private _sliderBounds() {
    const ty = this._toolsY
    return { x: PANEL_X + 142, y: ty + 6, width: 72, height: 32 }
  }

  private _clearBtnBounds() {
    const ty = this._toolsY
    return { x: PANEL_X + 222, y: ty + 10, width: 18, height: 24 }
  }

  private _resetBtnBounds() {
    const ty = this._toolsY
    return { x: PANEL_X + 244, y: ty + 10, width: 18, height: 24 }
  }

  // ----------------------------------------------------------
  // Drawing helpers
  // ----------------------------------------------------------

  private _drawToolBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    active: boolean,
    midY: number,
  ): void {
    ctx.fillStyle = active ? 'rgba(207,207,126,0.22)' : 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    if (active) {
      ctx.strokeStyle = ACCENT
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.roundRect(b.x + 0.5, b.y + 0.5, b.width - 1, b.height - 1, 4)
      ctx.stroke()
    }
    ctx.font         = '11px monospace'
    ctx.fillStyle    = active ? ACCENT : 'rgba(255,255,255,0.55)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, midY)
  }

  private _drawBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    colour: string,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    ctx.font         = '12px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }
}
