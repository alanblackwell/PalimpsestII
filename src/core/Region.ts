import { Node } from './Node.js'
import type { Layer } from './Layer.js'
import { boundingBoxContains } from './types.js'

// ------------------------------------------------------------
// Region — a UI element that lives inside a Layer
// ------------------------------------------------------------
// Regions are sinks only: they can receive values via a bound
// parameter slot, but cannot be used as sources for other nodes
// without first being promoted to a Layer.

export abstract class Region extends Node {

  // The layer that owns this region.
  readonly parentLayer: Layer

  constructor(parent: Layer) {
    super()
    this.parentLayer = parent
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  // Whether this region is in an interactive (draggable/editable) state.
  // True when Unbound or SuspendedBound; false when Bound.
  get isInteractive(): boolean {
    return this.slots.every(slot => !slot.isActive)
  }

  // Hit-test: returns this region if the point falls within bounds.
  hitTest(point: { x: number; y: number }): Region | null {
    return boundingBoxContains(this.bounds, point) ? this : null
  }

  // ----------------------------------------------------------
  // Promotion
  // ----------------------------------------------------------

  // Promote this region to a Layer, making its value available
  // as a source in the stack. Returns the new Layer.
  // Subclasses that support promotion must override this.
  promoteToLayer(): Layer {
    throw new Error(`Region type ${this.constructor.name} does not support promotion`)
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  abstract renderSelf(ctx: OffscreenCanvasRenderingContext2D): void

  protected recompute(): void {
    // Default: pull value from bound slot and update visual appearance.
    // Subclasses override to reflect their specific value type.
  }
}
