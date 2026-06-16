import type { Layer }           from '../core/Layer.js'
import { Node }                 from '../core/Node.js'
import { ParameterSlot }        from '../core/ParameterSlot.js'
import { SlotState, type Point } from '../core/types.js'
import { BindingLayer }         from '../layers/BindingLayer.js'
import type { LayerStackWidget } from './LayerStackWidget.js'
import {
  classifySwipe, computePinchTransform,
  TAP_MAX_MOVEMENT, TWO_FINGER_TAP_MS, PROMOTE_MS,
  type PinchStart,
} from './gestures.js'
import { stackWidgetWidth } from './layout.js'

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

// A layer may handle a right-click itself (e.g. PathLayer deleting a
// control point under the cursor) instead of the default slot-binding
// inspector. Return true to consume the event.
interface ContextMenuHandler {
  handleContextMenu(point: Point): boolean
}

function hasContextMenuHandler(node: unknown): node is ContextMenuHandler {
  return typeof (node as Record<string, unknown>)?.handleContextMenu === 'function'
}

// A layer (e.g. TextLayer) may claim all keyboard/paste input while the
// pointer hovers a designated in-place-edit region. isTextEditActive() is
// checked fresh on every key/paste event; handleTextEditKey returns true to
// consume the event (and bypass the normal shortcut chain).
interface TextEditTarget {
  isTextEditActive(): boolean
  handleTextEditKey(e: KeyboardEvent): boolean
  pasteTextAtCursor(text: string): void
}

