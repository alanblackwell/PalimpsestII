import { Layer }          from '../core/Layer.js'
import { Node }           from '../core/Node.js'
import { ParameterSlot }  from '../core/ParameterSlot.js'
import {
  ValueType, SlotState, boundingBoxContains,
  type Ctx2D, type Point, type EventSource,
} from '../core/types.js'
import { graph }          from '../dataflow/Graph.js'
import { BindingLayer }   from './BindingLayer.js'
import { drawLayerThumbnail, typeColor } from '../interaction/thumbnail.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'

// ── Layout constants ──────────────────────────────────────────────────────
const THUMB_SZ = 40
const ROW_H    = 52
const ROW_GAP  = 4
const PILL_PAD = 8
const BTN_W    = 22
const BTN_H    = 22
const BTN_GAP  = 4
const RIGHT_M  = 6

type BB = { x: number; y: number; width: number; height: number }

// ── BindingMapLayer ───────────────────────────────────────────────────────
//
// Visualises all outgoing bindings from one source node. Each row shows a
// consumer thumbnail with a toggle [⊙] and delete [×]. Event slots are
// rendered below the diagram in a standard slot-group pill — they use the
// full standard ParameterSlot appearance and interaction:
//   • click empty slot → creates an EventLayer bound to that slot
//   • right-click bound slot → standard binding inspector popup
//
// Canvas-space layout (selected layer):
//
//   ┌────────────────────────────────────────────────┐  diagram pill
//   │ [Source Thumb]  SourceName          [⊙]  [×]  │
//   │       │                                        │
//   │  ──▶  [Sink1]  Consumer · slot      [⊙]  [×]  │
//   │  ──▶  [Sink2]  Consumer · slot      [⊙]  [×]  │
//   └────────────────────────────────────────────────┘
//   ┌────────────────────────────────────────────────┐  standard slot pill
//   │  master event  [ unbound / Source Name ]       │
//   │  Sink1 · slot  [ unbound / Source Name ]       │
//   │  Sink2 · slot  [ unbound / Source Name ]       │
//   └────────────────────────────────────────────────┘
//
// Slot serialisation:
//   slots[0]  _sourceSlot     (null-typed) — source ref for persistence
//   slots[1]  masterEventSlot (Event)      — serialised
//   Per-binding event slots are ephemeral (created in recompute, not serialised).

