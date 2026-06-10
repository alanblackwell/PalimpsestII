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
//   1. Shape slots  — up to 4 ShapeLayer (or any MaskSource) inputs,
//                     each rasterised as a white filled region.
//   2. Painted layer — freehand strokes drawn directly on the canvas
//                      with a paint or erase tool.
//
// The final mask is the union of all active shapes plus the painted layer.
//
// Tools (toggle by clicking the button in the panel):
//   ✎  Paint — draw white (include) areas with a circular brush.
//   ◻  Erase — remove painted areas (restore to black / excluded).
//              Note: erase only removes paint, not shape-slot regions.
//
// Brush size is adjusted with the [−] and [+] buttons.
// [✕] clears all freehand paint.
// [↺] clears paint and unbinds all shape slots.
//
// Canvas preview: a semi-transparent overlay of the current mask is
// drawn over the canvas when this layer is selected.

const ACCENT       = '#cfcf7e'
const BRUSH_MIN    =  4
const BRUSH_MAX    = 100
const BRUSH_STEP   =  4
const BRUSH_DEFAULT = 20
const N_SHAPES     =  4

// Panel geometry
const BTN_W  = 20
const BTN_H  = 22
const BTN_M  =  6
const BTN_S  = 20
const TOOL_W = 22

export class MaskLayer extends Layer implements MaskSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Mask])

  private readonly _shapeSlots: ParameterSlot[]

  private _painted:   OffscreenCanvas
  private _offscreen: OffscreenCanvas

  private _activeTool: 'paint' | 'erase' | null = null
  private _brushSize = BRUSH_DEFAULT
  private _isDrawing = false
  private _lastPoint: Point | null = null
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

    // Start with fully opaque black (everything excluded).
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, w, h)

    // Composite painted layer (white strokes on transparent background).
    ctx.drawImage(this._painted, 0, 0)

    // Composite each bound shape mask (white shape on transparent background).
    for (const slot of this._shapeSlots) {
      if (slot.isActive) {
        const mask = (slot.source as MaskSource).getMask()
        if (mask !== null) ctx.drawImage(mask, 0, 0)
      }
    }
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(_ctx: Ctx2D): void {}

  renderPanel(ctx: Ctx2D): void {
    this._drawMaskOverlay(ctx)
    this._drawPanelStrip(ctx)
    if (this._activeTool !== null && this._cursorPoint !== null) {
      this._drawBrushCursor(ctx)
    }
  }

  // Semi-transparent mask overlay so the user can see coverage.
  private _drawMaskOverlay(ctx: Ctx2D): void {
    if (this._offscreen.width <= 1) return
    ctx.save()
    ctx.globalAlpha = 0.28
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(this._offscreen, 0, 0)
    ctx.restore()
  }

  private _drawPanelStrip(ctx: Ctx2D): void {
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

    // Tool buttons
    this._drawToolBtn(ctx, this._paintBtnBounds(), '✎', this._activeTool === 'paint', midY)
    this._drawToolBtn(ctx, this._eraseBtnBounds(), '◻', this._activeTool === 'erase', midY)

    // Brush size controls
    const sb = this._sizeBounds()
    this._drawBtn(ctx, sb.minus, '−', 'rgba(255,255,255,0.55)')
    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(this._brushSize), sb.label.x + sb.label.width / 2, midY)
    this._drawBtn(ctx, sb.plus, '+', 'rgba(255,255,255,0.55)')

    // Clear paint button
    this._drawBtn(ctx, this._clearBtnBounds(), '✕', 'rgba(255,180,180,0.65)')

    // Slot indicator dots
    const resetB = this._resetBtnBounds()
    let dx = resetB.x - 8
    ctx.font = '9px monospace'
    for (let i = this._shapeSlots.length - 1; i >= 0; i--) {
      const slot   = this._shapeSlots[i]!
      const active = slot.isActive
      ctx.fillStyle    = active ? ACCENT : 'rgba(255,255,255,0.22)'
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(active ? '●' : '○', dx, midY)
      dx -= 10
      ctx.fillStyle = 'rgba(255,255,255,0.30)'
      ctx.fillText(`s${i + 1}`, dx, midY)
      dx -= ctx.measureText(`s${i + 1}`).width + 6
    }

    // Reset button
    this._drawBtn(ctx, resetB, '↺', 'rgba(255,255,255,0.45)')

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
    // When a tool is active, capture the full canvas for painting.
    if (this._activeTool !== null) return this
    // Otherwise only respond to clicks on panel buttons.
    const b = this.bounds
    if (!boundingBoxContains(b, point)) return null
    if (boundingBoxContains(this._paintBtnBounds(), point)) return this
    if (boundingBoxContains(this._eraseBtnBounds(), point)) return this
    const sb = this._sizeBounds()
    if (boundingBoxContains(sb.minus, point)) return this
    if (boundingBoxContains(sb.plus,  point)) return this
    if (boundingBoxContains(this._clearBtnBounds(), point)) return this
    if (boundingBoxContains(this._resetBtnBounds(), point)) return this
    return null
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    // Panel buttons — check first regardless of tool state.
    if (boundingBoxContains(this._paintBtnBounds(), point)) {
      this._activeTool = this._activeTool === 'paint' ? null : 'paint'
      this.markDirty(); return true
    }
    if (boundingBoxContains(this._eraseBtnBounds(), point)) {
      this._activeTool = this._activeTool === 'erase' ? null : 'erase'
      this.markDirty(); return true
    }
    const sb = this._sizeBounds()
    if (boundingBoxContains(sb.minus, point)) {
      this._brushSize = Math.max(BRUSH_MIN, this._brushSize - BRUSH_STEP)
      this.markDirty(); return true
    }
    if (boundingBoxContains(sb.plus, point)) {
      this._brushSize = Math.min(BRUSH_MAX, this._brushSize + BRUSH_STEP)
      this.markDirty(); return true
    }
    if (boundingBoxContains(this._clearBtnBounds(), point)) {
      this._clearPaint(); return true
    }
    if (boundingBoxContains(this._resetBtnBounds(), point)) {
      this._reset(); return true
    }

    // Canvas painting — only when a tool is active.
    if (this._activeTool !== null) {
      this._isDrawing  = true
      this._lastPoint  = null
      this._cursorPoint = point
      this._applyBrush(point)
      return true
    }

    return false
  }

  handlePointerMove(point: Point): void {
    this._cursorPoint = point
    if (this._isDrawing) {
      this._applyBrush(point)
    }
    this.markDirty()
  }

  handlePointerUp(): void {
    this._isDrawing = false
    this._lastPoint = null
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
  // Button / zone geometry
  // ----------------------------------------------------------

  private _paintBtnBounds() {
    const { x, y, height } = this.bounds
    return { x: x + 8, y: y + (height - BTN_H) / 2, width: TOOL_W, height: BTN_H }
  }

  private _eraseBtnBounds() {
    const pb = this._paintBtnBounds()
    return { x: pb.x + TOOL_W + 4, y: pb.y, width: TOOL_W, height: BTN_H }
  }

  private _sizeBounds() {
    const eb   = this._eraseBtnBounds()
    const by   = eb.y
    const bh   = eb.height
    const minusX = eb.x + TOOL_W + 8
    return {
      minus: { x: minusX,      y: by, width: 16, height: bh },
      label: { x: minusX + 18, y: by, width: 26, height: bh },
      plus:  { x: minusX + 46, y: by, width: 16, height: bh },
    }
  }

  private _clearBtnBounds() {
    const sb = this._sizeBounds()
    return { x: sb.plus.x + 18, y: sb.plus.y, width: BTN_W, height: BTN_H }
  }

  private _resetBtnBounds() {
    const { x, y, width, height } = this.bounds
    return { x: x + width - BTN_M - BTN_S, y: y + (height - BTN_S) / 2, width: BTN_S, height: BTN_S }
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
    ctx.fillStyle = active ? 'rgba(207,207,126,0.25)' : 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 3)
    ctx.fill()
    if (active) {
      ctx.strokeStyle = ACCENT
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.roundRect(b.x + 0.5, b.y + 0.5, b.width - 1, b.height - 1, 3)
      ctx.stroke()
    }
    ctx.font         = '13px monospace'
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
