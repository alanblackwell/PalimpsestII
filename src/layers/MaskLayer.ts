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
import { drawIcon, type IconName } from '../ui/icons.js'

type BBox = { x: number; y: number; width: number; height: number }

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
//      Hold Shift while dragging to constrain the stroke to a horizontal or
//      vertical line (standard axis-constrain convention, driven by
//      `Node.shiftKey`). Moving substantially perpendicular to the current
//      line — more than a brush-scaled threshold, so it reads as an
//      intentional turn rather than wobble — plants a corner and continues
//      as a new segment locked to the perpendicular axis, like a polyline.
//      See `_moveConstrained`.
//
// The final mask is the union of all active shapes plus the painted layer.
//
// Controls (panel above the slot rows at x=300), in two rows:
//   Row 1 — big touch-sized buttons, wrapping into extra rows on narrow
//   (phone) panels rather than shrinking (same tradeoff as CaptureLayer's
//   mode/shutter/save/share row):
//     [✏]        — paint tool icon (white / include); click to enable, click again to idle
//     [⌫]        — erase tool icon (remove painted areas); same toggle; switches modes
//     [✕]        — clear all freehand paint (undoable via [↺])
//     [↺]        — undo: one-level undo of the last stroke *or* the last
//                  clear, whichever happened most recently; falls back to a
//                  full reset (clear paint + unbind all shape slots) if
//                  there's nothing left to undo
//   Row 2 — brush shape/size presets + size slider:
//     [●][●][●][■][╱] — presets: three round sizes (small/medium/large),
//                  a square brush, and a slanted-line (calligraphy) brush;
//                  click to jump to that shape + size
//     ──●──      — brush-size slider (4–100 px), drag to adjust; applies to
//                  whichever shape is currently selected
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
const LINE_BRUSH_ANGLE = -Math.PI / 4   // slant of the "line" brush shape

// Shift-constrain tuning. AXIS_LOCK_EPS is the minimum movement before an
// initial direction is committed to (avoids locking onto 1px of jitter
// right at the start of a segment). AXIS_PIVOT_MIN is the minimum
// perpendicular deviation from the current constrained line that counts as
// an intentional turn rather than brush wobble — scaled up by brush size so
// a fat brush doesn't pivot from movement smaller than its own stroke.
const AXIS_LOCK_EPS  =  4
const AXIS_PIVOT_MIN = 24

type BrushShape = 'round' | 'square' | 'line'
type BrushPreset = { shape: BrushShape; size: number }
const BRUSH_PRESETS: BrushPreset[] = [
  { shape: 'round',  size: 8  },
  { shape: 'round',  size: 24 },
  { shape: 'round',  size: 56 },
  { shape: 'square', size: 24 },
  { shape: 'line',   size: 24 },
]

const N_SHAPES      =  4

// Tools-panel geometry (drawn at the canvas-space panel x, above the slot rows).
// Row 1 — big paint/erase/clear/undo touch buttons; row 2 — brush presets + slider.
const TOOL_SZ      = 52   // target square size for the row-1 buttons
const TOOL_GAP     =  8   // gap between row-1 buttons
const TOOL_MARGIN  = 10   // margin inside row 1 around the button grid
const ROW_GAP      =  8   // gap between row 1 and row 2
const ROW2_H       = 40   // row 2 pill height
const ROW2_MARGIN  = 10   // margin inside row 2
const GROUP_GAP    = 10   // gap between the presets group and the slider
const SWATCH_SZ    = 22   // brush-preset buttons
const SWATCH_GAP   =  4
const TOOLS_GAP    =  6

// Invert pill — sits below the shape-slot pill
const PILL_GAP  =  8   // vertical gap between the shape-slot pill and the invert pill
const SLOT_H    = 30   // must match Layer.renderSlotGroup's row height

