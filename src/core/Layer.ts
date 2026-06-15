import { Node } from './Node.js'
import { ParameterSlot } from './ParameterSlot.js'
import { ValueType, SlotState } from './types.js'
import type { Ctx2D, Point, Direction }  from './types.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'

const SLOT_TC: Partial<Record<ValueType, string>> = {
  [ValueType.Amount]:    '#4a8fe8',
  [ValueType.Colour]:    '#e8944a',
  [ValueType.Image]:     '#7ecf7e',
  [ValueType.Mask]:      '#cfcf7e',
  [ValueType.Point]:     '#cf7ecf',
  [ValueType.Direction]: '#7ecfcf',
  [ValueType.Rate]:      '#e87e7e',
  [ValueType.Count]:     '#a0a0a0',
  [ValueType.Event]:     '#e0e060',
  [ValueType.Collection]:'#a0a4b8',
}

// ------------------------------------------------------------
// Layer — a full participant in the dataflow graph and the stack
// ------------------------------------------------------------
// A Layer can be both a source (other nodes bind to it) and a
// sink (it has parameter slots). Layers form the doubly-linked
// stack that is the primary organisational structure.

export abstract class Layer extends Node {

  // Stack links. Null at the bottom (RootLayer) or when outside the stack.
  layerBelow: Layer | null = null
  layerAbove: Layer | null = null

  // True when this layer has been removed from the stack but not destroyed.
  outsideStack: boolean = false

  // True while this layer is held in BackgroundLayer's items (implies
  // outsideStack). Self-perpetuating frame loops (VideoLayer, MediaLayer,
  // PointLayer wander mode) check `!outsideStack || inBackground` so they
  // keep running while backgrounded — BackgroundLayer.recompute() calls
  // evaluate() on its items every frame, but evaluate() is a no-op unless
  // the item is already dirty, so the loop must keep re-marking itself.
  inBackground: boolean = false

  // Whether this layer is currently selected by the user.
  selected: boolean = false

  // Infrastructure layers (e.g. BindingLayer) are hidden in the
  // LayerStackWidget and excluded from user-facing layer lists.
  readonly isInfrastructure: boolean = false

  // When true, the thumbnail card is only rendered while this layer is
  // the currently selected layer; otherwise the card body is left blank.
  get thumbnailOnlyWhenSelected(): boolean { return false }

  // Called by LayerStackWidget when this layer becomes the selected layer.
  // Override to react to being navigated to (e.g. DeletionLayer defaults
  // its toggle to Background when it has no archived layers).
  onSelected(): void {}

  // Hidden helper layers remain part of the stack (evaluated in stack
  // order via renderStack) but have no thumbnail in the LayerStackWidget
  // and are never rendered to the canvas. They stay directly above (or,
  // if `helperBelow` is set on the host, directly below) their host layer
  // (`helperHost`) whenever the host is reordered. Set both
  // `isHiddenHelper` and `helperHost` on the helper, and `hiddenHelper`
  // (+ optionally `helperBelow`) on the host. Cleared (permanently) when
  // the helper is "exposed".
  isHiddenHelper: boolean = false
  helperHost: Layer | null = null
  hiddenHelper: Layer | null = null
  helperBelow: boolean = false

  // Slot-region bounding boxes — populated by renderSlots, used by hitTestSlot.
  // Protected so subclasses with a custom renderSlots (e.g. PointLayer's
  // consolidated wander pill) can register their own row bounds.
  protected _slotBounds = new Map<ParameterSlot, { x: number; y: number; width: number; height: number }>()

  // ----------------------------------------------------------
  // Stack operations
  // ----------------------------------------------------------

  // Insert this layer directly above `target`.
  insertAbove(target: Layer): void {
    const previousAbove = target.layerAbove
    this.layerBelow = target
    target.layerAbove = this
    this.layerAbove = previousAbove
    if (previousAbove !== null) previousAbove.layerBelow = this
    this.outsideStack = false
  }

  // Insert this layer directly below `target`.
  insertBelow(target: Layer): void {
    const previousBelow = target.layerBelow
    this.layerAbove = target
    target.layerBelow = this
    this.layerBelow = previousBelow
    if (previousBelow !== null) previousBelow.layerAbove = this
    this.outsideStack = false
  }

  // Remove this layer from the stack, linking its neighbours together.
  removeFromStack(): void {
    if (this.layerAbove !== null) this.layerAbove.layerBelow = this.layerBelow
    if (this.layerBelow !== null) this.layerBelow.layerAbove = this.layerAbove
    this.layerAbove = null
    this.layerBelow = null
    this.outsideStack = true
  }

