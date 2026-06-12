import type { Layer }           from '../core/Layer.js'
import { Node }                 from '../core/Node.js'
import { ParameterSlot }        from '../core/ParameterSlot.js'
import { SlotState, type Point } from '../core/types.js'
import { BindingLayer }         from '../layers/BindingLayer.js'
import type { LayerStackWidget } from './LayerStackWidget.js'

// ------------------------------------------------------------
// InteractionSystem — routes canvas pointer events to the stack
// ------------------------------------------------------------
//
// Responsibilities:
//   1. Hit-test the layer stack on pointerdown to find the target node.
//   2. Deliver handlePointerDown / handlePointerMove / handlePointerUp
//      to that node for the duration of the drag gesture.
//   3. Acquire pointer capture so moves/ups are received even if the
//      pointer leaves the canvas mid-drag.
//   4. Update the canvas cursor to reflect what is under the pointer.
//
// Usage:
//
//   const interaction = new InteractionSystem(canvas)
//   interaction.setStack(rootLayer)        // update when stack top changes
//   // ...
//   interaction.destroy()                  // removes all event listeners
//
// Nodes respond to pointer events by implementing any subset of:
//
//   handlePointerDown(point: Point): boolean   // return true to claim the drag
//   handlePointerMove(point: Point): void
//   handlePointerUp(): void
//
// These methods are discovered at runtime via duck-typing; nodes do not
// need to implement a shared interface.  A node that returns false from
// handlePointerDown is skipped (the event is not consumed).

// ------------------------------------------------------------------
// Duck-typed accessors
// ------------------------------------------------------------------

interface Draggable {
  handlePointerDown(point: Point): boolean
  handlePointerMove?(point: Point): void
  handlePointerUp?(): void
}

function isDraggable(node: unknown): node is Draggable {
  return typeof (node as Record<string, unknown>)?.handlePointerDown === 'function'
}

// Nodes with an isInteractive flag (Region subclasses) advertise
// whether they will respond to interaction in their current state.
// Nodes that have no such flag are assumed to always be interactive.
function isInteractive(node: Node): boolean {
  if ('isInteractive' in node && typeof (node as { isInteractive: unknown }).isInteractive === 'boolean') {
    return (node as { isInteractive: boolean }).isInteractive
  }
  return true
}

// ------------------------------------------------------------------
// InteractionSystem
// ------------------------------------------------------------------

export class InteractionSystem {
  private readonly _canvas: HTMLCanvasElement

  // The topmost layer of the stack, used for hit-testing.
  private _stackTop: Layer | null = null

  // Optional LayerStackWidget — events within its strip are routed here first.
  private _widget: LayerStackWidget | null = null

  // The node currently handling a drag gesture, and the pointer
  // that owns it (to support multi-touch correctly).
  private _active: { node: Draggable; pointerId: number } | null = null

  // True while a pointer gesture is being handled by the LayerStackWidget.
  private _widgetCapture = false

  // Bound listener references retained so destroy() can remove them.
  private readonly _onDown:   (e: PointerEvent) => void
  private readonly _onMove:   (e: PointerEvent) => void
  private readonly _onUp:     (e: PointerEvent) => void
  private readonly _onCancel: (e: PointerEvent) => void
  private readonly _onKey:    (e: KeyboardEvent) => void
  private _spaceAction:      (() => void) | null = null
  private _deleteAction:     (() => void) | null = null
  private _collectionAction: (() => void) | null = null
  private _onBound:        ((source: Node, slot: ParameterSlot) => void) | null = null
  private _onSlotClick:    ((consumer: Layer, slot: ParameterSlot) => void) | null = null
  private _refreshCallback: (() => void) | null = null

  // Inspector popup element (right-click on a slot).
  private _inspector: HTMLElement | null = null
  private readonly _onContext: (e: MouseEvent) => void

  constructor(canvas: HTMLCanvasElement) {
    this._canvas = canvas

    this._onDown   = e => this._handleDown(e)
    this._onMove   = e => this._handleMove(e)
    this._onUp     = e => this._handleUp(e)
    this._onCancel = e => this._handleUp(e)   // treat cancel like up
    this._onKey    = e => this._handleKey(e)
    this._onContext = e => this._handleContextMenu(e)

    canvas.addEventListener('pointerdown',   this._onDown)
    canvas.addEventListener('pointermove',   this._onMove)
    canvas.addEventListener('pointerup',     this._onUp)
    canvas.addEventListener('pointercancel', this._onCancel)
    canvas.addEventListener('contextmenu',   this._onContext)
    // Key events on document so they fire even before the canvas is clicked.
    document.addEventListener('keydown',     this._onKey)
  }

  // ----------------------------------------------------------
  // Configuration
  // ----------------------------------------------------------

