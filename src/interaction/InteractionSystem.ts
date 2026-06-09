import type { Layer }           from '../core/Layer.js'
import type { Node }            from '../core/Node.js'
import type { Point }           from '../core/types.js'
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
  private _spaceAction: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement) {
    this._canvas = canvas

    this._onDown   = e => this._handleDown(e)
    this._onMove   = e => this._handleMove(e)
    this._onUp     = e => this._handleUp(e)
    this._onCancel = e => this._handleUp(e)   // treat cancel like up
    this._onKey    = e => this._handleKey(e)

    canvas.addEventListener('pointerdown',   this._onDown)
    canvas.addEventListener('pointermove',   this._onMove)
    canvas.addEventListener('pointerup',     this._onUp)
    canvas.addEventListener('pointercancel', this._onCancel)
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

  // Remove all event listeners.  Call when the canvas is torn down.
  destroy(): void {
    this._canvas.removeEventListener('pointerdown',   this._onDown)
    this._canvas.removeEventListener('pointermove',   this._onMove)
    this._canvas.removeEventListener('pointerup',     this._onUp)
    this._canvas.removeEventListener('pointercancel', this._onCancel)
    document.removeEventListener('keydown',           this._onKey)
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _point(e: PointerEvent): Point {
    return { x: e.offsetX, y: e.offsetY }
  }

  private _hitTest(point: Point): Node | null {
    const top = this._widget?.selected ?? this._stackTop
    return top?.hitTest(point) ?? null
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

    if (node === null || !isDraggable(node)) return

    // Only accept interaction on nodes belonging to the current layer.
    if (!this._isOnCurrentLayer(node)) return

    // Let the node decide whether to accept the event.
    if (!node.handlePointerDown(point)) return

    this._active = { node, pointerId: e.pointerId }
    this._canvas.setPointerCapture(e.pointerId)
    this._setCursor('grabbing')
  }

  private _handleMove(e: PointerEvent): void {
    const point = this._point(e)
    if (this._widgetCapture) {
      this._widget?.handlePointerMove(point)
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
      this._widget?.handlePointerUp(point)
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

  private _handleKey(e: KeyboardEvent): void {
    if (e.key === ' ') {
      this._spaceAction?.()
      e.preventDefault()
      return
    }
    if (this._widget !== null) {
      if (this._widget.handleKey(e.key)) e.preventDefault()
    }
  }

  // ----------------------------------------------------------
  // Cursor management
  // ----------------------------------------------------------

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