  // Swap this layer with an adjacent layer.
  swapWith(other: Layer): void {
    if (other === this.layerAbove) {
      // Move other from above to below
      const aboveOther = other.layerAbove
      const belowThis  = this.layerBelow
      if (belowThis  !== null) belowThis.layerAbove  = other
      if (aboveOther !== null) aboveOther.layerBelow = this
      other.layerBelow = belowThis
      other.layerAbove = this
      this.layerBelow  = other
      this.layerAbove  = aboveOther
    } else if (other === this.layerBelow) {
      other.swapWith(this)
    }
    // Non-adjacent swap not yet implemented.
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  // Render this layer and all layers below it onto g2d.
  // Subclasses override to control compositing behaviour.
  renderStack(ctx: Ctx2D): void {
    this.layerBelow?.renderStack(ctx)
    this.evaluate()    // pull value from dirty dependencies before drawing
    if (!this.isHiddenHelper) this.renderSelf(ctx)
  }

  // Render just this layer's own content. Subclasses may override.
  renderSelf(_ctx: Ctx2D): void {}

  // Render just this layer's panel UI. Subclasses may override.
  renderPanel(_ctx: Ctx2D): void {}

  // Render the panel UI for this layer and all layers below it.
  renderPanelStack(ctx: Ctx2D): void {
    this.layerBelow?.renderPanelStack(ctx)
    this.renderPanel(ctx)
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  // Returns the topmost node that wants to respond to a click at `point`,
  // searching this layer and all layers below it.
  hitTest(point: { x: number; y: number }): Node | null {
    // Search upward from bottom: later layers take priority.
    const belowResult = this.layerBelow?.hitTest(point) ?? null
    // Test own regions first (they are smaller and more specific targets).
    const ownResult   = this.hitTestSelf(point)
    if (ownResult !== null && belowResult !== null) {
      // Prefer the smaller target.
      const ownArea   = ownResult.bounds.width * ownResult.bounds.height
      const belowArea = belowResult.bounds.width * belowResult.bounds.height
      return ownArea <= belowArea ? ownResult : belowResult
    }
    return ownResult ?? belowResult
  }

  // Hit-test this layer's own nodes only (no recursion into layers below).
  // Used by InteractionSystem when a layer is selected, so lower-layer
  // nodes cannot preempt interaction with the current layer.
  hitTestLayer(point: { x: number; y: number }): Node | null {
    return this.hitTestSelf(point)
  }

  // Hit-test within this layer only. Subclasses may override.
  protected hitTestSelf(_point: { x: number; y: number }): Node | null {
    return null
  }

  // Y-coordinate of the bottom of this layer's canvas panel.
  // Layers with non-standard panel heights should override.
  get panelBottom(): number {
    return 50 + this.bounds.height + 8
  }

  // Bounds for the canvas-area status/control pill — right of the stack
  // widget, above the slot rows. Layers that render a pill on the canvas
  // should use this instead of this.bounds (which is hidden by the widget).
  get canvasBounds(): { x: number; y: number; width: number; height: number } {
    return { x: contentLeft(Node.canvasWidth), y: 50, width: panelWidth(Node.canvasWidth), height: this.bounds.height }
  }

  // Render parameter-slot drop targets below the layer's canvas panel.
  // Called by the Evaluator after renderPanel so it is always present.
  renderSlots(ctx: Ctx2D): void {
    if (this.slots.length === 0) return
    this._slotBounds.clear()
    this.renderSlotGroup(ctx, this.slots, this.panelBottom)
  }

  // Renders `slots` as a single backdrop pill of standard binding rows
  // (label + drop-target box, Bound/SuspendedBound/Unbound/compat states),
  // starting at `y`. Registers each slot's row bounds in `_slotBounds` for
  // hitTestSlot / bind-drag-drop. Subclasses that render more than one
  // group (e.g. MaskLayer's invert pill below its shape-slot pill) should
  // call `_slotBounds.clear()` once themselves, then call this once per
  // group. Returns the y-coordinate of the bottom of the pill, for stacking
  // further groups beneath it.
  protected renderSlotGroup(ctx: Ctx2D, slots: ParameterSlot[], y: number): number {
    if (slots.length === 0) return y

    const SLOT_H  = 26
    const SLOT_GAP = 4
    const LABEL_W  = 78
    const PANEL_X  = contentLeft(Node.canvasWidth)
    const PANEL_W  = panelWidth(Node.canvasWidth)
    const drag     = Node.bindDrag

    ctx.save()
    ctx.font         = '10px monospace'
    ctx.textBaseline = 'middle'

    // Dark backdrop behind all rows in this group
    const n = slots.length
    const totalH = n * (SLOT_H + SLOT_GAP) - SLOT_GAP
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(PANEL_X, y, PANEL_W, totalH, 6)
    ctx.fill()

    for (const slot of slots) {
      const isCompat = (drag.active
                    && drag.source !== null
                    && slot.type !== null
                    && drag.source.types.has(slot.type))
                    || (Node.fileDragActive
                    && slot.type === ValueType.Image
                    && slot.state === SlotState.Unbound)

      const b = { x: PANEL_X, y, width: PANEL_W, height: SLOT_H }
      this._slotBounds.set(slot, b)

      // Label
      ctx.fillStyle = 'rgba(255,255,255,0.62)'
      ctx.textAlign = 'left'
      ctx.fillText(slot.label, PANEL_X + 6, y + SLOT_H / 2)

      // Value box
      const tc  = (slot.type !== null ? SLOT_TC[slot.type] : undefined) ?? '#888888'
      const vx  = PANEL_X + LABEL_W
      const vw  = PANEL_W - LABEL_W - 2
      const by  = y + 3
      const bh  = SLOT_H - 6

      if (slot.isActive && !isCompat) {
        const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
        ctx.fillStyle = tc + '22'
        ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
        ctx.strokeStyle = tc + 'cc'; ctx.lineWidth = 1; ctx.setLineDash([])
        ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.textAlign = 'left'
        ctx.fillText(srcName, vx + 6, y + SLOT_H / 2)
      } else if (isCompat) {
        ctx.fillStyle = 'rgba(50,200,70,0.18)'
        ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
        ctx.strokeStyle = 'rgba(50,200,70,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([])
        ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
        ctx.fillStyle = 'rgba(100,255,120,0.75)'; ctx.textAlign = 'left'
        ctx.fillText(slot.isActive ? 'replace binding' : 'drop to bind', vx + 6, y + SLOT_H / 2)
      } else if (slot.state === SlotState.SuspendedBound) {
        const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
        ctx.fillStyle = tc + '11'
        ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.40)'; ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(255,255,255,0.60)'; ctx.textAlign = 'left'
        ctx.fillText('⏸ ' + srcName, vx + 6, y + SLOT_H / 2)
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.textAlign = 'left'
        ctx.fillText('unbound', vx + 6, y + SLOT_H / 2)
      }

      y += SLOT_H + SLOT_GAP
    }

    ctx.restore()
    return y - SLOT_GAP
  }

  // Return the ParameterSlot whose drop-target region contains `point`, or null.
  hitTestSlot(point: Point): ParameterSlot | null {
    for (const [slot, b] of this._slotBounds) {
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) return slot
    }
    return null
  }