export class MaskLayer extends Layer implements MaskSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Mask])

  private readonly _shapeSlots: ParameterSlot[]
  private readonly _invertSlot: ParameterSlot
  private readonly _clipRegionSlot: ParameterSlot

  private _painted:   OffscreenCanvas
  private _erased:    OffscreenCanvas   // erasure mask — subtracted from composited result
  private _offscreen: OffscreenCanvas
  private _scratch:   OffscreenCanvas

  // One-level undo state — saved at the start of each stroke.
  private _undoPainted: OffscreenCanvas | null = null
  private _undoErased:  OffscreenCanvas | null = null

  readonly blockPixelPick = true

  private _activeTool:    'paint' | 'erase' | null = null
  private _brushSize      = BRUSH_DEFAULT
  private _brushShape:    BrushShape = 'round'
  private _isDrawing      = false
  private _sliderDragging = false
  private _lastPoint:   Point | null = null
  private _cursorPoint: Point | null = null

  // Shift-constrain state. `_axisAnchor` is the point the current
  // constrained segment runs through; `_lockedAxis` is which axis it's
  // locked to ('x' = horizontal line, y fixed; 'y' = vertical line, x
  // fixed). Both reset to null whenever constrain mode is (re-)entered, so
  // the anchor/axis are re-derived from the current drawing position —
  // see `_moveConstrained`.
  private _axisAnchor: Point | null = null
  private _lockedAxis: 'x' | 'y' | null = null

  // Invert toggle
  private _inverted = false
  private _lastInvertToggleTime: number | null = null   // invertSlot rising-edge detection
  private _invertToggleBounds: { x: number; y: number; width: number; height: number } | null = null

  constructor() {
    super()
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    this._painted   = new OffscreenCanvas(w, h)
    this._erased    = new OffscreenCanvas(w, h)
    this._offscreen = new OffscreenCanvas(w, h)
    this._scratch   = new OffscreenCanvas(w, h)

    this._shapeSlots = Array.from({ length: N_SHAPES }, (_, i) =>
      new ParameterSlot(ValueType.Mask, this, `shape ${i + 1}`),
    )
    this._invertSlot = new ParameterSlot(ValueType.Event, this, 'invert')
    // Feedback slot: a Clip<Shape> host is bound here (a raw, cardless
    // ParameterSlot.bind() — see main.ts's postInsertLayer) as its hidden
    // mask-tracker helper's own tracked-region input. The host's own
    // maskSlot is separately bound *to* this helper (for the "click a
    // bound slot whose source is a hidden helper" exposure gesture), which
    // would otherwise make this a two-node graph cycle — feedback exempts
    // it from the cycle check. Appended last (not grouped with the shape
    // slots) so existing save files' shape/invert slot indices are unaffected.
    this._clipRegionSlot = new ParameterSlot(ValueType.Mask, this, 'clip region', true)
    this.slots.push(...this._shapeSlots, this._invertSlot, this._clipRegionSlot)
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

  // The mask-tracker feedback slot — see the constructor comment. Public so
  // main.ts's postInsertLayer and Persistence (save/load) can bind it
  // directly to a Clip<Shape> host.
  get clipRegionSlot(): ParameterSlot { return this._clipRegionSlot }

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

    if (this._clipRegionSlot.isActive) {
      // Deliberately passive — no forced evaluate() here. The host's own
      // recompute() (ClipRectLayer etc.) also reads *this* helper's mask
      // passively, for its actual clip compositing — a genuine two-way data
      // dependency, not just the structural graph cycle clipRegionSlot's
      // `feedback` flag exists to get past. Forcing freshness on either
      // side races the other's still-in-progress recompute() (whichever
      // evaluates first this frame would reenter the other mid-construction
      // and read incomplete data — this previously caused both a stack
      // overflow and a broken live-drag preview). Passive on both sides
      // settles to correct output within about one frame via the ordinary
      // dirty-propagation each side already registers on the other
      // (clipRegionSlot / maskSlot), which is imperceptible during a live
      // drag. The one gap this leaves — a brand-new pair where neither side
      // has evaluated even once — is handled by an explicit bootstrap
      // sequence at creation time (see main.ts's postInsertLayer).
      const mask = (this._clipRegionSlot.source as MaskSource).getMask()
      if (mask !== null) ctx.drawImage(mask, 0, 0)
    }

    // Subtract the erasure mask from the composited result.
    ctx.globalCompositeOperation = 'destination-out'
    ctx.drawImage(this._erased, 0, 0)
    ctx.globalCompositeOperation = 'source-over'

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

    // Keep redrawing while a tool is active so the brush cursor follows
    // the pointer between clicks (reads Node.pointerCanvas each frame).
    if (this._activeTool !== null && !this.outsideStack) {
      queueMicrotask(() => this.forceDirty())
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
      erased:     this._erased,
      brushSize:  this._brushSize,
      brushShape: this._brushShape,
      inverted:   this._inverted,
      activeTool: this._activeTool,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.brushSize === 'number') this._brushSize = state.brushSize
    if (state.brushShape === 'round' || state.brushShape === 'square' || state.brushShape === 'line') {
      this._brushShape = state.brushShape
    }
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
    if (state.erased instanceof ImageBitmap) {
      this._ensureCanvases()
      const ctx = this._erased.getContext('2d')!
      ctx.clearRect(0, 0, this._erased.width, this._erased.height)
      ctx.drawImage(state.erased, 0, 0)
    }
  }

  // ----------------------------------------------------------
  // Panel layout
  // ----------------------------------------------------------

  private get _toolsY(): number {
    return 50
  }

  // Row-1 button grid — paint/erase/clear/undo, wrapping into extra rows on
  // narrow (phone) panels rather than shrinking, same tradeoff as
  // CaptureLayer's mode/shutter/save/share row.
  private _row1Cols(pillWidth: number): number {
    const availCols = Math.max(1, Math.floor((pillWidth - 2 * TOOL_MARGIN + TOOL_GAP) / (TOOL_SZ + TOOL_GAP)))
    return Math.min(availCols, 4)
  }

  private _row1Rows(pillWidth: number): number {
    return Math.ceil(4 / this._row1Cols(pillWidth))
  }

  private _row1Height(): number {
    const rows = this._row1Rows(panelWidth(Node.canvasWidth))
    return TOOL_MARGIN * 2 + rows * TOOL_SZ + (rows - 1) * TOOL_GAP
  }

  private get _row2Y(): number {
    return this._toolsY + this._row1Height() + ROW_GAP
  }

  override get panelBottom(): number {
    return this._row2Y + ROW2_H + TOOLS_GAP
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(_ctx: Ctx2D): void {}

  renderPanel(ctx: Ctx2D): void {
    this._drawMaskOverlay(ctx)
    this._renderBeforeUI(ctx)
    this._drawToolsPanel(ctx)
    if (this._activeTool !== null && (this._cursorPoint ?? Node.pointerCanvas) !== null) {
      this._drawBrushCursor(ctx)
    }
  }

  // Hook for subclasses to inject rendering after the mask overlay but before UI controls.
  protected _renderBeforeUI(_ctx: Ctx2D): void {}

  // Renders the 4 shape-binding slots as their normal pill, then a second
  // pill directly below for the invert slot + its manual toggle button.
  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    let y = this.renderSlotGroup(ctx, this._shapeSlots, this.panelBottom)
    // Only shown once bound — a plain user-created MaskLayer never has
    // anything bound here, so this stays invisible for the common case and
    // only appears on an exposed Clip<Shape> mask-tracker helper.
    if (this._clipRegionSlot.isActive) {
      y = this.renderSlotGroup(ctx, [this._clipRegionSlot], y + PILL_GAP)
    }
    const invertY = y + PILL_GAP
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

    ctx.fillStyle    = this._inverted ? EV_ACCENT : 'rgba(255,255,255,0.55)'
    drawIcon(ctx, this._inverted ? 'circle-half' : 'record', btnX + BTN_SZ / 2, midY, BTN_SZ - 8)

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

  private _drawToolsPanel(ctx: Ctx2D): void {
    const px    = this._panelX
    const tw    = panelWidth(Node.canvasWidth)
    const row1H = this._row1Height()
    const row2Y = this._row2Y

    ctx.save()

    // ── Row 1 — big paint / erase / clear / undo touch buttons ──
    ctx.fillStyle = 'rgba(0,0,0,0.40)'
    ctx.beginPath()
    ctx.roundRect(px, this._toolsY, tw, row1H, 6)
    ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(px, this._toolsY, 4, row1H, [4, 0, 0, 4])
    ctx.fill()

    this._drawToolBtn(ctx, this._paintBtnBounds(), 'pencil', this._activeTool === 'paint')
    this._drawToolBtn(ctx, this._eraseBtnBounds(), 'eraser', this._activeTool === 'erase')
    this._drawToolBtn(ctx, this._clearBtnBounds(), 'x', false, 'rgba(255,180,180,0.70)')
    this._drawToolBtn(ctx, this._undoBtnBounds(), 'arrow-counter-clockwise', false, 'rgba(255,255,255,0.50)')

    // ── Row 2 — brush shape/size presets + size slider ──────────
    ctx.fillStyle = 'rgba(0,0,0,0.40)'
    ctx.beginPath()
    ctx.roundRect(px, row2Y, tw, ROW2_H, 6)
    ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(px, row2Y, 4, ROW2_H, [4, 0, 0, 4])
    ctx.fill()

    this._drawBrushPresets(ctx)
    this._drawSlider(ctx)

    ctx.restore()
  }

  private _drawBrushPresets(ctx: Ctx2D): void {
    for (let i = 0; i < BRUSH_PRESETS.length; i++) {
      const preset = BRUSH_PRESETS[i]!
      const b      = this._presetBtnBounds(i)
      const active = this._brushShape === preset.shape && this._brushSize === preset.size

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

      ctx.fillStyle = active ? ACCENT : 'rgba(255,255,255,0.55)'
      this._drawPresetGlyph(ctx, preset, b)
    }
  }

  // Draws a small representative swatch for a brush preset — a filled
  // circle/square/slanted bar scaled by the preset's size, matching the
  // stamp shape `_applyBrush` actually paints with.
  private _drawPresetGlyph(ctx: Ctx2D, preset: BrushPreset, b: BBox): void {
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    const r  = 2 + (preset.size - BRUSH_MIN) / (BRUSH_MAX - BRUSH_MIN) * (b.width / 2 - 4)

    switch (preset.shape) {
      case 'square':
        ctx.beginPath()
        ctx.rect(cx - r, cy - r, r * 2, r * 2)
        ctx.fill()
        break
      case 'line': {
        const { len: rawLen, width: w } = MaskLayer._lineDims(r)
        const len = Math.min(rawLen, b.width - 4)
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(LINE_BRUSH_ANGLE)
        ctx.beginPath()
        ctx.rect(-len / 2, -w / 2, len, w)
        ctx.fill()
        ctx.restore()
        break
      }
      default:
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fill()
    }
  }

  // Dimensions of a "line" brush stamp for a given radius — shared by the
  // paint stamp, the preset swatch, and the hover cursor so they all agree.
  private static _lineDims(r: number): { len: number; width: number } {
    return { len: r * 2.2, width: Math.max(2, r * 0.4) }
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
    const pt = this._cursorPoint ?? Node.pointerCanvas
    if (pt === null) return
    const { x, y } = pt
    const r = this._brushSize / 2
    ctx.save()
    ctx.strokeStyle = this._activeTool === 'paint'
      ? 'rgba(255,255,255,0.80)'
      : this._activeTool === 'erase'
        ? 'rgba(255,140,140,0.80)'
        : 'rgba(200,200,200,0.50)'
    ctx.lineWidth   = 1.5
    ctx.setLineDash([3, 3])
    switch (this._brushShape) {
      case 'square':
        ctx.strokeRect(x - r, y - r, r * 2, r * 2)
        break
      case 'line': {
        const { len, width: w } = MaskLayer._lineDims(r)
        ctx.translate(x, y)
        ctx.rotate(LINE_BRUSH_ANGLE)
        ctx.strokeRect(-len / 2, -w / 2, len, w)
        break
      }
      default:
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.stroke()
    }
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
    // In idle mode, slot rows take priority so left-clicks reach the
    // slot-click / binding-inspector logic. In paint/erase mode, a click
    // on a slot row starts a brush stroke instead — right-click still
    // reaches the inspector via the separate _onContext path, which calls
    // hitTestSlot directly and never goes through hitTestSelf.
    if (this._activeTool === null && this.hitTestSlot(point) !== null) return null
    // When a tool is active, don't claim pointer-downs in the widget strip —
    // let those reach the StackWidget. Strokes that already started outside the
    // strip continue into it freely (move/up go directly to _active, bypassing
    // hitTestSelf, so no further check is needed).
    const inWidgetArea = Node.widgetVisible && point.x < contentLeft(Node.canvasWidth)
    if (this._activeTool !== null) {
      if (inWidgetArea) return null
      return this
    }
    if (this._sliderDragging) return this
    if (boundingBoxContains(this._paintBtnBounds(), point)) return this
    if (boundingBoxContains(this._eraseBtnBounds(), point)) return this
    if (boundingBoxContains(this._sliderBounds(),   point)) return this
    for (let i = 0; i < BRUSH_PRESETS.length; i++) {
      if (boundingBoxContains(this._presetBtnBounds(i), point)) return this
    }
    if (boundingBoxContains(this._clearBtnBounds(), point)) return this
    if (boundingBoxContains(this._undoBtnBounds(),  point)) return this
    // In idle mode, claim any content-area click (x >= contentLeft, i.e. not
    // hidden by the stack widget) so handlePointerDown can auto-enable paint.
    if (point.x >= contentLeft(Node.canvasWidth)) return this
    return null
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  resetActiveTool(): void {
    this._activeTool = null
    this.markDirty()
  }

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
    for (let i = 0; i < BRUSH_PRESETS.length; i++) {
      if (boundingBoxContains(this._presetBtnBounds(i), point)) {
        const preset = BRUSH_PRESETS[i]!
        this._brushShape = preset.shape
        this._brushSize  = preset.size
        this.markDirty(); return true
      }
    }
    if (boundingBoxContains(this._clearBtnBounds(), point)) {
      this._clearPaint(); return true
    }
    if (boundingBoxContains(this._undoBtnBounds(), point)) {
      this._handleUndoBtn(); return true
    }
    if (this._invertToggleBounds !== null && boundingBoxContains(this._invertToggleBounds, point)) {
      this._handleInvertToggle(); return true
    }

    // Content-area click in idle mode: auto-enable paint and start stroke.
    if (this._activeTool === null && point.x >= contentLeft(Node.canvasWidth)) {
      this._activeTool = 'paint'
      this.markDirty()
    }

    if (this._activeTool !== null) {
      // Save one-level undo state before the stroke begins.
      this._undoPainted = MaskLayer._cloneCanvas(this._painted)
      this._undoErased  = MaskLayer._cloneCanvas(this._erased)
      this._isDrawing   = true
      this._lastPoint   = null
      this._cursorPoint = point
      this._axisAnchor  = null
      this._lockedAxis  = null
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
    if (this._isDrawing && Node.shiftKey) {
      this._moveConstrained(point)
    } else {
      // Not currently constraining — clear any axis lock so the next time
      // Shift is (re-)engaged mid-stroke, the anchor is re-derived from
      // wherever drawing actually is, not a stale earlier position.
      this._axisAnchor = null
      this._lockedAxis = null
      this._cursorPoint = point
      if (this._isDrawing) this._applyBrush(point)
    }
    this.markDirty()
  }

  handlePointerUp(): void {
    this._sliderDragging = false
    this._isDrawing      = false
    this._lastPoint      = null
    this._cursorPoint    = null  // revert to Node.pointerCanvas for hover
    this._axisAnchor     = null
    this._lockedAxis     = null
  }

  // Standard Shift-to-constrain, extended with a "polyline" pivot: the
  // stroke locks to a horizontal or vertical line through `_axisAnchor`.
  // If the drag moves substantially perpendicular to that line (more than
  // `_axisPivotDistance()`, i.e. clearly not just brush wobble), a corner
  // is planted at the point on the current line closest to the drag, and a
  // new segment continues from there, locked to the perpendicular axis.
  private _moveConstrained(point: Point): void {
    // Entering constrained mode fresh (stroke start, or Shift just
    // re-engaged) anchors at the last drawn point so the constrained line
    // continues smoothly from there, and re-derives the initial direction.
    if (this._axisAnchor === null) {
      this._axisAnchor = this._lastPoint ?? point
      this._lockedAxis = null
    }

    let anchor = this._axisAnchor
    let axis   = this._lockedAxis
    const dx = point.x - anchor.x
    const dy = point.y - anchor.y

    if (axis === null) {
      if (Math.abs(dx) < AXIS_LOCK_EPS && Math.abs(dy) < AXIS_LOCK_EPS) {
        this._cursorPoint = anchor
        return
      }
      axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
    } else {
      const perp = axis === 'x' ? Math.abs(dy) : Math.abs(dx)
      if (perp > this._axisPivotDistance()) {
        const corner = axis === 'x' ? { x: point.x, y: anchor.y } : { x: anchor.x, y: point.y }
        this._applyBrush(corner)
        anchor = corner
        axis   = axis === 'x' ? 'y' : 'x'
      }
    }

    this._axisAnchor = anchor
    this._lockedAxis = axis

    const constrained = axis === 'x' ? { x: point.x, y: anchor.y } : { x: anchor.x, y: point.y }
    this._cursorPoint = constrained
    this._applyBrush(constrained)
  }

  private _axisPivotDistance(): number {
    return Math.max(AXIS_PIVOT_MIN, this._brushSize)
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
    const r = this._brushSize / 2

    const stampAt = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, cx: number, cy: number) => {
      switch (this._brushShape) {
        case 'square':
          ctx.beginPath()
          ctx.rect(cx - r, cy - r, r * 2, r * 2)
          ctx.fill()
          break
        case 'line': {
          const { len, width: w } = MaskLayer._lineDims(r)
          ctx.save()
          ctx.translate(cx, cy)
          ctx.rotate(LINE_BRUSH_ANGLE)
          ctx.beginPath()
          ctx.rect(-len / 2, -w / 2, len, w)
          ctx.fill()
          ctx.restore()
          break
        }
        default:
          ctx.beginPath()
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
          ctx.fill()
      }
    }

    const _stroke = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
      if (this._lastPoint === null) {
        stampAt(ctx, point.x, point.y)
      } else {
        const dx    = point.x - this._lastPoint.x
        const dy    = point.y - this._lastPoint.y
        const dist  = Math.sqrt(dx * dx + dy * dy)
        const step  = Math.max(1, r * 0.4)
        const steps = Math.ceil(dist / step)
        for (let i = 0; i <= steps; i++) {
          const t = i / Math.max(1, steps)
          stampAt(ctx, this._lastPoint.x + dx * t, this._lastPoint.y + dy * t)
        }
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    if (this._activeTool === 'paint') {
      // Add to the painted mask.
      const ctx = this._painted.getContext('2d')!
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = 'white'
      _stroke(ctx)
      // Also remove the same area from the erasure mask.
      const ectx = this._erased.getContext('2d')!
      ectx.globalCompositeOperation = 'destination-out'
      ectx.fillStyle = 'rgba(0,0,0,1)'
      _stroke(ectx)
    } else {
      // Add to the erasure mask (subtracted in recompute).
      const ectx = this._erased.getContext('2d')!
      ectx.globalCompositeOperation = 'source-over'
      ectx.fillStyle = 'white'
      _stroke(ectx)
    }

    this._lastPoint = { ...point }
    this.markDirty()
  }

  // Undo the last brush stroke. Called by the [↺] button (first press) and
  // by Cmd/Ctrl+Z via InteractionSystem.
  undoLastStroke(): void {
    if (this._undoPainted === null) return
    const pctx = this._painted.getContext('2d')!
    pctx.clearRect(0, 0, this._painted.width, this._painted.height)
    pctx.drawImage(this._undoPainted, 0, 0)
    const ectx = this._erased.getContext('2d')!
    ectx.clearRect(0, 0, this._erased.width, this._erased.height)
    ectx.drawImage(this._undoErased!, 0, 0)
    this._undoPainted = null
    this._undoErased  = null
    this.markDirty()
  }

  // [↺] button: undo the last stroke or clear on first press; falls back to
  // a full reset (clear + unbind shape slots) once there's nothing left to
  // undo.
  private _handleUndoBtn(): void {
    if (this._undoPainted !== null) {
      this.undoLastStroke()
    } else {
      this._reset()
    }
  }

  // Saves undo state before wiping, same as a brush stroke, so [↺] can
  // restore the pre-clear paint.
  private _clearPaint(): void {
    this._undoPainted = MaskLayer._cloneCanvas(this._painted)
    this._undoErased  = MaskLayer._cloneCanvas(this._erased)
    const pctx = this._painted.getContext('2d')!
    pctx.clearRect(0, 0, this._painted.width, this._painted.height)
    const ectx = this._erased.getContext('2d')!
    ectx.clearRect(0, 0, this._erased.width, this._erased.height)
    this.markDirty()
  }

  private _reset(): void {
    this._clearPaint()
    for (const slot of this._shapeSlots) {
      if (slot.isActive) slot.unbind()
    }
    this.markDirty()
  }

  private static _cloneCanvas(src: OffscreenCanvas): OffscreenCanvas {
    const clone = new OffscreenCanvas(src.width, src.height)
    clone.getContext('2d')!.drawImage(src, 0, 0)
    return clone
  }

  // ----------------------------------------------------------
  // Canvas management
  // ----------------------------------------------------------

  private _ensureCanvases(): void {
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    // _painted and _erased only grow — never shrink. On mobile, rotating the
    // phone reduces canvasWidth/Height; strokes outside the new bounds must be
    // preserved so they reappear when the device is rotated back.
    if (this._painted.width < w || this._painted.height < h) {
      const newW = Math.max(this._painted.width, w)
      const newH = Math.max(this._painted.height, h)
      const next = new OffscreenCanvas(newW, newH)
      next.getContext('2d')!.drawImage(this._painted, 0, 0)
      this._painted = next
    }
    if (this._erased.width < w || this._erased.height < h) {
      const newW = Math.max(this._erased.width, w)
      const newH = Math.max(this._erased.height, h)
      const next = new OffscreenCanvas(newW, newH)
      next.getContext('2d')!.drawImage(this._erased, 0, 0)
      this._erased = next
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

  // Row-1 grid cell for button index i (0=paint, 1=erase, 2=clear, 3=undo) —
  // wraps into extra rows on narrow panels, same as CaptureLayer's grid.
  private _row1BtnBounds(i: number): BBox {
    const cols = this._row1Cols(panelWidth(Node.canvasWidth))
    const r = Math.floor(i / cols), c = i % cols
    return {
      x: this._panelX + TOOL_MARGIN + c * (TOOL_SZ + TOOL_GAP),
      y: this._toolsY + TOOL_MARGIN + r * (TOOL_SZ + TOOL_GAP),
      width: TOOL_SZ, height: TOOL_SZ,
    }
  }

  private _paintBtnBounds(): BBox { return this._row1BtnBounds(0) }
  private _eraseBtnBounds(): BBox { return this._row1BtnBounds(1) }
  private _clearBtnBounds(): BBox { return this._row1BtnBounds(2) }
  private _undoBtnBounds():  BBox { return this._row1BtnBounds(3) }

  private _presetBtnBounds(i: number): BBox {
    const y = this._row2Y + (ROW2_H - SWATCH_SZ) / 2
    const x = this._panelX + ROW2_MARGIN + i * (SWATCH_SZ + SWATCH_GAP)
    return { x, y, width: SWATCH_SZ, height: SWATCH_SZ }
  }

  // Slider track area (pointer hit zone) — fills whatever space is left
  // to the right of the presets group.
  private _sliderBounds(): BBox {
    const tw       = panelWidth(Node.canvasWidth)
    const presetsW = BRUSH_PRESETS.length * SWATCH_SZ + (BRUSH_PRESETS.length - 1) * SWATCH_GAP
    const leftX    = this._panelX + ROW2_MARGIN + presetsW + GROUP_GAP
    const rightX   = this._panelX + tw - ROW2_MARGIN
    const width    = Math.max(30, rightX - leftX)
    return { x: leftX, y: this._row2Y, width, height: ROW2_H }
  }

  // ----------------------------------------------------------
  // Drawing helpers
  // ----------------------------------------------------------

  // `active` draws the highlighted (currently-selected-tool) state; `colour`
  // overrides the inactive icon colour for buttons that aren't a toggle
  // (clear/undo — always drawn inactive, but with their own icon tint).
  private _drawToolBtn(
    ctx: Ctx2D,
    b: BBox,
    icon: IconName,
    active: boolean,
    colour = 'rgba(255,255,255,0.55)',
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
    ctx.fillStyle = active ? ACCENT : colour
    drawIcon(ctx, icon, b.x + b.width / 2, b.y + b.height / 2, Math.min(b.width, b.height) - 8)
  }
}

// Bootstrap a freshly-wired Clip<Shape> host + mask-tracker helper pair —
// called right after `helper.clipRegionSlot.bind(host)`, both at creation
// (main.ts's postInsertLayer) and on load (Persistence.ts/CollectionExport.ts's
// phase 6), the two places such a pair comes into existence.
//
// Both sides' recompute() read the other passively (see clipRegionSlot's
// handling above, and the host's own recompute()) — forcing either side
// would race the other's still-in-progress recompute() within the same
// frame (this previously caused both a stack-overflow and a broken
// live-drag preview). Passive reads settle to correct output within about
// a frame via the ordinary dirty propagation each side already registers
// on the other, which is fine once the pair is live — but a *brand-new*
// pair, where neither side has ever evaluated, would otherwise settle on a
// permanently blank clip with nothing left to mark either dirty again.
// Drive one full settling pass here instead, in dependency order: host's
// own geometry (always self-contained) -> helper's composite (now sees a
// real shape) -> host's own clip (now sees a real composite).
export function settleMaskTrackerPair(host: Layer, helper: MaskLayer): void {
  host.evaluate()
  helper.evaluate()
  host.forceDirty()
  host.evaluate()
}
