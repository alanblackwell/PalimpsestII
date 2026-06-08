import { Node } from './Node.js'
import type { Ctx2D } from './types.js'

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

  // Whether this layer is currently selected by the user.
  selected: boolean = false

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
    this.renderSelf(ctx)
  }

  // Render just this layer's own content. Subclasses must implement.
  abstract renderSelf(ctx: Ctx2D): void

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

  // Hit-test within this layer only. Subclasses may override.
  protected hitTestSelf(_point: { x: number; y: number }): Node | null {
    return null
  }
}
