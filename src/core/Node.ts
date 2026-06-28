import { ValueType, BoundingBox, emptyBoundingBox } from './types.js'
import type { ParameterSlot } from './ParameterSlot.js'
import type { Point, Ctx2D } from './types.js'

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

  // Feedback dependents — registered by ParameterSlot.feedback slots.
  // Receive dirty propagation identically to _dependents but are NOT
  // traversed by Graph.canBind's cycle-detection BFS, so feedback edges
  // are allowed to form cycles in the dependency graph.  The canonical
  // use-case is EventLayer's image inputs: the event fires based on the
  // (cached) images, and those same images may react to the event —
  // a one-frame-delay loop that's semantically correct but would otherwise
  // be rejected as a cycle.
  private readonly _feedbackDependents = new Set<Node>()

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
  static clock: { readonly paused: boolean } | null = null
  static widgetVisible  = true
  static helpVisible    = false

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

  // Current viewport dimensions — updated by Evaluator.setViewport(). Distinct
  // from canvasWidth/Height when the window is smaller than the content canvas
  // (canvas only ever grows; viewport tracks the actual browser window size).
  static viewportWidth  = 800
  static viewportHeight = 600

  // True on touch-primary devices (pointer: coarse). Set once at startup by
  // main.ts. Controls whether control pills render on the content canvas
  // (mobile: pills zoom/pan with canvas) or the widget overlay canvas
  // (desktop: pills stay fixed in the viewport).
  static isMobileDevice = false

  // The layer the Evaluator is rendering as "current" this frame — the one
  // that floats above the rest with a drop shadow in edit mode (null in
  // display mode, where no layer gets that treatment). Lets a layer's own
  // renderSelf match the same drop-shadow-only-when-current convention for
  // effects it draws itself (e.g. TextLayer's text shadow).
  static currentLayer: Node | null = null

  // Set by main.ts to `(layer) => { widget.selected = layer }`. Lets any
  // layer programmatically change the selected/current layer — e.g.
  // CaptureLayer's edit-mode shutter sequence, which briefly selects the
  // layer below to reveal its controls before restoring the selection.
  static selectLayer: ((layer: Node) => void) | null = null

  // Set by main.ts to `(ctx) => widget.render(ctx, true)`. Lets any layer
  // draw the LayerStackWidget onto its own canvas regardless of the live
  // widget's on-screen visibility — used by CaptureLayer's stack-capture
  // toggle.
  static renderStackWidget: ((ctx: Ctx2D) => void) | null = null

  // Set by main.ts to `(node) => backgroundLayer.add(node)`. Lets layers
  // auto-create a source that stays live (evaluated each frame via the
  // BackgroundLayer) without appearing in the main stack. The user can
  // retrieve it by clicking the bound slot.
  static sendToBackground: ((layer: Node) => void) | null = null

  // Set by InteractionSystem when a touch swipe gesture is recognised; read
  // by Evaluator to briefly flash a direction arrow over the canvas (or
  // stack widget) centre — visual confirmation that the swipe registered,
  // rather than falling through to a tap/click.
  static gestureFlash: {
    dir: 'up' | 'down' | 'left' | 'right'
    target: 'canvas' | 'widget'
    start: number   // performance.now() at recognition
  } | null = null

  // Set by InteractionSystem while a touch-driven drag (node handle/slider,
  // mask paint, or stack-widget reorder) is in progress; read by Evaluator
  // to draw a crosshair at the drop/edit point, since a finger occludes the
  // canvas under it. Null when no touch drag is active.
  static touchDragPoint: Point | null = null

  // Set by InteractionSystem while a two-finger pinch gesture is in
  // progress (canvas-space coordinates of the two touch points); read by
  // Evaluator to draw a connecting line as visual confirmation that the
  // pinch was recognised. Null when no pinch is active.
  static pinchFeedback: { a: Point; b: Point } | null = null

  // Set by InteractionSystem; called by layers that need to snap the
  // canvas view back to identity (scale=1, pan=0,0) — e.g. VideoLayer's
  // fit/fill toggle so the video aligns with the physical screen.
  static resetViewTransform: (() => void) | null = null

  static outlineMode = false

  // ----------------------------------------------------------
  // Dependency management
  // ----------------------------------------------------------

  addDependent(node: Node): void {
    this._dependents.add(node)
  }

  removeDependent(node: Node): void {
    this._dependents.delete(node)
  }

  addFeedbackDependent(node: Node): void {
    this._feedbackDependents.add(node)
  }

  removeFeedbackDependent(node: Node): void {
    this._feedbackDependents.delete(node)
  }

  // Expose the dependent set for read-only use by the Graph (cycle detection).
  // Intentionally excludes _feedbackDependents so feedback edges are invisible
  // to canBind's BFS.
  get dependents(): ReadonlySet<Node> {
    return this._dependents
  }

  markDirty(): void {
    if (this._dirty) return  // already dirty — stop propagation
    this._dirty = true
    Node.scheduleFrame?.()   // notify the evaluator a frame is needed
    for (const dep of this._dependents)         dep.markDirty()
    for (const dep of this._feedbackDependents) dep.markDirty()
  }

  // Force dirty regardless of current state (e.g. for initial state or
  // after a bounds change that invalidates the cache).
  forceDirty(): void {
    this._dirty = true
    Node.scheduleFrame?.()
    for (const dep of this._dependents)         dep.forceDirty()
    for (const dep of this._feedbackDependents) dep.forceDirty()
  }

  get isDirty(): boolean { return this._dirty }

  // ----------------------------------------------------------
  // Evaluation
  // ----------------------------------------------------------

  // Subclasses implement this to recompute their value from slot inputs.
  protected abstract recompute(): void

  // Evaluate this node (and any dirty dependencies first).
  // Depth-first pull: resolves the dependency order naturally.
  // Feedback slots are skipped — they always read the source's cached
  // value from the previous evaluation, breaking circular dependencies.
  evaluate(): void {
    for (const slot of this.slots) {
      if (slot.isActive && !slot.feedback) {
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
