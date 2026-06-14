import { ValueType, BoundingBox, emptyBoundingBox } from './types.js'
import type { ParameterSlot } from './ParameterSlot.js'
import type { Point } from './types.js'

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

  // Read-only view of `slots`, for the persistence walker (Persistence.ts),
  // which is not a Node subclass and so cannot see the protected field.
  get slotList(): readonly ParameterSlot[] { return this.slots }

  // ----------------------------------------------------------
  // Evaluator hook
  // Set by the Evaluator so that marking any node dirty triggers
  // a render frame without nodes needing to import the Evaluator.
  // ----------------------------------------------------------
  static scheduleFrame: (() => void) | null = null

  // Shared bind-drag state — set by LayerStackWidget, read by Layer.renderSlots
  // and Evaluator to draw the cursor overlay.
  static bindDrag: {
    active: boolean
    source: Node | null
    x: number
    y: number
  } = { active: false, source: null, x: 0, y: 0 }

  // Set by main.ts while an OS file (image) is being dragged over the canvas.
  // Read by Layer.renderSlots to highlight empty Image slots as drop targets.
  static fileDragActive = false

  // Current pointer position in canvas coordinates, updated by
  // InteractionSystem on every pointermove/pointerdown; null while the
  // pointer is outside the canvas. Read by PointLayer's "track" wander mode.
  static pointerCanvas: Point | null = null

  // Current canvas dimensions — updated by Evaluator on construction and resize.
  // Layers that produce full-canvas outputs (e.g. MaskLayer, ShapeLayer mask)
  // use these to size their OffscreenCanvases.
  static canvasWidth  = 800
  static canvasHeight = 600

  // ----------------------------------------------------------
  // Dependency management
  // ----------------------------------------------------------

  addDependent(node: Node): void {
    this._dependents.add(node)
  }

  removeDependent(node: Node): void {
    this._dependents.delete(node)
  }

  // Expose the dependent set for read-only use by the Graph (cycle detection).
  get dependents(): ReadonlySet<Node> {
    return this._dependents
  }

  markDirty(): void {
    if (this._dirty) return  // already dirty — stop propagation
    this._dirty = true
    Node.scheduleFrame?.()   // notify the evaluator a frame is needed
    for (const dep of this._dependents) {
      dep.markDirty()
    }
  }

  // Force dirty regardless of current state (e.g. for initial state or
  // after a bounds change that invalidates the cache).
  forceDirty(): void {
    this._dirty = true
    Node.scheduleFrame?.()
    for (const dep of this._dependents) dep.forceDirty()
  }

  get isDirty(): boolean { return this._dirty }

  // ----------------------------------------------------------
  // Evaluation
  // ----------------------------------------------------------

  // Subclasses implement this to recompute their value from slot inputs.
  protected abstract recompute(): void

  // Evaluate this node (and any dirty dependencies first).
  // Depth-first pull: resolves the dependency order naturally.
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

  // Returns the cached render canvas, evaluating first if dirty.
  getCachedRender(): OffscreenCanvas | null {
    this.evaluate()
    return this.cachedRender
  }

  // Ensure the cached canvas exists and matches the current bounds.
  protected ensureCanvas(): OffscreenCanvas {
    const { width, height } = this.bounds
    if (
      this.cachedRender === null ||
      this.cachedRender.width  !== Math.max(1, width) ||
      this.cachedRender.height !== Math.max(1, height)
    ) {
      this.cachedRender = new OffscreenCanvas(
        Math.max(1, width),
        Math.max(1, height),
      )
    }
    return this.cachedRender
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------
  // Subclasses override these to save/restore type-specific manual state
  // (numeric/boolean/string fields, geometry, encoded raster content, ...).
  // Never include bounds, debugName, stack links, hidden-helper links, or
  // slot bindings — the persistence walker/rebuilder handles those uniformly.
  // serializeState may return a value containing Promises (resolved by the
  // persistence layer before JSON encoding); deserializeState receives the
  // already-resolved plain values.
  serializeState(): Record<string, unknown> { return {} }
  deserializeState(_state: Record<string, unknown>): void {}
}
