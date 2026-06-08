import type { Layer } from '../core/Layer.js'
import type { Node }  from '../core/Node.js'
import type { Point } from '../core/types.js'

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

  // The node currently handling a drag gesture, and the pointer
  // that owns it (to support multi-touch correctly).
  private _active: { node: Draggable; pointerId: number } | null = null

  // Bound listener references retained so destroy() can remove them.
  private readonly _onDown:   (e: PointerEvent) => void
  private readonly _onMove:   (e: PointerEvent) => void
  private readonly _onUp:     (e: PointerEvent) => void
  private readonly _onCancel: (e: PointerEvent) => void

  constructor(canvas: HTMLCanvasElement) {
    this._canvas = canvas

    this._onDown   = e => this._handleDown(e)
    this._onMove   = e => this._handleMove(e)
    this._onUp     = e => this._handleUp(e)
    this._onCancel = e => this._handleUp(e)   // treat cancel like up

    canvas.addEventListener('pointerdown',   this._onDown)
    canvas.addEventListener('pointermove',   this._onMove)
    canvas.addEventListener('pointerup',     this._onUp)
    canvas.addEventListener('pointercancel', this._onCancel)
  }

  // ----------------------------------------------------------
  // Configuration
  // ----------------------------------------------------------

  // Set (or update) the top of the layer stack.
  setStack(top: Layer): void {
    this._stackTop = top
  }

  // Remove all event listeners.  Call when the canvas is torn down.
  destroy(): void {
    this._canvas.removeEventListener('pointerdown',   this._onDown)
    this._canvas.removeEventListener('pointermove',   this._onMove)
    this._canvas.removeEventListener('pointerup',     this._onUp)
    this._canvas.removeEventListener('pointercancel', this._onCancel)
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _point(e: PointerEvent): Point {
    return { x: e.offsetX, y: e.offsetY }
  }

  private _hitTest(point: Point): Node | null {
    return this._stackTop?.hitTest(point) ?? null
  }

  // ----------------------------------------------------------
  // Event handlers
  // ----------------------------------------------------------

  private _handleDown(e: PointerEvent): void {
    // If we are already tracking a pointer, ignore additional ones.
    // (Multi-touch is not yet supported.)
    if (this._active !== null) return
    if (this._stackTop === null) return

    const point = this._point(e)
    const node  = this._hitTest(point)

    if (node === null || !isDraggable(node)) return

    // Let the node decide whether to accept the event.
    if (!node.handlePointerDown(point)) return

    this._active = { node, pointerId: e.pointerId }
    this._canvas.setPointerCapture(e.pointerId)
    this._setCursor('grabbing')
  }

  private _handleMove(e: PointerEvent): void {
    if (this._active !== null) {
      // Deliver move to the captured node only.
      if (e.pointerId !== this._active.pointerId) return
      this._active.node.handlePointerMove?.(this._point(e))
    } else {
      // No active drag — update the hover cursor.
      this._updateHoverCursor(e)
    }
  }

  private _handleUp(e: PointerEvent): void {
    if (this._active === null) return
    if (e.pointerId !== this._active.pointerId) return

    this._active.node.handlePointerUp?.()
    this._active = null
    this._updateHoverCursor(e)
  }

  // ----------------------------------------------------------
  // Cursor management
  // ----------------------------------------------------------

  private _setCursor(cursor: string): void {
    this._canvas.style.cursor = cursor
  }

  private _updateHoverCursor(e: PointerEvent): void {
    if (this._stackTop === null) {
      this._setCursor('default')
      return
    }
    const node = this._hitTest(this._point(e))
    if (node !== null && isDraggable(node) && isInteractive(node)) {
      this._setCursor('pointer')
    } else {
      this._setCursor('default')
    }
  }
}
