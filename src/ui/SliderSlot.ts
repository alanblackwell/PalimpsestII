import { ParameterSlot } from '../core/ParameterSlot.js'
import { Node } from '../core/Node.js'
import { SlotState, ValueType, type Ctx2D, type Point } from '../core/types.js'
import { BindingLayer } from '../layers/BindingLayer.js'

// ------------------------------------------------------------
// SliderSlot — combined slider + binding-slot widget
// ------------------------------------------------------------
//
// Renders a single row whose value-box area unifies a continuous
// slider control with the standard binding-slot drop target.  The
// two controls share one row of screen space, and the visual
// emphasis shifts with the slot state:
//
//   Unbound    dashed box    slider at 100 %   ○ left  ⋯ right
//   Bound      solid box     slider at  25 %   ⏸ left  ⋯ right
//   Suspended  dashed box    slider at  75 %   ▶ left  ⋯ right
//
// Both buttons are always rendered.  Their meaning varies by state:
//
//   Left button (○ / ⏸ / ▶):
//     Unbound    → create binding   (handlePointerDown returns false
//                                    so InteractionSystem's slot-tap fires)
//     Bound      → suspend binding  (⏸)
//     Suspended  → resume binding   (▶)
//
//   Right button (⋯):
//     Unbound    → create binding   (same as left when unbound)
//     Bound      → open inspector   (calls onInspectorRequest)
//     Suspended  → open inspector
//
// When bound, the source-layer name floats over the dim slider.
// When suspended, the name is ghosted behind the bright slider.
//
// Hit zones (within the value box):
//   pause     — leftmost BTN_W px
//   inspector — rightmost BTN_W px
//   handle    — thumb ± HANDLE_HIT px
//   slot      — everything else
//               handlePointerDown returns false so InteractionSystem
//               routes the click to the standard slot-tap path
//
// Usage (host layer):
//   widget = new SliderSlot(slot, 'opacity', ACCENT, getValue, setValue, onChanged)
//   widget.onInspectorRequest = (slot, cx, cy) =>
//     interactionSystem.showInspectorForSlot(slot, cx, cy)
//
//   // in renderSlots:
//   _slotBounds.set(slot, row)          // full row = bind-drag target
//   widget.render(ctx, row)
//
//   // in handlePointerDown/Move/Up — delegate unconditionally
//   // in hitTestSelf — return this for any point inside `row`

// ------------------------------------------------------------------
// Layout constants
// ------------------------------------------------------------------

const LABEL_W    = 78   // label column — must match Layer.renderSlotGroup
const BTN_W      = 20   // pause / inspector button width inside value box
const THUMB_R    = 5    // slider thumb radius
const HANDLE_HIT = 8    // extra hit margin around thumb centre

// ------------------------------------------------------------------
// SliderSlot
// ------------------------------------------------------------------

type BBox = { x: number; y: number; width: number; height: number }

export class SliderSlot {
  readonly slot: ParameterSlot

  // Wire this to InteractionSystem.showInspectorForSlot (or equivalent)
  // in postInsertLayer / main.ts after layer creation.
  onInspectorRequest: ((slot: ParameterSlot, cx: number, cy: number) => void) | null = null

  private readonly _label:      string
  private readonly _labelWidth: number
  private readonly _colour:     string
  private readonly _getValue:   () => number   // live value (slot or manual)
  private readonly _setValue:   (v: number) => void  // called on slider drag
  private readonly _onChanged:  () => void     // after pause/resume toggle

  private _dragging = false

  constructor(
    slot:        ParameterSlot,
    label:       string,
    colour:      string,
    getValue:    () => number,
    setValue:    (v: number) => void,
    onChanged:   () => void,
    labelWidth?: number,   // defaults to LABEL_W (78); pass 0 to suppress label column
  ) {
    this.slot        = slot
    this._label      = label
    this._labelWidth = labelWidth ?? LABEL_W
    this._colour     = colour
    this._getValue   = getValue
    this._setValue   = setValue
    this._onChanged  = onChanged
  }

  // ── Geometry ────────────────────────────────────────────────────

  // The bordered value-box inset from the row.
  boxBounds(row: BBox): BBox {
    return {
      x:      row.x + this._labelWidth,
      y:      row.y + 3,
      width:  row.width - this._labelWidth - 2,
      height: row.height - 6,
    }
  }

  // Track extents — always inset from buttons (buttons always present).
  private _trackX(box: BBox): { lo: number; hi: number } {
    const lo = box.x + BTN_W + 4 + THUMB_R
    const hi = box.x + box.width - BTN_W - 4 - THUMB_R
    return { lo, hi }
  }