function isTextEditTarget(node: unknown): node is TextEditTarget {
  const n = node as Record<string, unknown>
  return typeof n?.isTextEditActive === 'function' &&
         typeof n?.handleTextEditKey === 'function' &&
         typeof n?.pasteTextAtCursor === 'function'
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
// Touch gesture tracking
// ------------------------------------------------------------------

// A touch pointer that has been "deferred" — not claimed by a draggable
// node or the widget's own drag handling — pending swipe/tap/pinch/drag
// recognition. `x/y` are canvas-space (via _point); `clientX/clientY` are
// raw screen coordinates, used for pinch distance/centroid math. `hitNode`
// is the draggable node (if any) hit at pointerdown, on the current layer,
// for promotion to a drag if the press is held (see PROMOTE_MS).
// `promoteTimer` is the pending setTimeout id, or null once fired/cancelled.
interface TouchPointer {
  x: number; y: number
  startX: number; startY: number
  clientX: number; clientY: number
  startTime: number
  inWidget: boolean
  hitNode: Draggable | null
  promoteTimer: number | null
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

  // ── Touch gesture state ──────────────────────────────────────────
  // Touch pointers not (yet) claimed by _active or _widgetCapture,
  // pending swipe/tap/pinch/scroll recognition. See gestures.ts.
  private _touchPointers = new Map<number, TouchPointer>()
  private _pinchStart: PinchStart | null = null
  private _scrollCentroidY: number | null = null
  private _zoomScale = 1
  private _panX = 0
  private _panY = 0

  // Bound listener references retained so destroy() can remove them.
  private readonly _onDown:   (e: PointerEvent) => void
  private readonly _onMove:   (e: PointerEvent) => void
  private readonly _onUp:     (e: PointerEvent) => void
  private readonly _onCancel: (e: PointerEvent) => void
  private readonly _onLeave:  (e: PointerEvent) => void
  private readonly _onWheel:  (e: WheelEvent) => void
  private readonly _onKey:    (e: KeyboardEvent) => void
  private readonly _onPaste:  (e: ClipboardEvent) => void
  private _spaceAction:      (() => void) | null = null
  private _deleteAction:     (() => void) | null = null
  private _collectionAction: (() => void) | null = null
  private _backgroundAction: (() => void) | null = null
  private _menuFocusAction:  (() => void) | null = null
  private _pasteAction:      ((text: string) => void) | null = null
  private _imagePasteAction: ((file: File) => void) | null = null
  private _onBound:        ((source: Node, slot: ParameterSlot) => void) | null = null
  private _onMaskDrop:     ((source: Node, target: Layer) => void) | null = null
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
    this._onLeave  = () => { Node.pointerCanvas = null }
    this._onWheel  = e => this._handleWheel(e)
    this._onKey    = e => this._handleKey(e)
    this._onPaste  = e => this._handlePaste(e)
    this._onContext = e => this._handleContextMenu(e)

    canvas.addEventListener('pointerdown',   this._onDown)
    canvas.addEventListener('pointermove',   this._onMove)
    canvas.addEventListener('pointerup',     this._onUp)
    canvas.addEventListener('pointercancel', this._onCancel)
    canvas.addEventListener('pointerleave',  this._onLeave)
    canvas.addEventListener('wheel',         this._onWheel, { passive: false })
    canvas.addEventListener('contextmenu',   this._onContext)
    // Key/paste events on document so they fire even before the canvas is clicked.
    document.addEventListener('keydown',     this._onKey)
    document.addEventListener('paste',       this._onPaste)

    // Pinch-to-zoom applies translate()/scale() directly to the canvas
    // element; transform-origin 0,0 keeps the math in _point() simple.
    canvas.style.transformOrigin = '0 0'
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

  // Register a callback invoked when the user presses 'b' (send to background).
  setBackgroundAction(fn: () => void): void {
    this._backgroundAction = fn
  }

  // Register a callback invoked when the user presses 'm' (bring Menu to current layer).
  setMenuFocusAction(fn: () => void): void {
    this._menuFocusAction = fn
  }

  // Register a callback invoked on a system paste (Cmd/Ctrl+V) when no layer
  // is in in-place text-edit mode — e.g. to create a new TextLayer from the
  // clipboard text.
  setPasteAction(fn: (text: string) => void): void {
    this._pasteAction = fn
  }

  // Register a callback invoked on a system paste (Cmd/Ctrl+V) whose
  // clipboard data is an image — e.g. to create a new ImageLayer from it.
  setImagePasteAction(fn: (file: File) => void): void {
    this._imagePasteAction = fn
  }

  // Register a callback invoked when a bind-drag drop creates a binding.
  setBoundCallback(fn: (source: Node, slot: ParameterSlot) => void): void {
    this._onBound = fn
  }

  // Register a callback invoked when a bind-drag drop lands on the selected
  // layer but doesn't hit a slot or an ingest drop zone — e.g. dropping a
  // Mask-producing layer onto an Image/Fill/Noise/Video layer to wrap it in
  // a ClipLayer.
  setMaskDropCallback(fn: (source: Node, target: Layer) => void): void {
    this._onMaskDrop = fn
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
    this._canvas.removeEventListener('pointerleave',  this._onLeave)
    this._canvas.removeEventListener('wheel',         this._onWheel)
    this._canvas.removeEventListener('contextmenu',   this._onContext)
    document.removeEventListener('keydown',           this._onKey)
    document.removeEventListener('paste',             this._onPaste)
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  // Maps client (viewport) coordinates to canvas-pixel coordinates,
  // inverting any CSS transform applied to the canvas element (the
  // pinch-to-zoom magnifier scales/translates the canvas without affecting
  // its internal resolution or any layer's rendering/hit-testing).
  private _point(e: { clientX: number; clientY: number }): Point {
    const rect = this._canvas.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) * (this._canvas.width  / rect.width),
      y: (e.clientY - rect.top)  * (this._canvas.height / rect.height),
    }
  }

  // Returns the event position in viewport (client) coordinates — used for
  // interactions with the widget overlay canvas, which is always viewport-sized.
  private _viewportPoint(e: { clientX: number; clientY: number }): Point {
    return { x: e.clientX, y: e.clientY }
  }

  // Returns true when a client-space x coordinate falls within the widget strip.
  // Mirrors LayerStackWidget.inBounds but works in viewport coords so it stays
  // correct even when the content canvas is panned/zoomed.
  private _inWidgetStrip(clientX: number): boolean {
    return (this._widget?.isVisible ?? false) && clientX < stackWidgetWidth(Node.viewportWidth)
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

    const point = this._point(e)
    const isTouch = e.pointerType === 'touch'

    // Second touch of a two-finger gesture — pinch-zoom / two-finger tap on
    // the main canvas, or two-finger scroll on the stack widget. Only
    // recognised while a single touch is still deferred (not yet promoted
    // to a drag — see _promoteTouch).
    if (isTouch && this._touchPointers.size === 1 && this._active === null && !this._widgetCapture) {
      const first = [...this._touchPointers.values()][0]!
      if (first.promoteTimer !== null) {
        clearTimeout(first.promoteTimer)
        first.promoteTimer = null
      }
      this._touchPointers.set(e.pointerId, {
        x: point.x, y: point.y, startX: point.x, startY: point.y,
        clientX: e.clientX, clientY: e.clientY,
        startTime: performance.now(),
        inWidget: this._inWidgetStrip(e.clientX),
        hitNode: null, promoteTimer: null,
      })
      this._canvas.setPointerCapture(e.pointerId)

      const [second1, second2] = [...this._touchPointers.values()] as [TouchPointer, TouchPointer]
      if (!second1.inWidget && !second2.inWidget) {
        // Pinch-zoom / two-finger tap on the main canvas.
        const rect = this._canvas.getBoundingClientRect()
        this._pinchStart = {
          distance: Math.hypot(second2.clientX - second1.clientX, second2.clientY - second1.clientY),
          centroid: { x: (second1.clientX + second2.clientX) / 2, y: (second1.clientY + second2.clientY) / 2 },
          scale: this._zoomScale,
          pan: { x: this._panX, y: this._panY },
          rectLeft: rect.left, rectTop: rect.top,
          clientWidth: this._canvas.clientWidth, clientHeight: this._canvas.clientHeight,
        }
      } else if (second1.inWidget && second2.inWidget) {
        // Two-finger scroll on the stack widget.
        this._scrollCentroidY = (second1.clientY + second2.clientY) / 2
      }
      return
    }

    // If we are already tracking a pointer/gesture, ignore additional ones.
    if (this._active !== null || this._widgetCapture || this._touchPointers.size > 0) return

    if (!isTouch) {
      // Mouse/pen: immediate handling, unchanged.
      if (this._widget !== null && this._inWidgetStrip(e.clientX)) {
        if (this._widget.handlePointerDown(this._viewportPoint(e))) {
          this._widgetCapture = true
          this._canvas.setPointerCapture(e.pointerId)
          this._setCursor('grabbing')
        }
        return
      }

      if (this._stackTop === null) return

      const node = this._hitTest(point)

      if (node === null || !isDraggable(node)) {
        this._handleEmptyAreaClick(point)
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
      return
    }

    // Touch: defer for swipe/tap recognition. A press held for PROMOTE_MS
    // without lifting (or being joined by a second touch) is promoted to a
    // drag — node handle/slider/mask-paint drag, or stack-widget reorder —
    // by _promoteTouch. This lets a fast swipe take priority over any of
    // those, including over MaskLayer's paint/erase tools (which would
    // otherwise claim every touch immediately) and over node handles (which
    // would otherwise claim _active before a second finger can start a pinch).
    const inWidget = this._inWidgetStrip(e.clientX)
    let hitNode: Draggable | null = null
    if (!inWidget && this._stackTop !== null) {
      const node = this._hitTest(point)
      if (node !== null && isDraggable(node) && this._isOnCurrentLayer(node)) hitNode = node
    }
    this._deferTouch(e, point, inWidget, hitNode)
  }

  // Called PROMOTE_MS after a deferred touch, if it hasn't been lifted or
  // joined by a second touch in the meantime: promotes it to a drag using
  // its current (possibly moved) position.
  private _promoteTouch(pointerId: number): void {
    const tp = this._touchPointers.get(pointerId)
    if (tp === undefined) return
    tp.promoteTimer = null
    const point = { x: tp.x, y: tp.y }

    if (tp.inWidget) {
      const vpt = { x: tp.clientX, y: tp.clientY }
      const armed = (this._widget?.armRaisedDrag(vpt) ?? false) ||
                    (this._widget?.handlePointerDown(vpt) ?? false)
      if (armed) {
        this._touchPointers.delete(pointerId)
        this._widgetCapture = true
        this._setCursor('grabbing')
        Node.touchDragPoint = point
        Node.scheduleFrame?.()
      }
      return
    }

    if (tp.hitNode !== null && tp.hitNode.handlePointerDown(point)) {
      this._touchPointers.delete(pointerId)
      this._active = { node: tp.hitNode, pointerId }
      this._setCursor('grabbing')
      Node.touchDragPoint = point
      Node.scheduleFrame?.()
    }
  }

  private _handleMove(e: PointerEvent): void {
    const point = this._point(e)
    Node.pointerCanvas = point

    if (this._touchPointers.has(e.pointerId)) {
      this._handleTouchMove(e, point)
      return
    }

    const isTouch = e.pointerType === 'touch'

    if (this._widgetCapture) {
      this._widget?.handlePointerMove(this._viewportPoint(e))
      // Keep drag overlay position current (content-canvas coords for the overlay).
      if (Node.bindDrag.active) {
        Node.bindDrag.x = point.x
        Node.bindDrag.y = point.y
      }
      if (isTouch) {
        Node.touchDragPoint = point
        Node.scheduleFrame?.()
      }
      return
    }
    if (this._active !== null) {
      // Deliver move to the captured node only.
      if (e.pointerId !== this._active.pointerId) return
      this._active.node.handlePointerMove?.(point)
      if (isTouch) {
        Node.touchDragPoint = point
        Node.scheduleFrame?.()
      }
    } else {
      // No active drag — update the hover cursor.
      this._updateHoverCursor(e)
    }
  }

  private _handleUp(e: PointerEvent): void {
    const point = this._point(e)

    if (this._touchPointers.has(e.pointerId)) {
      this._handleTouchUp(e, point)
      return
    }

    if (e.pointerType === 'touch' && Node.touchDragPoint !== null) {
      Node.touchDragPoint = null
      Node.scheduleFrame?.()
    }

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
          } else if (!this._tryIngest(src, selected, point)) {
            this._onMaskDrop?.(src, selected)
          }
        }
      } else {
        this._widget?.handlePointerUp(this._viewportPoint(e))
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

  // Record a touch pointer that has not been claimed by a draggable node or
  // the widget's drag handling, pending swipe/tap/pinch/scroll/drag
  // recognition. Arms a PROMOTE_MS timer (see _promoteTouch) that promotes
  // the touch to a drag if it's still down (and alone) when it fires.
  private _deferTouch(e: PointerEvent, point: Point, inWidget: boolean, hitNode: Draggable | null): void {
    const tp: TouchPointer = {
      x: point.x, y: point.y, startX: point.x, startY: point.y,
      clientX: e.clientX, clientY: e.clientY,
      startTime: performance.now(), inWidget, hitNode,
      promoteTimer: null,
    }
    tp.promoteTimer = window.setTimeout(() => this._promoteTouch(e.pointerId), PROMOTE_MS)
    this._touchPointers.set(e.pointerId, tp)
    this._canvas.setPointerCapture(e.pointerId)
  }

  // A click/tap on an empty area of the main canvas that didn't hit a
  // draggable node: slot-row click takes priority, then pixel-pick.
  private _handleEmptyAreaClick(point: Point): void {
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
  }

  // Update a deferred touch pointer's tracked position, and drive the
  // live pinch-zoom transform / widget two-finger scroll while two
  // pointers are down.
  private _handleTouchMove(e: PointerEvent, point: Point): void {
    const tp = this._touchPointers.get(e.pointerId)
    if (tp === undefined) return
    tp.x = point.x; tp.y = point.y
    tp.clientX = e.clientX; tp.clientY = e.clientY

    if (this._touchPointers.size !== 2) return
    const [a, b] = [...this._touchPointers.values()] as [TouchPointer, TouchPointer]

    if (this._pinchStart !== null) {
      const { scale, panX, panY } = computePinchTransform(
        this._pinchStart,
        [{ x: a.clientX, y: a.clientY }, { x: b.clientX, y: b.clientY }],
        { width: window.innerWidth, height: window.innerHeight },
      )
      this._zoomScale = scale
      this._panX = panX
      this._panY = panY
      this._canvas.style.transform = (scale === 1 && panX === 0 && panY === 0)
        ? ''
        : `translate(${panX}px, ${panY}px) scale(${scale})`

      // Visual confirmation that the pinch was recognised: a line between
      // the two touch points, in canvas coordinates (post-transform).
      Node.pinchFeedback = {
        a: this._point({ clientX: a.clientX, clientY: a.clientY }),
        b: this._point({ clientX: b.clientX, clientY: b.clientY }),
      }
      Node.scheduleFrame?.()
    } else if (this._scrollCentroidY !== null) {
      const centroidY = (a.clientY + b.clientY) / 2
      this._widget?.scrollBy(this._scrollCentroidY - centroidY)
      this._scrollCentroidY = centroidY
    }
  }

  // Resolve a deferred touch pointer on release: either end a two-finger
  // gesture (recognising a two-finger tap), or classify a single-finger
  // gesture as a swipe (dispatching to the corresponding action) or a tap
  // (falling back to the equivalent click behaviour).
  private _handleTouchUp(e: PointerEvent, point: Point): void {
    const tp = this._touchPointers.get(e.pointerId)
    if (tp === undefined) return
    this._touchPointers.delete(e.pointerId)
    if (tp.promoteTimer !== null) clearTimeout(tp.promoteTimer)

    if (this._touchPointers.size === 1) {
      const [[otherId, other]] = [...this._touchPointers.entries()] as [[number, TouchPointer]]
      const moved = (p: TouchPointer) => Math.hypot(p.x - p.startX, p.y - p.startY) > TAP_MAX_MOVEMENT
      const duration = performance.now() - Math.min(tp.startTime, other.startTime)
      if (this._pinchStart !== null && !moved(tp) && !moved(other) && duration < TWO_FINGER_TAP_MS) {
        // Two-finger tap on the main canvas — toggle edit/display mode.
        this._closeInspector()
        this._spaceAction?.()
      }
      try { this._canvas.releasePointerCapture(otherId) } catch { /* already released */ }
      this._touchPointers.delete(otherId)
      this._pinchStart = null
      this._scrollCentroidY = null
      Node.pinchFeedback = null
      Node.scheduleFrame?.()
      return
    }

    this._pinchStart = null
    this._scrollCentroidY = null
    Node.pinchFeedback = null

    const dx = tp.x - tp.startX
    const dy = tp.y - tp.startY
    const dir = classifySwipe(dx, dy)

    if (tp.inWidget) {
      if (dir === 'up')        { this._flashGesture('up', 'widget');   this._widget?.raiseNext() }
      else if (dir === 'down') { this._flashGesture('down', 'widget'); this._widget?.raisePrev() }
      else                      this._widget?.tapSelect(point)
      return
    }

    switch (dir) {
      case 'up':    this._flashGesture('up', 'canvas');    this._widget?.navigateUp();   break
      case 'down':  this._flashGesture('down', 'canvas');  this._widget?.navigateDown(); break
      case 'left':  this._flashGesture('left', 'canvas');  this._deleteAction?.();       break
      case 'right': this._flashGesture('right', 'canvas'); this._backgroundAction?.();   break
      default:
        // No swipe — a tap. If it landed on a draggable node (button,
        // toggle, slider track, etc.), simulate a click via down+up.
        if (tp.hitNode !== null) {
          if (tp.hitNode.handlePointerDown(point)) {
            tp.hitNode.handlePointerUp?.()
            Node.scheduleFrame?.()
          } else {
            // Node claimed the point (e.g. dead space within a canvas-space
            // pill) but declined the tap — check for a slot-dot click,
            // mirroring the mouse path (_handleDown), but don't fall through
            // to pixel-pick: a miss on the current layer's own panel must
            // not re-pick the layer underneath.
            const sel = this._widget?.selected ?? null
            if (sel !== null) {
              const slot = sel.hitTestSlot(point)
              if (slot !== null) this._onSlotClick?.(sel, slot)
            }
          }
        } else {
          this._handleEmptyAreaClick(point)
        }
        break
    }
  }

  // Briefly flash a direction arrow over the canvas (or stack widget)
  // centre — visual confirmation that a swipe was recognised, to help
  // distinguish a recognised swipe from a tap that fell through to pixel-pick.
  private _flashGesture(dir: 'up' | 'down' | 'left' | 'right', target: 'canvas' | 'widget'): void {
    Node.gestureFlash = { dir, target, start: performance.now() }
    Node.scheduleFrame?.()
  }

  private _handleWheel(e: WheelEvent): void {
    if (this._inWidgetStrip(e.clientX)) {
      this._widget?.scrollBy(e.deltaY)
      e.preventDefault()
    }
  }

  // Returns true if `selected` ingested `src` (consuming the drop).
  private _tryIngest(src: Node, selected: Layer, point: Point): boolean {
    const s = selected as unknown as Record<string, unknown>
    if (typeof s['ingest'] !== 'function') return false
    const zone = s['dropZoneBounds'] as { x: number; y: number; width: number; height: number } | undefined | null
    if (!zone) return false
    if (point.x < zone.x || point.x > zone.x + zone.width ||
        point.y < zone.y || point.y > zone.y + zone.height) return false
    ;(s['ingest'] as (l: Node) => void)(src)
    this._refreshCallback?.()
    return true
  }

  private _handleKey(e: KeyboardEvent): void {
    // Let text inputs (textarea, input, contenteditable) handle their own keys.
    if (e.target instanceof HTMLElement &&
        e.target.closest('textarea, input, select, [contenteditable]')) return

    // A layer in in-place text-edit mode (e.g. TextLayer with the pointer
    // hovering its edit region) claims all keyboard input, including keys
    // that are normally global shortcuts (space, delete, m, h, ...).
    const selected = this._widget?.selected ?? null
    if (selected !== null && isTextEditTarget(selected) && selected.isTextEditActive()) {
      if (selected.handleTextEditKey(e)) { e.preventDefault(); return }
    }

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
    if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
      this._copyCanvasToClipboard()
      e.preventDefault()
      return
    }
    if (e.key === 'b' && !e.ctrlKey && !e.metaKey) {
      this._backgroundAction?.()
      e.preventDefault()
      return
    }
    if (e.key === 'm' && !e.ctrlKey && !e.metaKey) {
      this._menuFocusAction?.()
      e.preventDefault()
      return
    }
    if (this._widget !== null) {
      const key = e.shiftKey ? `Shift+${e.key}` : e.key
      if (this._widget.handleKey(key)) e.preventDefault()
    }
  }

  // System copy (Cmd/Ctrl+C). Writes the canvas's current pixels — whatever
  // is currently rendered, including controls/widgets in edit mode, or just
  // the composited image in display mode — to the system clipboard as a PNG.
  private _copyCanvasToClipboard(): void {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      console.warn('Copying the canvas to the clipboard is not supported in this browser.')
      return
    }
    const blobPromise = new Promise<Blob>((resolve, reject) => {
      this._canvas.toBlob((blob) => {
        if (blob !== null) resolve(blob)
        else reject(new Error('canvas.toBlob returned null'))
      }, 'image/png')
    })
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })])
      .catch(err => console.warn('Failed to copy canvas to clipboard:', err))
  }

  // System paste (Cmd/Ctrl+V). If the clipboard holds image data,
  // _imagePasteAction handles it (e.g. creating a new ImageLayer). Otherwise,
  // if a layer is in in-place text-edit mode, the pasted text goes to its
  // cursor; failing that, _pasteAction handles it (e.g. creating a new
  // TextLayer from the clipboard text).
  private _handlePaste(e: ClipboardEvent): void {
    if (e.target instanceof HTMLElement &&
        e.target.closest('textarea, input, select, [contenteditable]')) return

    const items = e.clipboardData?.items
    if (items && this._imagePasteAction !== null) {
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file !== null) {
            this._imagePasteAction(file)
            e.preventDefault()
            return
          }
        }
      }
    }

    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (!text) return

    const selected = this._widget?.selected ?? null
    if (selected !== null && isTextEditTarget(selected) && selected.isTextEditActive()) {
      selected.pasteTextAtCursor(text)
      e.preventDefault()
      return
    }

    if (this._pasteAction !== null) {
      this._pasteAction(text)
      e.preventDefault()
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
    const point = this._point(e)
    const selected = this._widget?.selected ?? null
    if (selected === null) return

    // Layers that handle their own right-click (e.g. PathLayer deleting a
    // control point) get first refusal before the slot-binding inspector.
    if (hasContextMenuHandler(selected) && selected.handleContextMenu(point)) return

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
    if (this._widget !== null && this._inWidgetStrip(e.clientX)) {
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