export class BindingMapLayer extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set()

  // Null-typed reference slot — raw bind to the source, serialised via slotList.
  private readonly _sourceSlot: ParameterSlot

  // Master event slot — when an event fires, applies master-toggle to all
  // bindings and suspends all per-binding event slots.
  readonly masterEventSlot: ParameterSlot

  // Per-binding event slots keyed by BindingLayer — created dynamically in
  // recompute(), removed when a binding disappears. NOT in this.slots[].
  private readonly _bindingEvtSlots = new Map<BindingLayer, ParameterSlot>()

  // Last-seen event times for new-event detection.
  private _masterLastEvt: number | null = null
  private readonly _bindingLastEvts = new Map<BindingLayer, number | null>()

  // Hit-test bounds for the diagram pill (populated in renderPanel).
  private _pillBounds:     BB | null = null
  private _masterThumbBB:  BB | null = null
  private _masterToggleBB: BB | null = null
  private _masterDeleteBB: BB | null = null
  private readonly _bindThumbBB  = new Map<BindingLayer, BB>()
  private readonly _bindToggleBB = new Map<BindingLayer, BB>()
  private readonly _bindDeleteBB = new Map<BindingLayer, BB>()

  constructor(source: Node | null = null) {
    super()
    this._sourceSlot    = new ParameterSlot(null, this, '_source')
    this.masterEventSlot = new ParameterSlot(ValueType.Event, this, 'master event')
    this.slots.push(this._sourceSlot, this.masterEventSlot)
    if (source !== null) this._sourceSlot.bind(source)
    graph.register(this)
  }

  private get _source(): Node | null { return this._sourceSlot.source }

  // All BindingLayers currently flowing from _source.
  private _getBindings(): BindingLayer[] {
    const src = this._source
    if (src === null) return []
    const out: BindingLayer[] = []
    for (const node of graph.nodes) {
      if (node instanceof BindingLayer && node.source === src) out.push(node)
    }
    return out
  }

  // Keep per-binding event slots in sync with the live binding list.
  private _syncSlots(bindings: BindingLayer[]): void {
    const live = new Set(bindings)
    for (const [bl, slot] of this._bindingEvtSlots) {
      if (!live.has(bl)) {
        BindingLayer.findForSlot(slot)?.remove()
        this._bindingEvtSlots.delete(bl)
        this._bindingLastEvts.delete(bl)
      }
    }
    for (const bl of bindings) {
      if (!this._bindingEvtSlots.has(bl)) {
        const owner = bl.slot.owner instanceof Layer ? bl.slot.owner.debugName : ''
        const lbl   = owner ? owner + ' · ' + bl.slot.label : bl.slot.label
        this._bindingEvtSlots.set(bl, new ParameterSlot(ValueType.Event, this, lbl))
        this._bindingLastEvts.set(bl, null)
      }
    }
  }

  // Enable-all or disable-all; suspends all per-binding event slots.
  private _masterToggle(bindings: BindingLayer[]): void {
    const anyOn = bindings.some(b => b.enabled)
    for (const b of bindings) {
      if (anyOn  &&  b.enabled) b.toggle()
      if (!anyOn && !b.enabled) b.toggle()
    }
    for (const [, slot] of this._bindingEvtSlots) {
      if (slot.state === SlotState.Bound) slot.suspend()
    }
    this.markDirty()
  }

  // Toggle one binding; suspends its event slot.
  private _toggleBinding(bl: BindingLayer): void {
    bl.toggle()
    const slot = this._bindingEvtSlots.get(bl)
    if (slot?.state === SlotState.Bound) slot.suspend()
    this.markDirty()
  }

  // Remove a binding and its per-binding event slot / BindingLayer.
  private _deleteBinding(bl: BindingLayer): void {
    const evtSlot = this._bindingEvtSlots.get(bl)
    if (evtSlot !== undefined) {
      BindingLayer.findForSlot(evtSlot)?.remove()
      this._bindingEvtSlots.delete(bl)
      this._bindingLastEvts.delete(bl)
    }
    bl.remove()
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Node — evaluation
  // ----------------------------------------------------------

  // Pull per-binding event sources (not in this.slots[]) before super evaluates.
  override evaluate(): void {
    for (const [, slot] of this._bindingEvtSlots) {
      if (slot.isActive) slot.source!.evaluate()
    }
    super.evaluate()
  }

  protected recompute(): void {
    const bindings = this._getBindings()
    this._syncSlots(bindings)

    // Master event slot: detect new event → trigger master toggle.
    if (this.masterEventSlot.isActive) {
      const t = (this.masterEventSlot.source as EventSource).getEventTime()
      if (t !== this._masterLastEvt) {
        this._masterLastEvt = t
        if (t !== null) this._masterToggle(bindings)
      }
    }

    // Per-binding event slots: detect new events.
    for (const [bl, slot] of this._bindingEvtSlots) {
      if (slot.isActive) {
        const t    = (slot.source as EventSource).getEventTime()
        const last = this._bindingLastEvts.get(bl) ?? null
        if (t !== last) {
          this._bindingLastEvts.set(bl, t)
          if (t !== null) this._toggleBinding(bl)
        }
      }
    }
  }

  // ----------------------------------------------------------
  // Rendering — diagram pill
  // ----------------------------------------------------------

  override renderPanel(ctx: Ctx2D): void {
    // Reset diagram hit-test bounds — repopulated below.
    this._pillBounds     = null
    this._masterThumbBB  = null
    this._masterToggleBB = null
    this._masterDeleteBB = null
    this._bindThumbBB.clear()
    this._bindToggleBB.clear()
    this._bindDeleteBB.clear()

    const src = this._source
    if (src === null) return

    const bindings = this._getBindings()
    const px   = contentLeft(Node.canvasWidth)
    const pw   = panelWidth(Node.canvasWidth)
    const py   = 50
    const rows = 1 + bindings.length
    const ph   = PILL_PAD * 2 + rows * ROW_H + Math.max(0, rows - 1) * ROW_GAP

    this._pillBounds = { x: px, y: py, width: pw, height: ph }

    ctx.save()

    // ── Pill background ─────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(px, py, pw, ph, 8)
    ctx.fill()

    const accentCol = src instanceof Layer ? typeColor(src) : '#888888'
    ctx.fillStyle = accentCol
    ctx.beginPath()
    ctx.roundRect(px, py, 4, ph, [4, 0, 0, 4])
    ctx.fill()

    // ── Shared geometry — two buttons per row (no event-slot column here) ──
    const delX    = px + pw - RIGHT_M - BTN_W
    const togX    = delX - BTN_GAP - BTN_W
    const labX    = px + PILL_PAD + THUMB_SZ + 8
    const labMaxX = togX - 6
    const rowY    = (i: number) => py + PILL_PAD + i * (ROW_H + ROW_GAP)

    // ── Master / source row ─────────────────────────────────────────────
    {
      const ry   = rowY(0)
      const midY = ry + ROW_H / 2
      const thY  = ry + (ROW_H - THUMB_SZ) / 2
      const btnY = ry + (ROW_H - BTN_H) / 2

      const srcThumb: BB = { x: px + PILL_PAD, y: thY, width: THUMB_SZ, height: THUMB_SZ }
      this._masterThumbBB = srcThumb
      this._drawThumb(ctx, src, srcThumb, accentCol)

      ctx.font         = 'bold 10px monospace'
      ctx.fillStyle    = 'rgba(255,255,255,0.88)'
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'middle'
      ctx.save()
      ctx.beginPath()
      ctx.rect(labX, ry, labMaxX - labX, ROW_H)
      ctx.clip()
      ctx.fillText(src instanceof Layer ? src.debugName : '(source)', labX, midY)
      ctx.restore()

      const togBB: BB = { x: togX, y: btnY, width: BTN_W, height: BTN_H }
      const delBB: BB = { x: delX, y: btnY, width: BTN_W, height: BTN_H }
      this._masterToggleBB = togBB
      this._masterDeleteBB = delBB

      const anyOn = bindings.some(b => b.enabled)
      this._drawBtn(ctx, togBB, anyOn ? '⊙' : '◎', anyOn ? '#7ecfff' : 'rgba(255,180,60,0.80)')
      this._drawBtn(ctx, delBB, '×', 'rgba(220,80,80,0.80)')
    }

    // ── Vertical connector ──────────────────────────────────────────────
    if (bindings.length > 0) {
      const lineX  = px + PILL_PAD + THUMB_SZ / 2
      const lineTop = rowY(0) + ROW_H
      const lineBot = rowY(bindings.length) + ROW_H / 2
      ctx.strokeStyle = 'rgba(255,255,255,0.15)'
      ctx.lineWidth   = 1.5
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(lineX, lineTop)
      ctx.lineTo(lineX, lineBot)
      ctx.stroke()
    }

    // ── Binding rows ────────────────────────────────────────────────────
    for (let i = 0; i < bindings.length; i++) {
      const bl      = bindings[i]!
      const ry      = rowY(1 + i)
      const midY    = ry + ROW_H / 2
      const thY     = ry + (ROW_H - THUMB_SZ) / 2
      const btnY    = ry + (ROW_H - BTN_H) / 2
      const cons    = bl.slot.owner
      const enabled = bl.enabled
      const lineX   = px + PILL_PAD + THUMB_SZ / 2
      const arrTip  = px + PILL_PAD + 4

      // Branch arrow
      ctx.strokeStyle = 'rgba(255,255,255,0.15)'
      ctx.lineWidth   = 1.5
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(lineX, midY)
      ctx.lineTo(arrTip, midY)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(arrTip, midY)
      ctx.lineTo(arrTip - 4, midY - 3)
      ctx.moveTo(arrTip, midY)
      ctx.lineTo(arrTip - 4, midY + 3)
      ctx.stroke()

      // Consumer thumbnail
      const consCol = enabled
        ? (cons instanceof Layer ? typeColor(cons) : '#888')
        : 'rgba(255,255,255,0.22)'
      const bThumb: BB = { x: px + PILL_PAD, y: thY, width: THUMB_SZ, height: THUMB_SZ }
      this._bindThumbBB.set(bl, bThumb)
      this._drawThumb(ctx, cons, bThumb, consCol)

      // Consumer label
      const lbl = cons instanceof Layer
        ? cons.debugName + ' · ' + bl.slot.label
        : bl.slot.label
      ctx.font         = '10px monospace'
      ctx.fillStyle    = enabled ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.35)'
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'middle'
      ctx.save()
      ctx.beginPath()
      ctx.rect(labX, ry, labMaxX - labX, ROW_H)
      ctx.clip()
      ctx.fillText(lbl, labX, midY)
      ctx.restore()

      const togBB: BB = { x: togX, y: btnY, width: BTN_W, height: BTN_H }
      const delBB: BB = { x: delX, y: btnY, width: BTN_W, height: BTN_H }
      this._bindToggleBB.set(bl, togBB)
      this._bindDeleteBB.set(bl, delBB)

      this._drawBtn(ctx, togBB, enabled ? '⊙' : '◎', enabled ? '#7ecfff' : 'rgba(255,180,60,0.80)')
      this._drawBtn(ctx, delBB, '×', 'rgba(220,80,80,0.80)')
    }

    ctx.restore()
  }

  // Position the standard slot-group pill just below the diagram pill.
  override get panelBottom(): number {
    if (this._pillBounds !== null) return this._pillBounds.y + this._pillBounds.height + 8
    // Fallback before first renderPanel (e.g. during a save/load cycle).
    const rows = 1 + this._getBindings().length
    return 50 + PILL_PAD * 2 + rows * ROW_H + Math.max(0, rows - 1) * ROW_GAP + 8 + 8
  }

  // Render all event slots (master + per-binding) as a standard slot-group pill.
  // This gives them the full standard appearance and interaction:
  //   • click empty  → InteractionSystem creates a new EventLayer via _onSlotClick
  //   • right-click  → standard binding inspector popup (handleContextMenu passes
  //                    through when the point is outside the diagram pill above)
  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const slots: ParameterSlot[] = [this.masterEventSlot]
    for (const bl of this._getBindings()) {
      const slot = this._bindingEvtSlots.get(bl)
      if (slot !== undefined) slots.push(slot)
    }
    this.renderSlotGroup(ctx, slots, this.panelBottom)
  }

  // ----------------------------------------------------------
  // Drawing helpers
  // ----------------------------------------------------------

  private _drawThumb(ctx: Ctx2D, node: Node, b: BB, borderCol: string): void {
    if (node instanceof Layer) {
      const oc = new OffscreenCanvas(b.width, b.height)
      drawLayerThumbnail(
        oc.getContext('2d')!, node, b.width, b.height,
        Node.canvasWidth, Node.canvasHeight,
      )
      ctx.drawImage(oc, b.x, b.y)
    } else {
      ctx.fillStyle = '#1a1a2e'
      ctx.fillRect(b.x, b.y, b.width, b.height)
    }
    ctx.strokeStyle = borderCol
    ctx.lineWidth   = 1.5
    ctx.setLineDash([])
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.width - 1, b.height - 1)
  }

  private _drawBtn(ctx: Ctx2D, b: BB, label: string, colour: string): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    ctx.font         = '13px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point): Node | null {
    return (this._pillBounds !== null && boundingBoxContains(this._pillBounds, point))
      ? this : null
  }

  // Block right-click inspector only within the diagram pill; right-clicks
  // on the standard slot rows below fall through to the normal inspector.
  handleContextMenu(point: Point): boolean {
    return this._pillBounds !== null && boundingBoxContains(this._pillBounds, point)
  }

  handlePointerDown(point: Point): boolean {
    // Master row
    if (this._masterThumbBB !== null && boundingBoxContains(this._masterThumbBB, point)) {
      const src = this._source
      if (src instanceof Layer) Node.selectLayer?.(src)
      Node.scheduleFrame?.()
      return true
    }
    if (this._masterToggleBB !== null && boundingBoxContains(this._masterToggleBB, point)) {
      this._masterToggle(this._getBindings())
      Node.scheduleFrame?.()
      return true
    }
    if (this._masterDeleteBB !== null && boundingBoxContains(this._masterDeleteBB, point)) {
      for (const bl of this._getBindings()) this._deleteBinding(bl)
      Node.scheduleFrame?.()
      return true
    }

    // Per-binding rows
    for (const [bl, b] of this._bindThumbBB) {
      if (boundingBoxContains(b, point)) {
        const cons = bl.slot.owner
        if (cons instanceof Layer) Node.selectLayer?.(cons)
        Node.scheduleFrame?.()
        return true
      }
    }
    for (const [bl, b] of this._bindToggleBB) {
      if (boundingBoxContains(b, point)) {
        this._toggleBinding(bl)
        Node.scheduleFrame?.()
        return true
      }
    }
    for (const [bl, b] of this._bindDeleteBB) {
      if (boundingBoxContains(b, point)) {
        this._deleteBinding(bl)
        Node.scheduleFrame?.()
        return true
      }
    }

    // Consume clicks within the diagram pill to prevent pixel-pick through it.
    // Return false outside the pill so slot-row clicks reach hitTestSlot.
    return this._pillBounds !== null && boundingBoxContains(this._pillBounds, point)
  }
}