  private _thumbX(box: BBox, value: number): number {
    const { lo, hi } = this._trackX(box)
    return lo + Math.max(0, Math.min(1, value)) * Math.max(0, hi - lo)
  }

  // Convert a canvas-space point within the inspector button to client
  // coordinates for positioning the floating HTML inspector panel.
  private _inspectorClientPos(box: BBox): { cx: number; cy: number } {
    const btnCx = box.x + box.width - BTN_W / 2
    const btnCy = box.y + box.height / 2
    const el    = Node.canvasElement
    if (el === null) return { cx: btnCx, cy: btnCy }
    const rect   = el.getBoundingClientRect()
    const scaleX = rect.width  / Node.canvasWidth
    const scaleY = rect.height / Node.canvasHeight
    return {
      cx: rect.left + btnCx * scaleX,
      cy: rect.top  + btnCy * scaleY,
    }
  }

  // ── Hit zone ────────────────────────────────────────────────────

  hitZone(
    point: Point,
    row:   BBox,
  ): 'pause' | 'inspector' | 'handle' | 'slot' | null {
    const inRow = point.x >= row.x && point.x < row.x + row.width
               && point.y >= row.y && point.y < row.y + row.height
    if (!inRow) return null

    const box   = this.boxBounds(row)
    const inBox = point.x >= box.x && point.x < box.x + box.width
               && point.y >= box.y && point.y < box.y + box.height

    if (inBox) {
      if (point.x < box.x + BTN_W)              return 'pause'
      if (point.x >= box.x + box.width - BTN_W) return 'inspector'

      const tx = this._thumbX(box, this._getValue())
      if (Math.abs(point.x - tx) <= THUMB_R + HANDLE_HIT) return 'handle'
    }

    return 'slot'
  }

  // ── Interaction ─────────────────────────────────────────────────

  // Returns true when the event was consumed by a button or slider handle.
  // Returns false for 'slot' zone AND for button clicks when unbound —
  // both cases let InteractionSystem's slot-tap path fire naturally.
  handlePointerDown(point: Point, row: BBox): boolean {
    const zone  = this.hitZone(point, row)
    const state = this.slot.state

    if (zone === null || zone === 'slot') return false

    if (zone === 'pause') {
      if (state === SlotState.Unbound) return false   // → slot-tap (create binding)
      BindingLayer.findForSlot(this.slot)?.toggle()
      this._onChanged()
      return true
    }

    if (zone === 'inspector') {
      if (state === SlotState.Unbound) return false   // → slot-tap (create binding)
      const box = this.boxBounds(row)
      const { cx, cy } = this._inspectorClientPos(box)
      this.onInspectorRequest?.(this.slot, cx, cy)
      return true
    }

    // zone === 'handle'
    this._dragging = true
    this._applyDrag(point.x, row)
    return true
  }

  handlePointerMove(point: Point, row: BBox): void {
    if (this._dragging) this._applyDrag(point.x, row)
  }

  handlePointerUp(): void {
    this._dragging = false
  }

  private _applyDrag(px: number, row: BBox): void {
    const box       = this.boxBounds(row)
    const { lo, hi } = this._trackX(box)
    this._setValue(Math.max(0, Math.min(1, (px - lo) / Math.max(1e-6, hi - lo))))
  }

  // ── Rendering ───────────────────────────────────────────────────

