import { ValueType, BoundingBox, emptyBoundingBox } from './types.js'
import type { ParameterSlot } from './ParameterSlot.js'

// ------------------------------------------------------------
// Node — base class for all entities in the dataflow graph
// ------------------------------------------------------------

export abstract class Node {
  // The type(s) this node satisfies. Most nodes satisfy exactly one type;
  // some satisfy multiple (e.g. a point sampler satisfies Image and Point).
  abstract readonly types: ReadonlySet<ValueType>

  // Spatial footprint on the canvas.
  bounds: BoundingBox = emptyBoundingBox()

  // Debug label.
  debugName: string = 'unnamed'

  // Cached render output. Null until first evaluation.
  protected cachedRender: OffscreenCanvas | null = null

  // Dirty flag: true means the cached value is stale.
  private _dirty = true

  // Nodes that depend on this one. When this node is marked dirty,
  // all dependents are marked dirty too (push invalidation).
  private readonly _dependents = new Set<Node>()

  // The parameter slots declared by this node.
  protected readonly slots: ParameterSlot[] = []

  // ----------------------------------------------------------
  // Dependency management
  // ----------------------------------------------------------

  addDependent(node: Node): void {
    this._dependents.add(node)
  }

  removeDependent(node: Node): void {
    this._dependents.delete(node)
  }

  markDirty(): void {
    if (this._dirty) return  // already dirty — stop propagation
    this._dirty = true
    for (const dep of this._dependents) {
      dep.markDirty()
    }
  }

  get isDirty(): boolean { return this._dirty }

  // ----------------------------------------------------------
  // Evaluation
  // ----------------------------------------------------------

  // Subclasses implement this to recompute their value from slot inputs.
  protected abstract recompute(): void

  // Evaluate this node (and any dirty dependencies first).
  // Call this before reading the node's value or render output.
  evaluate(): void {
    for (const slot of this.slots) {
      if (slot.isActive) {
        slot.source!.evaluate()
      }
    }
    if (this._dirty) {
      this.recompute()
      this._dirty = false
    }
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  // Returns the cached render, evaluating first if dirty.
  getrender(): OffscreenCanvas | null {
    this.evaluate()
    return this.cachedRender
  }

  // Ensure the cached canvas matches the current bounds.
  protected ensureCanvas(): OffscreenCanvas {
    const { width, height } = this.bounds
    if (
      this.cachedRender === null ||
      this.cachedRender.width !== width ||
      this.cachedRender.height !== height
    ) {
      this.cachedRender = new OffscreenCanvas(
        Math.max(1, width),
        Math.max(1, height),
      )
    }
    return this.cachedRender
  }
}
