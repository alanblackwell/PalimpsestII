import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type MaskValue, type MaskSource, type EventSource,
  type Point,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'

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
// Below the 4-shape-slot pill, a second pill holds the "invert" slot
// (Event) and its manual [⏺/⏸] toggle button. Either the rising edge of
// a bound event, or a click on the toggle, flips `_inverted`, which swaps
// white <-> transparent across the whole composited mask. Operating the
// toggle manually while a binding is active suspends that binding (see
// `_handleInvertToggle`) — same permanent-override convention as
// PointLayer's wander toggle.
//
// Press H to hide/show the LayerStackWidget if it covers the canvas.

const ACCENT        = '#cfcf7e'
const EV_ACCENT     = '#e0e060'
const BRUSH_MIN     =  4
const BRUSH_MAX     = 100
const BRUSH_DEFAULT = 20
const N_SHAPES      =  4

// Tools-panel geometry (drawn at the canvas-space panel x, above the slot rows)
const TOOLS_H   = 44
const TOOLS_GAP =  6

// Invert pill — sits below the shape-slot pill
const PILL_GAP  =  8   // vertical gap between the shape-slot pill and the invert pill
const SLOT_H    = 26   // must match Layer.renderSlotGroup's row height

export class MaskLayer extends Layer implements MaskSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Mask])

  private readonly _shapeSlots: ParameterSlot[]
  private readonly _invertSlot: ParameterSlot

  private _painted:   OffscreenCanvas
  private _offscreen: OffscreenCanvas
  private _scratch:   OffscreenCanvas

  readonly blockPixelPick = true

  private _activeTool:    'paint' | 'erase' | null = 'paint'
  private _brushSize      = BRUSH_DEFAULT
  private _isDrawing      = false
  private _sliderDragging = false
  private _lastPoint:   Point | null = null
  private _cursorPoint: Point | null = null

  // Invert toggle
  private _inverted = false
  private _lastInvertToggleTime: number | null = null   // invertSlot rising-edge detection
  private _invertToggleBounds: { x: number; y: number; width: number; height: number } | null = null

  // When set (e.g. a Clip<Shape>'s hidden mask helper), the tracked layer's
  // mask is unioned in every recompute — independent of the shape/paint
  // slots, and persists even after this layer is exposed in the stack.
  trackedShape: (Layer & MaskSource) | null = null

  constructor() {
    super()
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    this._painted   = new OffscreenCanvas(w, h)
    this._offscreen = new OffscreenCanvas(w, h)
    this._scratch   = new OffscreenCanvas(w, h)

    this._shapeSlots = Array.from({ length: N_SHAPES }, (_, i) =>
      new ParameterSlot(ValueType.Mask, this, `shape ${i + 1}`),
    )
    this._invertSlot = new ParameterSlot(ValueType.Event, this, 'invert')
    this.slots.push(...this._shapeSlots, this._invertSlot)
    this.debugName = 'MaskLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // MaskSource
  // ----------------------------------------------------------

  getMask(): MaskValue { return this._offscreen }

  // The conventional "first shape" binding target — exposed so main.ts can
  // bind a dropped shape directly (e.g. the mask-drop-on-image shortcut's
  // shape branch, which wraps a Rect/Ellipse/Path/Text in a new MaskLayer).
  get firstShapeSlot(): ParameterSlot { return this._shapeSlots[0]! }

  // The shape slots are conventionally filled with a fresh closed shape
  // (Rect/Ellipse/Path) in outline mode, not another MaskLayer.
  override wantsShapeForSlot(slot: ParameterSlot): boolean {
    return this._shapeSlots.includes(slot)
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    this._ensureCanvases()
    const w = this._offscreen.width
    const h = this._offscreen.height
    const ctx = this._offscreen.getContext('2d')!

    ctx.clearRect(0, 0, w, h)

    ctx.drawImage(this._painted, 0, 0)

    for (const slot of this._shapeSlots) {
      if (slot.isActive) {
        const mask = (slot.source as MaskSource).getMask()
        if (mask !== null) ctx.drawImage(mask, 0, 0)
      }
    }

    if (this.trackedShape !== null) {
      const mask = this.trackedShape.getMask()
      if (mask !== null) ctx.drawImage(mask, 0, 0)
    }

    // Invert toggle — each rising edge flips _inverted.
    if (this._invertSlot.isActive) {
      const t = (this._invertSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastInvertToggleTime) {
        this._lastInvertToggleTime = t
        this._inverted = !this._inverted
      }
    }

    if (this._inverted) {
      const sctx = this._scratch.getContext('2d')!
      sctx.clearRect(0, 0, w, h)
      sctx.drawImage(this._offscreen, 0, 0)

      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = 'white'
      ctx.fillRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'destination-out'
      ctx.drawImage(this._scratch, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
    }
  }

  override autoBindRules(): ReturnType<Layer['autoBindRules']> {
    return [
      // A shape bound straight into a freshly-created MaskLayer's first
      // slot is unlikely to be used for anything else — move it to the
      // Background collection (still evaluated, recoverable via
      // DeletionLayer's toggle) rather than leaving it cluttering the stack.
      { slot: this._shapeSlots[0]!, accepts: (l: Layer) => l.types.has(ValueType.Mask), sendToBackgroundAfterBind: true },
    ]
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      painted:    this._painted,
      brushSize:  this._brushSize,
      inverted:   this._inverted,
      activeTool: this._activeTool,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.brushSize === 'number') this._brushSize = state.brushSize
    if (typeof state.inverted === 'boolean') this._inverted = state.inverted
    if (state.activeTool === 'paint' || state.activeTool === 'erase' || state.activeTool === null) {
      this._activeTool = state.activeTool
    }
    if (state.painted instanceof ImageBitmap) {
      this._ensureCanvases()
      const ctx = this._painted.getContext('2d')!
      ctx.clearRect(0, 0, this._painted.width, this._painted.height)
      ctx.drawImage(state.painted, 0, 0)
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
    if ((this._activeTool !== null || this._sliderDragging) && this._cursorPoint !== null) {
      this._drawBrushCursor(ctx)
    }
  }

  // Renders the 4 shape-binding slots as their normal pill, then a second
  // pill directly below for the invert slot + its manual toggle button.
  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const shapesBottom = this.renderSlotGroup(ctx, this._shapeSlots, this.panelBottom)
    const invertY = shapesBottom + PILL_GAP
    this.renderSlotGroup(ctx, [this._invertSlot], invertY)
    this._renderInvertToggleButton(ctx, this._slotBounds.get(this._invertSlot)!)
  }

  // The invert slot's manual toggle button, drawn at the right edge of its
  // row — same convention as PointLayer's wander-toggle button.
  private _renderInvertToggleButton(ctx: Ctx2D, row: { x: number; y: number; width: number; height: number }): void {
    const BTN_SZ = row.height - 6
    const btnX   = row.x + row.width - BTN_SZ - 3
    const btnY   = row.y + 3
    const midY   = row.y + row.height / 2

    this._invertToggleBounds = { x: btnX, y: btnY, width: BTN_SZ, height: BTN_SZ }

    const state       = this._invertSlot.state
    const isActive    = state === SlotState.Bound
    const isSuspended = state === SlotState.SuspendedBound

    ctx.save()

    if (isActive) ctx.fillStyle = EV_ACCENT + '33'
    else if (isSuspended) ctx.fillStyle = 'rgba(255,255,255,0.10)'
    else ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(btnX, btnY, BTN_SZ, BTN_SZ, 3)
    ctx.fill()

    ctx.strokeStyle = isActive ? EV_ACCENT + '99' : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    if (isSuspended) ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.roundRect(btnX + 0.5, btnY + 0.5, BTN_SZ - 1, BTN_SZ - 1, 3)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.font         = '11px monospace'
    ctx.fillStyle    = this._inverted ? EV_ACCENT : 'rgba(255,255,255,0.55)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(this._inverted ? '⏺' : '⏸', btnX + BTN_SZ / 2, midY)

    ctx.restore()
  }

  // Manually operating the toggle hands permanent control to the user: a
  // bound event source is suspended (never resumed by this button — that
  // takes the binding-inspector's enable toggle), and from then on every
  // click simply flips `_inverted`.
  private _handleInvertToggle(): void {
    if (this._invertSlot.state === SlotState.Bound) {
      this._invertSlot.suspend()
    }
    this._inverted = !this._inverted
    this.markDirty()
  }

  private _drawMaskOverlay(ctx: Ctx2D): void {
    if (this._offscreen.width <= 1) return
    ctx.save()
    // Tint excluded areas (transparent in the mask) with a dark wash.
    ctx.globalAlpha = 0.35
    ctx.fillStyle = '#000033'
    ctx.fillRect(0, 0, this._offscreen.width, this._offscreen.height)
    // Punch through the wash where the mask is opaque (included areas).
    ctx.globalCompositeOperation = 'destination-out'
    ctx.drawImage(this._offscreen, 0, 0)
    ctx.restore()
  }

  private _drawStripPill(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds
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
    const px  = this._panelX
    const tw  = panelWidth(Node.canvasWidth)
    const midY = ty + TOOLS_H / 2

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.40)'
    ctx.beginPath()
    ctx.roundRect(px, ty, tw, TOOLS_H, 6)
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(px, ty, 4, TOOLS_H, [4, 0, 0, 4])
    ctx.fill()

    // Tool buttons
    this._drawToolBtn(ctx, this._paintBtnBounds(), '✎  paint', this._activeTool === 'paint', midY)
    this._drawToolBtn(ctx, this._eraseBtnBounds(), '◻  erase', this._activeTool === 'erase', midY)

    // "sz" label
    ctx.fillStyle    = 'rgba(255,255,255,0.35)'
    ctx.font         = '9px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('sz', px + 128, midY)

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
    // The invert toggle button overlaps the invert slot row — claim it
    // before the slot-row check below hands the click to the slot-click /
    // binding-inspector logic.
    if (this._invertToggleBounds !== null && boundingBoxContains(this._invertToggleBounds, point)) return this
    // Parameter-slot rows take priority over painting, so clicks (and
    // right-clicks) there reach the slot-click / binding-inspector logic
    // in InteractionSystem instead of starting a brush stroke. Painting
    // under a slot row is still possible by starting the stroke just
    // outside it and dragging in.
    if (this.hitTestSlot(point) !== null) return null
    if (this._activeTool !== null || this._sliderDragging) return this
    if (boundingBoxContains(this.canvasBounds, point))      return this
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
      this._cursorPoint    = point
      this._applySlider(point.x)
      return true
    }
    if (boundingBoxContains(this._clearBtnBounds(), point)) {
      this._clearPaint(); return true
    }
    if (boundingBoxContains(this._resetBtnBounds(), point)) {
      this._reset(); return true
    }
    if (this._invertToggleBounds !== null && boundingBoxContains(this._invertToggleBounds, point)) {
      this._handleInvertToggle(); return true
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
    if (this._scratch.width !== w || this._scratch.height !== h) {
      this._scratch = new OffscreenCanvas(w, h)
    }
  }

  // ----------------------------------------------------------
  // Button / slider bounds
  // ----------------------------------------------------------

  // Left edge of the canvas-space tools/slot panel — matches Layer.canvasBounds.
  private get _panelX(): number { return contentLeft(Node.canvasWidth) }

  private _paintBtnBounds() {
    const ty = this._toolsY
    return { x: this._panelX + 8, y: ty + 8, width: 54, height: 28 }
  }

  private _eraseBtnBounds() {
    const ty = this._toolsY
    return { x: this._panelX + 66, y: ty + 8, width: 54, height: 28 }
  }

  // Slider track area (pointer hit zone).
  private _sliderBounds() {
    const ty = this._toolsY
    return { x: this._panelX + 142, y: ty + 6, width: 72, height: 32 }
  }

  private _clearBtnBounds() {
    const ty = this._toolsY
    return { x: this._panelX + 222, y: ty + 10, width: 18, height: 24 }
  }

  private _resetBtnBounds() {
    const ty = this._toolsY
    return { x: this._panelX + 244, y: ty + 10, width: 18, height: 24 }
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