  render(ctx: Ctx2D, row: BBox): void {
    const state = this.slot.state
    const box   = this.boxBounds(row)
    const midY  = row.y + row.height / 2
    const tc    = this._colour

    const drag = Node.bindDrag
    const isCompat = (drag.active && drag.source !== null && this.slot.type !== null
                      && drag.source.types.has(this.slot.type))
                  || (Node.fileDragActive && this.slot.type === ValueType.Image
                      && state === SlotState.Unbound)

    ctx.save()

    // Row label (omitted when labelWidth = 0)
    if (this._labelWidth > 0) {
      ctx.font         = '10px monospace'
      ctx.fillStyle    = 'rgba(255,255,255,0.62)'
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(this._label, row.x + 6, midY)
    }

    if (isCompat) {
      this._drawBox(ctx, box, 'rgba(50,200,70,0.18)', 'rgba(50,200,70,0.85)', 1.5, [])
      this._drawSlider(ctx, box, 0.35, 0.35, tc)
      ctx.font = '10px monospace'; ctx.fillStyle = 'rgba(100,255,120,0.75)'
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(
        this.slot.isActive ? 'replace binding' : 'drop to bind',
        box.x + BTN_W + 4, midY,
      )
      this._drawPauseBtn(ctx, box, midY, '○', 'rgba(100,255,120,0.50)')
      this._drawInspectorBtn(ctx, box, midY,
        this.slot.isActive ? '●' : '○', 'rgba(100,255,120,0.50)')
    } else if (state === SlotState.Bound) {
      this._drawBox(ctx, box, tc + '22', tc + 'cc', 1, [])
      this._drawSlider(ctx, box, 0.40, 0.70, tc)
      this._drawPauseBtn(ctx, box, midY, '⏸', tc)
      this._drawInspectorBtn(ctx, box, midY, '●', 'rgba(255,255,255,0.40)')
      const name = this._sourceName()
      ctx.font = '10px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.90)'
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(name, box.x + BTN_W + 4, midY)
    } else if (state === SlotState.SuspendedBound) {
      this._drawBox(ctx, box, tc + '11', 'rgba(255,255,255,0.40)', 1, [3, 3])
      this._drawSlider(ctx, box, 0.75, 0.75, tc)
      this._drawPauseBtn(ctx, box, midY, '▶', 'rgba(255,255,255,0.55)')
      this._drawInspectorBtn(ctx, box, midY, '●', 'rgba(255,255,255,0.30)')
      const name = this._sourceName()
      ctx.font = '10px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(name, box.x + BTN_W + 4, midY)
    } else {
      // Unbound — slider at full opacity; buttons show "add binding" affordance
      this._drawBox(ctx, box, 'transparent', 'rgba(255,255,255,0.32)', 1, [3, 3])
      this._drawSlider(ctx, box, 1.0, 1.0, tc)
      this._drawPauseBtn(ctx, box, midY, '○', 'rgba(255,255,255,0.35)')
      this._drawInspectorBtn(ctx, box, midY, '○', 'rgba(255,255,255,0.30)')
    }

    ctx.restore()
  }

  // ── Private helpers ─────────────────────────────────────────────

  private _sourceName(): string {
    return (this.slot.source as { debugName?: string } | null)?.debugName ?? '?'
  }

  private _drawBox(
    ctx: Ctx2D, box: BBox,
    fill: string, stroke: string, lineWidth: number, dash: number[],
  ): void {
    if (fill !== 'transparent') {
      ctx.fillStyle = fill
      ctx.beginPath(); ctx.roundRect(box.x, box.y, box.width, box.height, 4); ctx.fill()
    }
    ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.setLineDash(dash)
    ctx.beginPath()
    ctx.roundRect(box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1, 4)
    ctx.stroke()
    ctx.setLineDash([])
  }

  private _drawSlider(
    ctx: Ctx2D, box: BBox,
    trackAlpha: number, handleAlpha: number,
    colour: string,
  ): void {
    const value      = this._getValue()
    const { lo, hi } = this._trackX(box)
    const range      = Math.max(0, hi - lo)
    const tx         = lo + Math.max(0, Math.min(1, value)) * range
    const midY       = box.y + box.height / 2

    ctx.save()
    ctx.lineCap = 'round'

    ctx.globalAlpha = trackAlpha
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.lineWidth   = 3
    ctx.beginPath(); ctx.moveTo(lo, midY); ctx.lineTo(hi, midY); ctx.stroke()
    ctx.strokeStyle = colour
    ctx.beginPath(); ctx.moveTo(lo, midY); ctx.lineTo(tx, midY); ctx.stroke()

    ctx.globalAlpha = handleAlpha
    ctx.fillStyle = colour
    ctx.beginPath(); ctx.arc(tx, midY, THUMB_R, 0, Math.PI * 2); ctx.fill()

    ctx.restore()
  }

  private _drawPauseBtn(
    ctx: Ctx2D, box: BBox, midY: number, icon: string, colour: string,
  ): void {
    ctx.save()
    ctx.font = '9px monospace'; ctx.fillStyle = colour
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(icon, box.x + BTN_W / 2, midY)
    ctx.restore()
  }

  private _drawInspectorBtn(
    ctx: Ctx2D, box: BBox, midY: number, icon: string, colour: string,
  ): void {
    ctx.save()
    ctx.font = '9px monospace'; ctx.fillStyle = colour
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(icon, box.x + box.width - BTN_W / 2, midY)
    ctx.restore()
  }
}