  // Set (or update) the top of the layer stack.
  setStack(top: Layer): void {
    this._stackTop = top
  }

  setLayerStackWidget(w: LayerStackWidget): void {
    this._widget = w
  }

  // Register a callback invoked when the user presses Space.
  setSpaceAction(fn: () => void): void {
    this._spaceAction = fn
  }

  // Register a callback invoked when the user presses Delete.
  setDeleteAction(fn: () => void): void {
    this._deleteAction = fn
  }

  // Register a callback invoked when the user presses 'c' (collect).
  setCollectionAction(fn: () => void): void {
    this._collectionAction = fn
  }

  // Register a callback invoked when a bind-drag drop creates a binding.
  setBoundCallback(fn: (source: Node, slot: ParameterSlot) => void): void {
    this._onBound = fn
  }

  // Register a callback invoked when the user clicks a parameter-slot row
  // (empty or bound) on the selected layer.
  setSlotClickCallback(fn: (consumer: Layer, slot: ParameterSlot) => void): void {
    this._onSlotClick = fn
  }

  // Register a callback invoked when a binding inspector action mutates the stack
  // (i.e. a binding is removed).  Should call refreshStack() in main.ts.
  setRefreshCallback(fn: () => void): void {
    this._refreshCallback = fn
  }

  // Remove all event listeners.  Call when the canvas is torn down.
  destroy(): void {
    this._closeInspector()
    this._canvas.removeEventListener('pointerdown',   this._onDown)
    this._canvas.removeEventListener('pointermove',   this._onMove)
    this._canvas.removeEventListener('pointerup',     this._onUp)
    this._canvas.removeEventListener('pointercancel', this._onCancel)
    this._canvas.removeEventListener('contextmenu',   this._onContext)
    document.removeEventListener('keydown',           this._onKey)
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _point(e: PointerEvent): Point {
    return { x: e.offsetX, y: e.offsetY }
  }

  private _pickLayerAtPixel(point: Point): Layer | null {
    if (this._stackTop === null) return null
    const w = this._canvas.width, h = this._canvas.height
    const px = Math.floor(point.x), py = Math.floor(point.y)
    if (px < 0 || px >= w || py < 0 || py >= h) return null
    const offscreen = new OffscreenCanvas(w, h)
    const ctx = offscreen.getContext('2d')!
    let layer: Layer | null = this._stackTop
    while (layer !== null) {
      if (!layer.isInfrastructure) {
        ctx.clearRect(0, 0, w, h)
        try { layer.renderSelf(ctx) } catch { /* skip */ }
        const alpha = ctx.getImageData(px, py, 1, 1).data[3] ?? 0
        if (alpha > 10) return layer
      }
      layer = layer.layerBelow
    }
    return null
  }

  private _hitTest(point: Point): Node | null {
    const selected = this._widget?.selected ?? null
    // When a layer is selected, only test that layer's own nodes.
    // Using hitTest (full stack recursion) allows lower-layer nodes to
    // win the "prefer smaller target" comparison and block interaction
    // with the current layer's controls.
    if (selected !== null) return selected.hitTestLayer(point)
    return this._stackTop?.hitTest(point) ?? null
  }

  // Returns true if the node belongs to the currently-selected layer
  // (or there is no selection, in which case all nodes are accepted).
  private _isOnCurrentLayer(node: Node): boolean {
    const current = this._widget?.selected ?? null
    if (current === null) return true
    if ((node as unknown) === current) return true
    // Region owned by the current layer
    if ('parentLayer' in node && (node as { parentLayer: unknown }).parentLayer === current) return true
    return false
  }

  // ----------------------------------------------------------
  // Event handlers
  // ----------------------------------------------------------

  private _handleDown(e: PointerEvent): void {
    if (e.button !== 0) return   // only handle primary (left) button
    // If we are already tracking a pointer, ignore additional ones.
    // (Multi-touch is not yet supported.)
    if (this._active !== null || this._widgetCapture) return

    const point = this._point(e)

    // Route to the LayerStackWidget first if the pointer is in its strip.
    if (this._widget !== null && this._widget.inBounds(point)) {
      if (this._widget.handlePointerDown(point)) {
        this._widgetCapture = true
        this._canvas.setPointerCapture(e.pointerId)
        this._setCursor('grabbing')
      }
      return
    }

    if (this._stackTop === null) return

    const node  = this._hitTest(point)

    if (node === null || !isDraggable(node)) {
      const selected = this._widget?.selected ?? null

      // A click on a parameter-slot row (empty or bound) takes priority
      // over pixel-pick — it either creates+binds a default layer for an
      // empty slot, or selects/restores the layer bound to a filled slot.
      if (selected !== null) {
        const slot = selected.hitTestSlot(point)
        if (slot !== null) {
          this._onSlotClick?.(selected, slot)
          return
        }
      }

      // No interactive hit — pixel-pick to select a layer by rendered content.
      // Suppressed when the selected layer sets blockPixelPick (e.g. MaskLayer,
      // where painting begins in transparent areas).
      const blocked = selected !== null &&
        (selected as unknown as Record<string, unknown>)['blockPixelPick'] === true
      if (this._widget !== null && !blocked) {
        const picked = this._pickLayerAtPixel(point)
        if (picked !== null) {
          this._widget.selected = picked
          Node.scheduleFrame?.()
        }
      }
      return
    }

    // Only accept interaction on nodes belonging to the current layer.
    if (!this._isOnCurrentLayer(node)) return

    // Let the node decide whether to accept the event.
    if (!node.handlePointerDown(point)) {
      // Node declined — still check whether the click landed on a slot dot.
      const sel = this._widget?.selected ?? null
      if (sel !== null) {
        const slot = sel.hitTestSlot(point)
        if (slot !== null) this._onSlotClick?.(sel, slot)
      }
      return
    }

    this._active = { node, pointerId: e.pointerId }
    this._canvas.setPointerCapture(e.pointerId)
    this._setCursor('grabbing')
  }

  private _handleMove(e: PointerEvent): void {
    const point = this._point(e)
    if (this._widgetCapture) {
      this._widget?.handlePointerMove(point)
      // Keep drag overlay position current
      if (Node.bindDrag.active) {
        Node.bindDrag.x = point.x
        Node.bindDrag.y = point.y
      }
      return
    }
    if (this._active !== null) {
      // Deliver move to the captured node only.
      if (e.pointerId !== this._active.pointerId) return
      this._active.node.handlePointerMove?.(point)
    } else {
      // No active drag — update the hover cursor.
      this._updateHoverCursor(e)
    }
  }

  private _handleUp(e: PointerEvent): void {
    const point = this._point(e)
    if (this._widgetCapture) {
      if (Node.bindDrag.active) {
        // Bind-drop: attempt to bind the dragged source to a slot at the drop point.
        const src      = Node.bindDrag.source
        const selected = this._widget?.selected ?? null
        Node.bindDrag.active = false
        Node.bindDrag.source = null
        if (src !== null && selected !== null) {
          const slot = selected.hitTestSlot(point)
          if (slot !== null) {
            this._onBound?.(src, slot)
          } else {
            this._tryIngest(src, selected, point)
          }
        }
      } else {
        this._widget?.handlePointerUp(point)
      }
      this._widgetCapture = false
      this._updateHoverCursor(e)
      return
    }
    if (this._active === null) return
    if (e.pointerId !== this._active.pointerId) return

    this._active.node.handlePointerUp?.()
    this._active = null
    this._updateHoverCursor(e)
  }

  private _tryIngest(src: Node, selected: Layer, point: Point): void {
    const s = selected as unknown as Record<string, unknown>
    if (typeof s['ingest'] !== 'function') return
    const zone = s['dropZoneBounds'] as { x: number; y: number; width: number; height: number } | undefined | null
    if (!zone) return
    if (point.x < zone.x || point.x > zone.x + zone.width ||
        point.y < zone.y || point.y > zone.y + zone.height) return
    ;(s['ingest'] as (l: Node) => void)(src)
    this._refreshCallback?.()
  }

  private _handleKey(e: KeyboardEvent): void {
    // Let text inputs (textarea, input, contenteditable) handle their own keys.
    if (e.target instanceof HTMLElement &&
        e.target.closest('textarea, input, select, [contenteditable]')) return

    if (e.key === ' ') {
      this._closeInspector()
      this._spaceAction?.()
      e.preventDefault()
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this._deleteAction?.()
      e.preventDefault()
      return
    }
    if (e.key === 'c' && !e.ctrlKey && !e.metaKey) {
      this._collectionAction?.()
      e.preventDefault()
      return
    }
    if (this._widget !== null) {
      const key = e.shiftKey ? `Shift+${e.key}` : e.key
      if (this._widget.handleKey(key)) e.preventDefault()
    }
  }

  // ----------------------------------------------------------
  // Cursor management
  // ----------------------------------------------------------

  // ----------------------------------------------------------
  // Right-click binding inspector
  // ----------------------------------------------------------

  private _handleContextMenu(e: MouseEvent): void {
    e.preventDefault()
    const point = { x: e.offsetX, y: e.offsetY }
    const selected = this._widget?.selected ?? null
    if (selected === null) return
    const slot = selected.hitTestSlot(point)
    if (slot === null || slot.state === SlotState.Unbound) return
    const bl = BindingLayer.findForSlot(slot)
    if (bl === null) return
    this._showInspector(bl, slot, e.clientX, e.clientY)
  }

  private _showInspector(bl: BindingLayer, slot: ParameterSlot, cx: number, cy: number): void {
    this._closeInspector()

    const panel = document.createElement('div')
    panel.style.cssText = [
      'position:fixed',
      'z-index:9999',
      'background:rgba(18,20,30,0.96)',
      'border:1px solid rgba(255,255,255,0.15)',
      'border-radius:8px',
      'padding:10px 12px',
      'font:12px monospace',
      'color:rgba(255,255,255,0.88)',
      'box-shadow:0 4px 24px rgba(0,0,0,0.6)',
      'min-width:240px',
      'user-select:none',
    ].join(';')

    const srcName      = bl.source.debugName
    const consumerName = slot.owner.debugName
    const slotLabel    = slot.label

    // Header
    const header = document.createElement('div')
    header.style.cssText = 'font-weight:bold;margin-bottom:8px;color:rgba(255,255,255,0.55);font-size:10px;letter-spacing:1px'
    header.textContent = 'BINDING'
    panel.appendChild(header)

    // Binding description
    const info = document.createElement('div')
    info.style.cssText = 'margin-bottom:10px;line-height:1.5'
    info.innerHTML =
      `<span style="color:#7ecf7e">${srcName}</span>` +
      ` <span style="color:rgba(255,255,255,0.4)">──→</span> ` +
      `<span style="color:rgba(255,255,255,0.75)">${consumerName}</span>` +
      `<span style="color:rgba(255,255,255,0.4)"> · ${slotLabel}</span>`
    panel.appendChild(info)

    // Buttons row
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:8px'

    const mkBtn = (label: string, bg: string, fg: string) => {
      const b = document.createElement('button')
      b.textContent = label
      b.style.cssText = [
        `background:${bg}`,
        `color:${fg}`,
        'border:none',
        'border-radius:5px',
        'padding:5px 10px',
        'font:12px monospace',
        'cursor:pointer',
        'flex:1',
      ].join(';')
      return b
    }

    const toggleBtn = mkBtn(
      bl.enabled ? '⊙  Enabled' : '◎  Disabled',
      bl.enabled ? 'rgba(60,120,200,0.35)' : 'rgba(200,100,30,0.35)',
      bl.enabled ? '#7ecfff' : '#ffaa55',
    )
    toggleBtn.addEventListener('click', () => {
      bl.toggle()
      // Update button appearance without closing the panel.
      toggleBtn.textContent = bl.enabled ? '⊙  Enabled' : '◎  Disabled'
      toggleBtn.style.background = bl.enabled ? 'rgba(60,120,200,0.35)' : 'rgba(200,100,30,0.35)'
      toggleBtn.style.color = bl.enabled ? '#7ecfff' : '#ffaa55'
    })

    const deleteBtn = mkBtn('× Delete', 'rgba(180,40,40,0.40)', '#ff8888')
    deleteBtn.addEventListener('click', () => {
      bl.remove()
      this._closeInspector()
      this._refreshCallback?.()
    })

    row.appendChild(toggleBtn)
    row.appendChild(deleteBtn)
    panel.appendChild(row)

    // Position near click, clamped to viewport.
    document.body.appendChild(panel)
    const vw = window.innerWidth, vh = window.innerHeight
    const pw = panel.offsetWidth  || 260
    const ph = panel.offsetHeight || 110
    panel.style.left = `${Math.min(cx + 4, vw - pw - 8)}px`
    panel.style.top  = `${Math.min(cy + 4, vh - ph - 8)}px`

    // Close when clicking outside.
    const onOutside = (ev: MouseEvent) => {
      if (!panel.contains(ev.target as unknown as globalThis.Node)) {
        this._closeInspector()
        document.removeEventListener('mousedown', onOutside, true)
      }
    }
    document.addEventListener('mousedown', onOutside, true)

    this._inspector = panel
  }

  private _closeInspector(): void {
    this._inspector?.remove()
    this._inspector = null
  }

  private _setCursor(cursor: string): void {
    this._canvas.style.cursor = cursor
  }

  private _updateHoverCursor(e: PointerEvent): void {
    const point = this._point(e)
    if (this._widget !== null && this._widget.inBounds(point)) {
      this._setCursor('pointer')
      return
    }
    if (this._stackTop === null) {
      this._setCursor('default')
      return
    }
    const node = this._hitTest(point)
    if (node !== null && isDraggable(node) && isInteractive(node) && this._isOnCurrentLayer(node)) {
      this._setCursor('pointer')
    } else {
      this._setCursor('default')
    }
  }
}
