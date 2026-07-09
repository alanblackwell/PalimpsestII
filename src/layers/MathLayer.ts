import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type Amount, type AmountSource,
  type EventValue, type EventSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'
import { SliderSlot } from '../ui/SliderSlot.js'
import { contentLeft } from '../interaction/layout.js'

// ------------------------------------------------------------
// MathLayer — composable Amount transformation pipeline
// ------------------------------------------------------------
//
// A single Amount input is passed through a chain of enabled
// operations in top-to-bottom order.  Pills flow into two
// columns when they exceed the column height.  Each pill has:
//
//   ≡  drag handle    — drag vertically to reorder (row 1)
//   [name]            — operation label (row 1)
//   event indicator   — Event slot to toggle enable state (row 1)
//   preview bar       — running value after this step (row 1)
//   ◉  enable toggle  — manual on/off (row 2)
//   [══]  slider      — operation parameter; Amount slot (row 2)
//
// A vertical level-meter at the right of the display area shows
// the final output value (edit-mode only; not composited).

// ── Operation definitions ──────────────────────────────────────────────

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))

interface MathOpDef {
  readonly label:    string
  readonly defaultP: number   // default parameter in [0, 1]
  readonly fn:       (v: number, t: number) => number
}

const MATH_OPS: readonly MathOpDef[] = [
  // t=0.5 → ×1 (neutral); slider controls multiplier 0–2×
  { label: 'scale',    defaultP: 0.5,  fn: (v, t) => clamp01(v * t * 2) },
  // t=0.5 → +0 (neutral); slider shifts value ±0.5
  { label: 'offset',   defaultP: 0.5,  fn: (v, t) => clamp01(v + t - 0.5) },
  // t=0.5 → ^1 (linear); t<0.5 → root (bright), t>0.5 → exponent (dark)
  { label: 'power',    defaultP: 0.5,  fn: (v, t) => Math.pow(Math.max(0, v), Math.pow(4, 2*t - 1)) },
  // t=0 → passthrough; t=1 → full invert (1−v); blends continuously
  { label: 'invert',   defaultP: 1,    fn: (v, t) => v + (1 - 2*v) * t },
  // t=0 → linear; t=1 → S-curve smoothstep; blends continuously
  { label: 'smooth',   defaultP: 1,    fn: (v, t) => v*(1-t) + v*v*(3-2*v)*t },
  // triangle-wave fold; slider controls frequency (1–8 folds)
  { label: 'fold',     defaultP: 0.14, fn: (v, t) => { const f = Math.round(1 + t*7); return 1 - Math.abs(2 * ((v*f) % 1) - 1) } },
  // quantise to N levels; t=0 → 2 levels (binary), t=1 → 32 levels
  { label: 'quantize', defaultP: 8/30,  fn: (v, t) => { const n = Math.max(2, Math.round(t*30 + 2)); return Math.round(v*n)/n } },
  // upper clamp: min(v, t); t=1 → passthrough
  { label: 'min',      defaultP: 1,    fn: (v, t) => Math.min(v, t) },
  // lower clamp: max(v, t); t=0 → passthrough
  { label: 'max',      defaultP: 0,    fn: (v, t) => Math.max(v, t) },
  // sine-wave mapping; slider controls frequency (1–8 periods)
  { label: 'sin',      defaultP: 0,    fn: (v, t) => (Math.sin(v * Math.PI * 2 * (1 + Math.round(t*7))) + 1) / 2 },
]

// ── Per-row state ──────────────────────────────────────────────────────

interface MathRow {
  readonly def:        MathOpDef
  enabled:             boolean
  paramValue:          number
  previewValue:        number   // running output value after this row (updated in recompute)
  readonly enableSlot: ParameterSlot
  readonly paramSlot:  ParameterSlot
  lastEventTime:       EventValue
  sliderWidget:        SliderSlot
}

// ── Layout constants ───────────────────────────────────────────────────