  // Return the first unbound slot of the given type, or null.
  findEmptySlot(type: ValueType): ParameterSlot | null {
    for (const slot of this.slots) {
      if (slot.type === type && slot.state === SlotState.Unbound) return slot
    }
    return null
  }

  // Per-type serial counters used by assignDebugName, e.g. "Colour 1",
  // "Colour 2" — shared across however the layer was created (menu button,
  // empty-slot click, drag-and-drop, auto-bind helpers, ...).
  private static _typeCounters = new Map<string, number>()

  // Assign a friendly debugName of the form "<Type> <n>", where <Type> is
  // the layer's class name with any trailing "Layer" stripped, and <n> is
  // a per-type running count.
  static assignDebugName(layer: Layer): void {
    const base = layer.constructor.name.replace(/Layer$/, '')
    const n = (Layer._typeCounters.get(base) ?? 0) + 1
    Layer._typeCounters.set(base, n)
    layer.debugName = `${base} ${n}`
  }

  // For an unbound Point/Amount/Direction slot, returns the value currently
  // shown by this layer's manual control for that slot (handle position,
  // slider value, etc) — so a layer created via the slot-click-to-create
  // gesture starts as a no-op binding. Return null to fall back to the
  // slot type's canonical default (DEFAULT_VALUE_LAYER in main.ts).
  getSlotDefault(_slot: ParameterSlot): Point | number | Direction | null {
    return null
  }

  // True if `slot` is conventionally filled with a freshly-created closed
  // shape (Rect/Ellipse/Path, in outline mode) via the slot-click-to-create
  // gesture, rather than the slot type's canonical default layer — e.g. an
  // AnimPath's shape slot or a MaskLayer's shape slots.
  wantsShapeForSlot(_slot: ParameterSlot): boolean {
    return false
  }

  // Default bindings to create when this layer is first added to the stack.
  // Each rule names a slot and a predicate that selects a compatible source layer.
  // main.ts walks down from this layer and binds the first match for each rule.
  // Override in subclasses to declare wiring that makes sense on first drop.
  autoBindRules(): Array<{
    slot: ParameterSlot
    accepts: (layer: Layer) => boolean
    sendToBackgroundAfterBind?: boolean
  }> {
    return []
  }
}
