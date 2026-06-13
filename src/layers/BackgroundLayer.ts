import { Layer }     from '../core/Layer.js'
import { ValueType } from '../core/types.js'

// ------------------------------------------------------------
// BackgroundLayer — off-canvas collection of still-live layers
// ------------------------------------------------------------
//
// Holds layers that must keep recomputing every frame (so any downstream
// bindings to them stay live) but are never rendered onto the main canvas
// and have no thumbnail of their own.
//
// Not part of the layer stack at all (never inserted) — Evaluator calls
// evaluate() on it directly every frame, via Evaluator.setBackground(),
// the same way it ticks the Clock. While it holds items it keeps itself
// dirty via the same forceDirty/queueMicrotask self-perpetuation VideoLayer
// uses for its frame loop, so recompute() (and thus each item's evaluate())
// runs on every subsequent frame too.
//
// The grid UI for browsing/restoring/purging items lives on DeletionLayer,
// which can toggle between showing its own archive and this layer's items
// (see DeletionLayer._showBackground).

export class BackgroundLayer extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set()

  private _items: Layer[] = []

  constructor() {
    super()
    this.debugName = 'Background'
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  get items(): readonly Layer[] { return this._items }

  /** Remove a layer from the stack and move it into this collection. */
  add(layer: Layer): void {
    layer.removeFromStack()
    this._items.push(layer)
    this.markDirty()
  }

  /** Remove a layer from this collection (without re-inserting it) so the
   *  caller can put it back in the main stack or purge it. */
  removeItem(layer: Layer): boolean {
    const idx = this._items.indexOf(layer)
    if (idx < 0) return false
    this._items.splice(idx, 1)
    return true
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    for (const layer of this._items) layer.evaluate()

    // Self-perpetuate: keep this layer dirty every frame while it holds
    // items, even though nothing in the active stack depends on it
    // directly (same pattern as VideoLayer's frame loop).
    if (this._items.length > 0) {
      queueMicrotask(() => this.forceDirty())
    }
  }
}