const ACCENT   = '#4a8fe8'   // Amount type colour
const EV_COL   = '#e0e060'   // Event type colour

const PY0      = 50     // pill column top
const PGAP     = 4      // gap between pills
const SLT_H    = 26     // input slot row height

// Two-row pill layout (matching FilterLayer):
const ROW_H    = 26
const ROW_PAD  = 3
const ROW_GAP  = 3
const PH       = ROW_PAD + ROW_H + ROW_GAP + ROW_H + ROW_PAD  // = 61

// Pill width limits and column gap (matching FilterLayer):
const PW_MAX       = 260
const PW_MIN       = 190
const COL_GAP      = 16
const RIGHT_MARGIN = 12

// Left side (relative to pill's left edge):
const STRIPE   = 4
const DRAG_OX  = STRIPE + 4    // = 8 — left edge of drag/button column
const BTN_W    = 22             // toggle button / drag-handle hit width
const DRAG_W   = 14             // drag-bar drawing width (centred in BTN_W)
const SLT_X    = DRAG_OX + BTN_W + 4   // = 34 — name/slider content left edge

// Right side (relative to pill right edge inward):
const RPAD     = 8

// Row 1 — amount preview bar (far right):
const PREV_W   = 52
const PREV_H   = 20
const PREV_GAP = 4      // gap between event indicator and preview bar

// Row 1 — event-slot indicator:
const EV_IND_W   = 52
const EV_IND_GAP = 4    // gap between name clip and indicator
const EV_BTN_W   = 16   // ⏸/▶ button within the indicator

// Output visualisation (renderOverlay only — not composited):
const VIS_MARGIN = 20   // gap from right edge of viewport
const BAR_W      = 18   // vertical bar width
const TICK_W     = 5    // tick mark length

type BBox = { x: number; y: number; width: number; height: number }

// ── MathLayer ──────────────────────────────────────────────────────────

export class MathLayer extends Layer implements AmountSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Amount])

  private readonly _inputSlot: ParameterSlot
  private readonly _rows: MathRow[]
  private _inputManualValue = 0.5
  private _inputSliderWidget!: SliderSlot

  private _result:     Amount = 0
  private _inputValue: number = 0

  // Drag-to-reorder state
  private _dragRow:     number = -1
  private _dragOffsetX: number = 0
  private _dragOffset:  number = 0
  private _dragX:       number = 0
  private _dragY:       number = 0
  private _dragTarget:  number = -1

  // Slot hit-test bounds populated during renderPanel
  private _rowSlotBounds = new Map<ParameterSlot, BBox>()

  constructor() {
    super()
    this._inputSlot = new ParameterSlot(ValueType.Amount, this, 'input')
    this._inputSliderWidget = new SliderSlot(
      this._inputSlot, 'input', ACCENT,
      () => this._inputSlot.isActive
        ? (this._inputSlot.source as AmountSource).getAmount() as number
        : this._inputManualValue,
      v => {
        if (this._inputSlot.state === SlotState.Bound) BindingLayer.findForSlot(this._inputSlot)?.toggle()
        this._inputManualValue = v
        this.markDirty()
      },
      () => this.markDirty(),
      40,
    )

    this._rows = MATH_OPS.map(def => {
      const enableSlot = new ParameterSlot(ValueType.Event,  this, def.label + ' toggle')
      const paramSlot  = new ParameterSlot(ValueType.Amount, this, def.label + ' amount')
      const row: MathRow = {
        def,
        enabled:       false,
        paramValue:    def.defaultP,
        previewValue:  0,
        enableSlot,
        paramSlot,
        lastEventTime: null,
        sliderWidget:  null!,
      }
      row.sliderWidget = new SliderSlot(
        paramSlot, '', ACCENT,
        () => paramSlot.isActive
          ? (paramSlot.source as AmountSource).getAmount() as number
          : row.paramValue,
        v => {
          if (paramSlot.state === SlotState.Bound) BindingLayer.findForSlot(paramSlot)?.toggle()
          if (!row.enabled) {
            if (enableSlot.state === SlotState.Bound) BindingLayer.findForSlot(enableSlot)?.toggle()
            row.enabled = true
          }
          row.paramValue = v
          this.markDirty()
        },
        () => this.markDirty(),
        0,   // no label column — label is in the pill
      )
      return row
    })

    // Slots registered for persistence; rendering is handled in renderPanel.
    this.slots.push(this._inputSlot)
    for (const row of this._rows) this.slots.push(row.enableSlot, row.paramSlot)

    this.displayBaseName = 'Calculate'
    this.debugName = 'Calculate'
    graph.register(this)
  }

  // Custom pill layout renders all slots — suppress the generic slot pill.
  override renderSlots(_ctx: Ctx2D): void {}

  // ── AmountSource ─────────────────────────────────────────────────────

  getAmount(): Amount { return this._result }

  // ── Accessors ────────────────────────────────────────────────────────

  get inputSlot(): ParameterSlot { return this._inputSlot }

  wireSliderInspectors(fn: (slot: ParameterSlot, cx: number, cy: number) => void): void {
    this._inputSliderWidget.onInspectorRequest = fn
    for (const row of this._rows) row.sliderWidget.onInspectorRequest = fn
  }

  override getSlotDefault(slot: ParameterSlot): Point | number | null {
    for (const row of this._rows) {
      if (slot === row.paramSlot) return row.paramValue
    }
    return null
  }

  override autoBindRules() {
    return [{
      slot:    this._inputSlot,
      accepts: (l: Layer) => l.types.has(ValueType.Amount),
    }]
  }

  // ── Persistence ──────────────────────────────────────────────────────

  override serializeState(): Record<string, unknown> {
    return {
      inputManualValue: this._inputManualValue,
      rows: this._rows.map(row => ({
        label:      row.def.label,
        enabled:    row.enabled,
        paramValue: row.paramValue,
      })),
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.inputManualValue === 'number') this._inputManualValue = state.inputManualValue
    if (!Array.isArray(state.rows)) return
    const byLabel = new Map(this._rows.map(row => [row.def.label, row]))
    const reordered: MathRow[] = []
    for (const entry of state.rows as Array<Record<string, unknown>>) {
      const row = typeof entry.label === 'string' ? byLabel.get(entry.label) : undefined
      if (!row) continue
      if (typeof entry.enabled === 'boolean')   row.enabled    = entry.enabled
      if (typeof entry.paramValue === 'number') row.paramValue = entry.paramValue
      byLabel.delete(row.def.label)
      reordered.push(row)
    }
    // Rows absent from the save (e.g. new ops added later) keep defaults.
    for (const row of byLabel.values()) reordered.push(row)
    this._rows.length = 0
    this._rows.push(...reordered)
  }

  // ── Node ─────────────────────────────────────────────────────────────

  override evaluate(): void {
    for (const row of this._rows) {
      if (row.enableSlot.isActive) row.enableSlot.source!.evaluate()
      if (row.paramSlot.isActive)  row.paramSlot.source!.evaluate()
    }
    super.evaluate()
  }

  protected recompute(): void {
    for (const row of this._rows) {
      if (row.enableSlot.isActive) {
        const t = (row.enableSlot.source as EventSource).getEventTime()
        if (t !== null && t !== row.lastEventTime) {
          row.lastEventTime = t
          row.enabled = !row.enabled
        }
      }
      if (row.paramSlot.isActive) {
        row.paramValue = (row.paramSlot.source as AmountSource).getAmount()
      }
    }

    this._inputValue = this._inputSlot.isActive
      ? (this._inputSlot.source as AmountSource).getAmount()
      : this._inputManualValue

    let v = this._inputValue
    for (const row of this._rows) {
      if (row.enabled) v = row.def.fn(v, row.paramValue)
      row.previewValue = v   // accumulated output up to and including this row
    }
    this._result = v
  }

  // ── Layout helpers ────────────────────────────────────────────────────

  // Always target two columns; fall back to one if pills-per-col height
  // doesn't fit two columns on screen.
  private _pillsPerCol(): number {
    return Math.max(1, Math.ceil(this._rows.length / 2))
  }

  private _layout(): { panX: number; pillW: number; ppc: number } {
    const canvasW = Node.viewportWidth
    const left    = contentLeft(canvasW)
    const availW  = Math.max(PW_MIN + 4, canvasW - left - RIGHT_MARGIN)

    const ppc  = this._pillsPerCol()
    const cols = Math.max(1, Math.ceil(this._rows.length / ppc))

    const totalGap = (cols - 1) * COL_GAP
    let pillW = PW_MAX
    if (cols * PW_MAX + totalGap > availW) {
      pillW = Math.max(PW_MIN, (availW - totalGap) / cols)
    }

    const gridW = cols * pillW + totalGap
    const panX  = left + Math.max(0, (availW - gridW) / 2)

    return { panX, pillW, ppc }
  }

  private _pillX(i: number, panX: number, pillW: number, ppc: number): number {
    return panX + Math.floor(i / ppc) * (pillW + COL_GAP)
  }
  private _pillY(i: number, ppc: number): number {
    return PY0 + (i % ppc) * (PH + PGAP)
  }

  // ── Rendering ────────────────────────────────────────────────────────

  override get panelBottom(): number {
    const ppc   = this._pillsPerCol()
    const nRows = Math.min(this._rows.length, ppc)
    return PY0 + nRows * (PH + PGAP) - PGAP + 8
  }

  renderPanel(ctx: Ctx2D): void {
    this._rowSlotBounds.clear()

    const N = this._rows.length
    const { panX, pillW, ppc } = this._layout()
    const srcY = PY0 - SLT_H - PGAP

    ctx.save()

    // ── Input slot row (above column 0) ──────────────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.40)'
    ctx.beginPath(); ctx.roundRect(panX, srcY, pillW, SLT_H, 6); ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath(); ctx.roundRect(panX, srcY, STRIPE, SLT_H, [3, 0, 0, 3]); ctx.fill()
    const inputBounds: BBox = { x: panX + STRIPE + 4, y: srcY, width: pillW - STRIPE - 4 - RPAD, height: SLT_H }
    this._inputSliderWidget.render(ctx, inputBounds)
    this._rowSlotBounds.set(this._inputSlot, { x: panX, y: srcY, width: pillW, height: SLT_H })

    // ── Operation pills ───────────────────────────────────────────
    for (let i = 0; i < N; i++) {
      const row  = this._rows[i]!
      const colX = this._pillX(i, panX, pillW, ppc)
      const py   = this._pillY(i, ppc)

      if (this._dragRow === i) {
        ctx.globalAlpha = 0.25
        this._drawPill(ctx, row, colX, py, pillW, false)
        ctx.globalAlpha = 1
      } else {
        this._drawPill(ctx, row, colX, py, pillW, true)
      }
    }

    // Floating dragged pill + drop-target outline
    if (this._dragRow >= 0 && this._dragRow < N) {
      this._drawPill(ctx, this._rows[this._dragRow]!, this._dragX, this._dragY, pillW, false)
      if (this._dragTarget >= 0 && this._dragTarget !== this._dragRow) {
        const tx = this._pillX(this._dragTarget, panX, pillW, ppc)
        const ty = this._pillY(this._dragTarget, ppc)
        ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; ctx.setLineDash([4, 4])
        ctx.beginPath(); ctx.roundRect(tx + 2, ty + 2, pillW - 4, PH - 4, 5); ctx.stroke()
        ctx.setLineDash([])
      }
    }

    ctx.restore()
  }

  // Output level-meter: vertical bar with axis — edit-mode only, not composited.
  override renderOverlay(ctx: Ctx2D): void {
    super.renderOverlay(ctx)

    const value  = Math.max(0, Math.min(1, this._result))
    const ppc    = this._pillsPerCol()
    const nRows  = Math.min(this._rows.length, ppc)
    const barH   = nRows * (PH + PGAP) - PGAP
    const barTop = PY0
    const barX   = Node.viewportWidth - VIS_MARGIN - BAR_W
    // Axis sits to the left of the bar: tick right edge at barX - AXIS_GAP,
    // label right edge at tick left edge.
    const axisCol = 'rgba(0,0,0,0.28)'   // matches disabled-pill background
    const tickR   = barX - BAR_W          // axis is one bar-width left of the bar
    const tickL   = tickR - TICK_W
    const labelR  = tickL - 3

    ctx.save()

    // Axis line
    ctx.strokeStyle = axisCol
    ctx.lineWidth = 1; ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(tickR, barTop); ctx.lineTo(tickR, barTop + barH)
    ctx.stroke()

    // 11 ticks at 0.1 intervals; numeric label only at 0.0 and 1.0
    ctx.font = '9px monospace'
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    ctx.fillStyle = axisCol
    for (let i = 0; i <= 10; i++) {
      const t  = i / 10
      const ty = barTop + barH - t * barH
      ctx.fillRect(tickL, ty - 0.5, TICK_W, 1)
      if (i === 0 || i === 10) ctx.fillText(t.toFixed(1), labelR, ty)
    }

    // Bar fill with drop shadow (no track background, no border)
    const fillH = value * barH
    const fillY = barTop + barH - fillH
    if (fillH > 0.5) {
      ctx.save()
      ctx.shadowColor   = ACCENT + 'aa'
      ctx.shadowBlur    = 10
      ctx.shadowOffsetX = 2
      ctx.shadowOffsetY = 4
      ctx.fillStyle = ACCENT
      ctx.beginPath()
      ctx.roundRect(barX, fillY, BAR_W, fillH, fillH >= barH ? 3 : [0, 0, 3, 3])
      ctx.fill()
      ctx.restore()
    }

    // Floating value label — constant distance above fill top, can go above axis
    const labelY = fillY - 4
    ctx.font = 'bold 11px monospace'
    ctx.fillStyle = ACCENT
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
    ctx.fillText(value.toFixed(2), barX + BAR_W / 2, labelY)

    ctx.restore()
  }

  // ── Interaction ───────────────────────────────────────────────────────

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    const { panX, pillW, ppc } = this._layout()
    const N      = this._rows.length
    const cols   = Math.max(1, Math.ceil(N / ppc))
    const nRows  = Math.min(N, ppc)
    const srcY   = PY0 - SLT_H - PGAP
    const totalW = cols * (pillW + COL_GAP) - COL_GAP
    const totalH = nRows * (PH + PGAP) - PGAP
    return (point.x >= panX && point.x <= panX + totalW &&
            point.y >= srcY && point.y <= PY0 + totalH) ? this : null
  }

  override hitTestSlot(point: Point): ParameterSlot | null {
    const base = super.hitTestSlot(point)
    if (base !== null) return base
    for (const [slot, b] of this._rowSlotBounds) {
      if (boundingBoxContains(b, point)) return slot
    }
    return null
  }

  handlePointerDown(point: Point): boolean {
    const N = this._rows.length
    const { panX, pillW, ppc } = this._layout()
    const srcY = PY0 - SLT_H - PGAP
    if (point.y >= srcY && point.y < srcY + SLT_H && point.x >= panX && point.x < panX + pillW) {
      const inputBounds: BBox = { x: panX + STRIPE + 4, y: srcY, width: pillW - STRIPE - 4 - RPAD, height: SLT_H }
      if (this._inputSliderWidget.handlePointerDown(point, inputBounds)) return true
      return false   // slot-click for inputSlot
    }
    for (let i = 0; i < N; i++) {
      const row  = this._rows[i]!
      const colX = this._pillX(i, panX, pillW, ppc)
      const py   = this._pillY(i, ppc)
      if (point.x < colX || point.x > colX + pillW) continue
      if (point.y < py   || point.y > py + PH) continue

      const r1Y = py + ROW_PAD
      const r2Y = r1Y + ROW_H + ROW_GAP

      if (point.y < r2Y) {
        // ── Row 1: drag handle | name | event indicator | preview ──
        if (point.x >= colX + DRAG_OX && point.x < colX + DRAG_OX + BTN_W) {
          this._dragRow     = i
          this._dragOffsetX = point.x - colX
          this._dragOffset  = point.y - py
          this._dragX       = colX
          this._dragY       = py
          this._dragTarget  = i
          this.markDirty()
          return true
        }
        const thumbL = colX + pillW - RPAD - PREV_W
        const evIndX = thumbL - PREV_GAP - EV_IND_W
        if (point.x >= evIndX && point.x < thumbL) {
          const hasBinding = row.enableSlot.isActive || row.enableSlot.state === SlotState.SuspendedBound
          if (hasBinding && point.x >= evIndX + EV_IND_W - EV_BTN_W) {
            this._handleToggle(row)
            return true
          }
          return false   // slot-click for enableSlot
        }
        return true   // consume other row-1 clicks
      }

      // ── Row 2: toggle button | SliderSlot ────────────────────────
      if (point.x >= colX + DRAG_OX && point.x < colX + DRAG_OX + BTN_W) {
        this._handleToggle(row)
        return true
      }
      const slotRow: BBox = { x: colX + SLT_X, y: r2Y, width: pillW - SLT_X - RPAD, height: ROW_H }
      if (row.sliderWidget.handlePointerDown(point, slotRow)) return true
      return false   // slot-click for paramSlot
    }
    return false   // input slot row → slot-click for inputSlot
  }

  handlePointerMove(point: Point): void {
    const { panX, pillW, ppc } = this._layout()

    if (this._dragRow >= 0) {
      const N = this._rows.length
      this._dragX = point.x - this._dragOffsetX
      this._dragY = point.y - this._dragOffset
      let bestIdx = 0, bestDist = Infinity
      for (let i = 0; i < N; i++) {
        const cx = this._pillX(i, panX, pillW, ppc) + pillW / 2
        const cy = this._pillY(i, ppc) + PH / 2
        const d  = (this._dragX + pillW / 2 - cx) ** 2 + (this._dragY + PH / 2 - cy) ** 2
        if (d < bestDist) { bestDist = d; bestIdx = i }
      }
      this._dragTarget = bestIdx
      this.markDirty()
      return
    }

    const srcY = PY0 - SLT_H - PGAP
    const inputBounds: BBox = { x: panX + STRIPE + 4, y: srcY, width: pillW - STRIPE - 4 - RPAD, height: SLT_H }
    this._inputSliderWidget.handlePointerMove(point, inputBounds)
    for (let i = 0; i < this._rows.length; i++) {
      const colX = this._pillX(i, panX, pillW, ppc)
      const py   = this._pillY(i, ppc)
      const r2Y  = py + ROW_PAD + ROW_H + ROW_GAP
      const slotRow: BBox = { x: colX + SLT_X, y: r2Y, width: pillW - SLT_X - RPAD, height: ROW_H }
      this._rows[i]!.sliderWidget.handlePointerMove(point, slotRow)
    }
  }

  handlePointerUp(): void {
    if (this._dragRow >= 0) {
      const tgt = this._dragTarget, src = this._dragRow
      if (tgt !== src && tgt >= 0) {
        const row = this._rows.splice(src, 1)[0]!
        this._rows.splice(tgt, 0, row)
        this.markDirty()
      }
      this._dragRow    = -1
      this._dragTarget = -1
    }
    this._inputSliderWidget.handlePointerUp()
    for (const row of this._rows) row.sliderWidget.handlePointerUp()
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private _handleToggle(row: MathRow): void {
    if (row.enableSlot.state === SlotState.Bound) row.enableSlot.suspend()
    row.enabled = !row.enabled
    this.markDirty()
  }

  private _drawPill(
    ctx: Ctx2D, row: MathRow, colX: number, py: number, pillW: number, registerSlots: boolean,
  ): void {
    const enabled = row.enabled
    const r1Y     = py + ROW_PAD
    const r2Y     = r1Y + ROW_H + ROW_GAP
    const r1MidY  = r1Y + ROW_H / 2

    // ── Pill background ───────────────────────────────────────────
    ctx.fillStyle = enabled ? 'rgba(0,0,0,0.50)' : 'rgba(0,0,0,0.28)'
    ctx.beginPath(); ctx.roundRect(colX, py, pillW, PH, 6); ctx.fill()

    // ── Accent stripe ─────────────────────────────────────────────
    ctx.fillStyle = enabled ? ACCENT : 'rgba(74,143,232,0.28)'
    ctx.beginPath(); ctx.roundRect(colX, py, STRIPE, PH, [3, 0, 0, 3]); ctx.fill()

    // ── Row 1: drag handle ────────────────────────────────────────
    const dhMidX = colX + DRAG_OX + BTN_W / 2
    ctx.fillStyle = 'rgba(255,255,255,0.22)'
    for (let d = 0; d < 3; d++) {
      ctx.fillRect(dhMidX - DRAG_W / 2, r1MidY - 4 + d * 4, DRAG_W, 2)
    }

    // ── Row 1: event-slot indicator ───────────────────────────────
    const thumbL  = colX + pillW - RPAD - PREV_W
    const evIndX  = thumbL - PREV_GAP - EV_IND_W
    const evIndY  = r1Y + 3
    const evIndH  = ROW_H - 6
    this._drawEventIndicator(ctx, row.enableSlot, evIndX, evIndY, EV_IND_W, evIndH)
    if (registerSlots) {
      this._rowSlotBounds.set(row.enableSlot, { x: evIndX, y: r1Y, width: EV_IND_W, height: ROW_H })
    }

    // ── Row 1: op name (clipped) ──────────────────────────────────
    const nameMaxW = evIndX - EV_IND_GAP - (colX + SLT_X)
    ctx.save()
    ctx.beginPath(); ctx.rect(colX + SLT_X, r1Y, nameMaxW, ROW_H); ctx.clip()
    ctx.font = 'bold 10px monospace'
    ctx.fillStyle = enabled ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0.55)'
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText(row.def.label, colX + SLT_X, r1MidY)
    ctx.restore()

    // ── Row 1: amount preview bar ─────────────────────────────────
    const prevX = thumbL
    const prevY = r1Y + (ROW_H - PREV_H) / 2
    this._drawPreviewBar(ctx, row.previewValue, prevX, prevY, PREV_W, PREV_H, enabled)

    // ── Row 2: toggle button ──────────────────────────────────────
    this._drawToggle(ctx, colX + DRAG_OX, r2Y + (ROW_H - BTN_W) / 2, BTN_W, row)

    // ── Row 2: SliderSlot ─────────────────────────────────────────
    const slotRow: BBox = { x: colX + SLT_X, y: r2Y, width: pillW - SLT_X - RPAD, height: ROW_H }
    if (registerSlots) this._rowSlotBounds.set(row.paramSlot, slotRow)
    row.sliderWidget.render(ctx, slotRow)

    ctx.textBaseline = 'alphabetic'
  }

  private _drawPreviewBar(
    ctx: Ctx2D, value: number,
    x: number, y: number, w: number, h: number,
    enabled: boolean,
  ): void {
    ctx.save()
    if (!enabled) ctx.globalAlpha = 0.45

    const fillW = Math.max(0, Math.min(1, value)) * w

    ctx.fillStyle = 'rgba(255,255,255,0.06)'
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 3); ctx.fill()

    if (fillW > 0.5) {
      ctx.fillStyle = ACCENT + '55'
      ctx.save()
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 3); ctx.clip()
      ctx.fillRect(x, y, fillW, h)
      ctx.restore()
    }

    ctx.strokeStyle = enabled ? ACCENT + '88' : 'rgba(255,255,255,0.15)'
    ctx.lineWidth = 1; ctx.setLineDash([])
    ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 3); ctx.stroke()

    ctx.font = '9px monospace'
    ctx.fillStyle = enabled ? 'rgba(255,255,255,0.90)' : 'rgba(255,255,255,0.55)'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(value.toFixed(3), x + w / 2, y + h / 2)

    ctx.restore()
  }

  private _drawToggle(ctx: Ctx2D, bx: number, by: number, sz: number, row: MathRow): void {
    const { enabled, enableSlot } = row
    const bound = enableSlot.isActive
    const susp  = enableSlot.state === SlotState.SuspendedBound

    ctx.fillStyle = enabled
      ? (bound ? 'rgba(224,224,96,0.22)' : 'rgba(74,143,232,0.22)')
      : 'rgba(255,255,255,0.04)'
    ctx.beginPath(); ctx.roundRect(bx, by, sz, sz, 4); ctx.fill()

    if (bound) {
      ctx.strokeStyle = EV_COL; ctx.lineWidth = 1.5; ctx.setLineDash([])
    } else if (susp) {
      ctx.strokeStyle = EV_COL + 'cc'; ctx.lineWidth = 1; ctx.setLineDash([2, 2])
    } else if (enabled) {
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5; ctx.setLineDash([])
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([])
    }
    ctx.beginPath(); ctx.roundRect(bx + 0.5, by + 0.5, sz - 1, sz - 1, 4); ctx.stroke()
    ctx.setLineDash([])

    ctx.fillStyle = enabled ? (bound ? EV_COL : ACCENT) : 'rgba(255,255,255,0.18)'
    ctx.beginPath(); ctx.arc(bx + sz/2, by + sz/2, 5, 0, Math.PI * 2); ctx.fill()
  }

  private _drawEventIndicator(
    ctx: Ctx2D, slot: ParameterSlot, x: number, y: number, w: number, h: number,
  ): void {
    const isCompat = Node.bindDrag.active && Node.bindDrag.source !== null
                  && slot.type !== null && Node.bindDrag.source.types.has(slot.type)
    const midY  = y + h / 2
    const btnX  = x + w - EV_BTN_W
    const nameW = w - EV_BTN_W - 3
    ctx.save()
    ctx.font = '9px monospace'; ctx.textBaseline = 'middle'

    if (isCompat) {
      ctx.fillStyle = 'rgba(50,200,70,0.18)'
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 3); ctx.fill()
      ctx.strokeStyle = 'rgba(50,200,70,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([])
      ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 3); ctx.stroke()
    } else if (slot.isActive) {
      const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
      ctx.fillStyle = EV_COL + '22'
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 3); ctx.fill()
      ctx.strokeStyle = EV_COL + 'cc'; ctx.lineWidth = 1; ctx.setLineDash([])
      ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 3); ctx.stroke()
      ctx.fillStyle = EV_COL; ctx.textAlign = 'left'
      ctx.save(); ctx.beginPath(); ctx.rect(x + 3, y, nameW, h); ctx.clip()
      ctx.fillText(srcName, x + 3, midY)
      ctx.restore()
      ctx.fillStyle = EV_COL + 'cc'; ctx.textAlign = 'center'
      ctx.fillText('⏸', btnX + EV_BTN_W / 2, midY)
    } else if (slot.state === SlotState.SuspendedBound) {
      const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1; ctx.setLineDash([2, 2])
      ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 3); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.textAlign = 'left'
      ctx.save(); ctx.beginPath(); ctx.rect(x + 3, y, nameW, h); ctx.clip()
      ctx.fillText(srcName, x + 3, midY)
      ctx.restore()
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.textAlign = 'center'
      ctx.fillText('▶', btnX + EV_BTN_W / 2, midY)
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.setLineDash([2, 2])
      ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 3); ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.restore()
  }
}
