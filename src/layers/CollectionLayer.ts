import { Layer } from '../core/Layer.js'
import { Node }  from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type MaskValue, type MaskSource,
  type CountSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { drawLayerThumbnail, typeColor } from '../interaction/thumbnail.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'
import { drawIcon, type IconName } from '../ui/icons.js'
import { sumEvalCost, hotspotBarFraction, hotspotWorst, drawHotspotGlow } from '../interaction/hotspot.js'

// ------------------------------------------------------------
// CollectionLayer — sub-stack that outputs a composite image
// ------------------------------------------------------------
//
// Layers are ingested by dragging their thumbnails from the
// LayerStackWidget onto the Collection's canvas panel.  Each
// ingested layer is removed from the main stack and rendered
// inside the Collection in order.
//
// The composite is exposed as an ImageSource so it can be fed
// into any image-accepting slot (ClipLayer, TileLayer, …). It's also a
// MaskSource: getMask() unions getMask() from every ingested item that's
// itself Mask-producing, so a collection of shapes can be dropped onto any
// Mask-typed slot as one aggregated region — see MaskLayer's collectionSlot,
// which pairs a single shapeSlot with this for "one shape, or any number
// via a collection" instead of a fixed row of shape slots.
//
// Double-clicking a thumbnail in the grid ejects that layer back into the
// main stack, above the CollectionLayer. Clicking a thumbnail's × button
// instead removes it straight to DeletionLayer's archive, bypassing the
// main stack entirely — same archive a normal stack deletion uses, so the
// layer is still restorable (double-click) or permanently purgeable (×)
// from there. The header's eject-all button (see ejectAll()) is the bulk
// form of the same double-click gesture: every item is restored to the
// stack at once, in original order, and this (now-empty) collection is
// itself archived the same way a plain Delete-key deletion would be.
//
// Visual layout (canvas-side):
//
//   ┌─────────────────────────────────────────┐  ← header pill — big
//   │ ▌  [ ⏏ ]  [ ⊞ ]  [ 💾 ]  [ 📂 ]        │    touch buttons: eject-all,
//   └─────────────────────────────────────────┘    layout toggle, Save, Load
//   ┌─────────────────────────────────────────┐  ← index-slot row (fixed
//   │  index               ○ Unbound          │    position — see panelBottom)
//   └─────────────────────────────────────────┘
//   ┌─────────────────────────────────────────┐  ← thumbnail grid
//   │  [thumb] [thumb] [thumb]                │
//   │  [thumb] [thumb]                        │
//   │         drag layers here                │  ← when empty
//   └─────────────────────────────────────────┘
//
// The grid's layout mode (row-wise, filling across before wrapping down; or
// column-wise, filling down before wrapping right) is a per-instance toggle
// — see _layout. Either way, array index 0 is the earliest-ingested layer
// (originally topmost in the main stack) and sits at the grid's top-left;
// composite render order is the *reverse* of array order, so that layer
// still ends up frontmost in the output — see recompute() and the `items`
// getter below for the full reasoning.

const ACCENT    = '#7ecf7e'  // Image type colour
const CELL_GAP  = 6
const GRID_PAD  = 8
// MIN_TW == MAX_TW: thumbnails wrap into more rows/columns rather than
// shrinking below a legible size — see _gridBounds(), which never produces
// a thumbnail smaller than MIN_TW/MIN_TH regardless of item count; the
// grid's own extent (unbounded — see _gridBounds()) grows instead.
const MIN_TW    = 120        // minimum thumbnail width (determines max columns, row layout)
const MAX_TW    = 120        // maximum thumbnail width (caps growth on wide screens)
const TH_RATIO  = 0.75       // height/width ratio (original 60/80)
const MIN_TH    = Math.floor(MIN_TW * TH_RATIO)  // minimum thumbnail height (determines max rows, column layout)
const MAX_TH    = Math.floor(MAX_TW * TH_RATIO)  // maximum thumbnail height
const EMPTY_COLS = 3         // column/row count shown when grid is empty
const TRASH_SZ  = 20         // × (delete-to-archive) button size — matches DeletionLayer
const TRASH_M   = 3          // margin from thumbnail top-right corner

// Big-button header row (eject-all / layout / Save / Load) — same
// LG_SZ/LG_GAP/LG_MARGIN convention and _bigGridRows/_bigGridCells wrap-
// into-a-grid layout as CaptureLayer's mode/shutter/save/share row (see
// CLAUDE.md's "Big-button mobile touch-target pass"). LG_SZ=52 matches
// CaptureLayer's own 4-button row exactly, rather than ImageLayer's 72
// (3 buttons, wider panel budget per button).
const LG_SZ     = 52
const LG_GAP    = 6
const LG_MARGIN = 10
// Height of the index-slot pill (Layer.renderSlotGroup's SLOT_H for a
// single-row group) — duplicated here since _gridBounds() needs it to
// place the grid below that row without actually drawing it.
const INDEX_PILL_H = 30

// _gridBounds() returns this so callers share the same computed layout.
type GridLayout = {
  x: number; y: number; width: number; height: number
  tw: number; th: number; cols: number; rows: number
}

type BBox = { x: number; y: number; width: number; height: number }

export class CollectionLayer extends Layer implements ImageSource, MaskSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image, ValueType.Mask])

  private _layers:          Layer[] = []
  private _compositeCanvas: OffscreenCanvas | null = null
  // Union of getMask() from every ingested item that's itself Mask-producing
  // — lets a CollectionLayer stand in anywhere a single Mask source could
  // (e.g. MaskLayer's collectionSlot), aggregating any number of shapes.
  private _maskCanvas:      OffscreenCanvas | null = null
  private _ejectCallback:   (() => void) | null = null
  private _deleteCallback:  ((layer: Layer) => void) | null = null
  private _onSave: (() => void) | null = null
  private _onLoad: (() => void) | null = null
  private _ejectAllCallback: ((topmost: Layer) => void) | null = null
  private _snapBounds: { minX: number; maxX: number; minY: number; maxY: number } | null = null

  // Grid layout mode: 'row' fills a row left-to-right before wrapping to a
  // new row below (grows downward as items are added); 'column' fills a
  // column top-to-bottom before wrapping to a new column to the right
  // (grows rightward). Persisted — see serializeState/deserializeState.
  private _layout: 'row' | 'column' = 'row'

  // When bound and active, selects a single item (by index, mod N) as the
  // collection's image value instead of the full composite.
  private readonly _indexSlot: ParameterSlot

  // Double-click tracking
  private _lastClickTime = 0
  private _lastClickIdx  = -1

  // Drag-to-reorder state
  private _dragIdx       = -1           // index of item being reordered (-1 = none)
  private _dragPt: Point | null = null  // current pointer position during drag
  private _dropIdx       = -1           // computed insertion index (0..n)
  private _downIdx       = -1           // index hit on pointerdown
  private _downPt: Point | null = null  // pointer position at pointerdown

  constructor() {
    super()
    this._indexSlot = new ParameterSlot(ValueType.Count, this, 'index')
    this.slots.push(this._indexSlot)
    this.displayBaseName = 'Collect'
    this.debugName = 'Collect'
    graph.register(this)
  }

  get indexSlot(): ParameterSlot { return this._indexSlot }

  override serializeState(): Record<string, unknown> {
    return { layout: this._layout }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (state.layout === 'row' || state.layout === 'column') this._layout = state.layout
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue {
    return this._layers.length > 0 ? this._compositeCanvas : null
  }

  // ----------------------------------------------------------
  // MaskSource
  // ----------------------------------------------------------

  getMask(): MaskValue {
    return this._layers.length > 0 ? this._maskCanvas : null
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  setEjectCallback(fn: () => void): void {
    this._ejectCallback = fn
  }

  // Called after deleteItem() sends a layer straight to the deletion
  // archive — caller (main.ts) is responsible for actually archiving it.
  setDeleteCallback(fn: (layer: Layer) => void): void {
    this._deleteCallback = fn
  }

  // Save/Load buttons in the header pill — export/import this collection's
  // contents as a standalone file. No file I/O happens in this layer; it
  // just calls back into main.ts, same as setEjectCallback/setDeleteCallback.
  setSaveLoadCallbacks(onSave: () => void, onLoad: () => void): void {
    this._onSave = onSave
    this._onLoad = onLoad
  }

  // Called after ejectAll() empties this collection back onto the main
  // stack, with the layer that ended up topmost — the caller (main.ts) is
  // responsible for archiving/removing this now-empty collection and
  // selecting that layer.
  setEjectAllCallback(fn: (topmost: Layer) => void): void {
    this._ejectAllCallback = fn
  }

  // Ingest a layer from the main stack into this collection.
  ingest(layer: Layer): void {
    if (this._layers.includes(layer)) return
    layer.removeFromStack()
    this._layers.push(layer)
    layer.addDependent(this)
    this.markDirty()
  }

  // The ingested layers, in ingestion order (oldest first — index 0 is the
  // layer that was originally topmost/frontmost in the main stack, since
  // the 'c' key ingests top-down; see main.ts). This is also the grid's
  // reading order (left-to-right / top-to-bottom depending on _layout) —
  // read by Persistence.ts to assign ids to layers not otherwise reachable
  // via the stack/background/archive. Composite render order is the
  // *reverse* of this (see recompute()), so a later-ingested layer ends up
  // backmost, matching where it was in the original stack.
  get items(): readonly Layer[] { return this._layers }

  // Restore previously-ingested layers on load (Persistence.ts). The layers
  // were never in the main stack (freshly constructed by LAYER_CLASSES), so
  // unlike ingest() there is nothing to remove from a stack.
  restoreItems(layers: Layer[]): void {
    for (const layer of layers) {
      if (this._layers.includes(layer)) continue
      this._layers.push(layer)
      layer.addDependent(this)
    }
    this.markDirty()
  }

  // Eject the layer at index back into the main stack (above this layer).
  eject(idx: number): void {
    if (idx < 0 || idx >= this._layers.length) return
    const layer = this._layers[idx]
    this._layers.splice(idx, 1)
    layer.removeDependent(this)
    layer.insertAbove(this)
    this.markDirty()
    this._ejectCallback?.()
  }

  // Restore every ingested item back to the main stack, directly above
  // this collection, preserving order: index 0 — the earliest-ingested
  // layer, originally topmost in the source stack (see the `items` getter
  // above) — ends up topmost again, with each later item directly below
  // it. Each insertAbove(this) call lands directly above the collection,
  // displacing whatever was inserted there previously to sit one further
  // up — the same single-item mechanics eject() uses, just applied to
  // every item in ascending array order so the whole run re-stacks in its
  // original top-to-bottom order. Fires _ejectAllCallback once, with the
  // restored topmost layer, after every item is back on the stack and
  // this collection is empty — unlike eject(), which fires _ejectCallback
  // once per call.
  ejectAll(): void {
    if (this._layers.length === 0) return
    const topmost = this._layers[0]!
    for (const layer of this._layers) {
      layer.removeDependent(this)
      layer.insertAbove(this)
    }
    this._layers.length = 0
    this.markDirty()
    this._ejectAllCallback?.(topmost)
  }

  // Remove the layer at index from the collection and send it straight to
  // the deletion archive — unlike eject(), it never re-enters the main
  // stack. Triggered by the × button on a thumbnail.
  deleteItem(idx: number): void {
    if (idx < 0 || idx >= this._layers.length) return
    const layer = this._layers[idx]!
    this._layers.splice(idx, 1)
    layer.removeDependent(this)
    this.markDirty()
    this._deleteCallback?.(layer)
  }

  // Exposed for InteractionSystem duck-typing — drop zone for ingest. The
  // whole content-canvas area counts (not just the thumbnail grid), so
  // dropping a dragged layer's thumbnail anywhere on the canvas — not just
  // precisely on the grid — ingests it into this collection, as long as the
  // collection is the selected layer (InteractionSystem._handleUp resolves
  // the drop target from `widget.selected`, not from what's under the
  // cursor, so this is safe: nothing else in that path keys off position
  // here besides the slot-row check, which still takes priority). The
  // drag-active highlight stays scoped to just the grid pill (_drawGrid).
  get dropZoneBounds(): { x: number; y: number; width: number; height: number } {
    const cw = Node.canvasWidth
    const x  = contentLeft(cw)
    return { x, y: 0, width: cw - x, height: Node.canvasHeight }
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._layers.length === 0) {
      this._compositeCanvas = null
      this._maskCanvas = null
      this._snapBounds = null
      return
    }

    const w = Node.canvasWidth
    const h = Node.canvasHeight

    if (
      this._compositeCanvas === null ||
      this._compositeCanvas.width  !== w ||
      this._compositeCanvas.height !== h
    ) {
      this._compositeCanvas = new OffscreenCanvas(w, h)
    }
    if (
      this._maskCanvas === null ||
      this._maskCanvas.width  !== w ||
      this._maskCanvas.height !== h
    ) {
      this._maskCanvas = new OffscreenCanvas(w, h)
    }

    const ctx  = this._compositeCanvas.getContext('2d')!
    const mctx = this._maskCanvas.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    mctx.clearRect(0, 0, w, h)

    let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity

    const renderAndAccum = (layer: Layer): void => {
      layer.evaluate()
      layer.renderSelf(ctx)
      if (layer.types.has(ValueType.Mask)) {
        const mask = (layer as unknown as MaskSource).getMask()
        if (mask !== null) mctx.drawImage(mask, 0, 0)
      }
      const b = layer.getSnapBounds()
      if (b !== null) {
        if (b.minX < bMinX) bMinX = b.minX
        if (b.maxX > bMaxX) bMaxX = b.maxX
        if (b.minY < bMinY) bMinY = b.minY
        if (b.maxY > bMaxY) bMaxY = b.maxY
      }
    }

    if (this._indexSlot.isActive) {
      renderAndAccum(this._layers[this.selectedIndex()]!)
    } else {
      // Render back-to-front in *reverse* ingestion order: the 'c' key
      // ingests top-down through the main stack (frontmost layer first,
      // see main.ts), and ingest() appends each new layer to the end of
      // _layers — so the earliest-ingested (originally frontmost) layer is
      // at index 0 and must be drawn *last* to stay frontmost, while the
      // most-recently-ingested (originally deepest in the stack) layer
      // must be drawn first, ending up backmost. This preserves the
      // original stack's visual order instead of flipping it.
      for (let i = this._layers.length - 1; i >= 0; i--) renderAndAccum(this._layers[i]!)
    }

    this._snapBounds = isFinite(bMinX) ? { minX: bMinX, maxX: bMaxX, minY: bMinY, maxY: bMaxY } : null
  }

  override getSnapBounds(): { minX: number; maxX: number; minY: number; maxY: number } | null {
    return this._snapBounds
  }

  // The currently-selected item index (indexSlot's Count, modulo the number
  // of items). Only meaningful when indexSlot.isActive and _layers is non-empty.
  selectedIndex(): number {
    const n = this._layers.length
    const raw = (this._indexSlot.source as CountSource).getCount()
    return ((raw % n) + n) % n
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    if (this._compositeCanvas === null) return
    ctx.drawImage(
      this._compositeCanvas as CanvasImageSource,
      0, 0, Node.canvasWidth, Node.canvasHeight,
    )
  }

  // Node.canvasWidth/Height only ever grow (see Evaluator.setViewport) —
  // deliberately, so mobile's address-bar-driven viewport changes don't
  // constantly reflow content. Node.viewportWidth/Height track the actual
  // current window exactly, both growing and shrinking. That grow-only
  // behaviour has no benefit on desktop and actively hurts the layout
  // logic below: after a desktop window is enlarged and then shrunk again,
  // canvasWidth/Height stay stuck at the larger size, so a naive
  // Node.canvasWidth-based reflow would keep sizing the grid for a window
  // that no longer exists. On desktop we want the header pill and grid to
  // always reflow to the *current* viewport instead, even though the
  // (grow-only) content canvas underneath may be larger. Mobile keeps the
  // existing canvasWidth/Height-based behaviour unchanged.
  private _layoutWidth(): number {
    return Node.isMobileDevice ? Node.canvasWidth : Node.viewportWidth
  }
  private _layoutHeight(): number {
    return Node.isMobileDevice ? Node.canvasHeight : Node.viewportHeight
  }

  // Overrides Layer.canvasBounds (which is always Node.canvasWidth-based,
  // and normally just this.bounds.height tall) for two reasons: (1) so the
  // header pill — and everything anchored to it (the big buttons below,
  // panelBottom, and _gridBounds()'s leftX) — reflows with the grid
  // instead of drifting out of sync with it on desktop; (2) the header
  // pill is now a grid of big touch buttons (see LG_SZ etc. above), taller
  // than the default strip height, and wrapping into more rows on a narrow
  // panel — see _headerPillHeight().
  override get canvasBounds(): { x: number; y: number; width: number; height: number } {
    const w     = this._layoutWidth()
    const width = panelWidth(w)
    return { x: contentLeft(w), y: 50, width, height: this._headerPillHeight(width) }
  }

  // Wrap-into-a-grid layout for N interchangeable big square buttons —
  // same shape as CaptureLayer's _bigGridRows/_bigGridCells (duplicated
  // per-layer rather than shared, matching the rest of the big-button
  // pass). Prefers wrapping into extra rows over shrinking the buttons
  // below LG_SZ when the panel is too narrow to fit all n in one row.
  private _bigGridRows(n: number, pillW: number): number {
    const availCols = Math.max(1, Math.floor((pillW - 2 * LG_MARGIN + LG_GAP) / (LG_SZ + LG_GAP)))
    const cols = Math.min(availCols, n)
    return Math.ceil(n / cols)
  }

  private _bigGridCells(n: number, pillX: number, pillW: number, top: number): BBox[] {
    const availCols = Math.max(1, Math.floor((pillW - 2 * LG_MARGIN + LG_GAP) / (LG_SZ + LG_GAP)))
    const cols = Math.min(availCols, n)
    const cells: BBox[] = []
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols), c = i % cols
      cells.push({
        x: pillX + LG_MARGIN + c * (LG_SZ + LG_GAP),
        y: top  + r * (LG_SZ + LG_GAP),
        width: LG_SZ, height: LG_SZ,
      })
    }
    return cells
  }

  private _headerPillHeight(width: number): number {
    const rows = this._bigGridRows(4, width)
    return LG_MARGIN * 2 + rows * LG_SZ + (rows - 1) * LG_GAP
  }

  // Bounds for the 4 header buttons, computed fresh from canvasBounds (not
  // cached) — same convention as _gridBounds/_trashBounds below — so
  // render and hit-testing can never disagree.
  private _bigBtnBounds(): { ejectAll: BBox; layout: BBox; save: BBox; load: BBox } {
    const { x, y, width } = this.canvasBounds
    const [ejectAll, layout, save, load] =
      this._bigGridCells(4, x, width, y + LG_MARGIN) as [BBox, BBox, BBox, BBox]
    return { ejectAll, layout, save, load }
  }

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width: w, height: h } = this.canvasBounds
    if (w <= 0 || h <= 0) return
    this._drawHeaderPill(ctx, x, y, w, h)
    this._drawGrid(ctx)
  }

  // The index-slot row is drawn directly below the header pill, *above*
  // the thumbnail grid — a fixed position, not derived from the grid's own
  // height, so it doesn't migrate toward the bottom of the viewport as the
  // collection grows (especially in column layout, where grid height
  // varies a lot as items are added). _gridBounds() positions the grid
  // below this same fixed row in turn — see INDEX_PILL_H.
  override get panelBottom(): number {
    const cb = this.canvasBounds
    return cb.y + cb.height + 8
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    if (boundingBoxContains(this.canvasBounds, point)) return this
    if (boundingBoxContains(this._gridBounds(), point))  return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    const { ejectAll, layout, save, load } = this._bigBtnBounds()
    if (boundingBoxContains(save, point)) {
      if (this._layers.length > 0) this._onSave?.()
      return true
    }
    if (boundingBoxContains(load, point)) {
      this._onLoad?.()
      return true
    }
    if (boundingBoxContains(layout, point)) {
      this._layout = this._layout === 'row' ? 'column' : 'row'
      this.markDirty()
      return true
    }
    if (boundingBoxContains(ejectAll, point)) {
      this.ejectAll()
      return true
    }

    const gb = this._gridBounds()
    if (!boundingBoxContains(gb, point)) return false

    // × button takes priority over thumbnail click/drag.
    const trashV = this._trashIndexAt(point, gb)
    if (trashV >= 0 && trashV < this._layers.length) {
      this.deleteItem(trashV)   // visual index === array index
      this._lastClickIdx  = -1
      this._lastClickTime = 0
      this._downIdx = -1
      this._downPt  = null
      return true
    }

    const idx = this._thumbIndexAt(point, gb)   // visual index === array index
    if (idx >= 0 && idx < this._layers.length) {
      const now = performance.now()
      if (idx === this._lastClickIdx && now - this._lastClickTime < 400) {
        // Double-click → eject
        this.eject(idx)
        this._lastClickIdx  = -1
        this._lastClickTime = 0
        this._downIdx = -1
        this._downPt  = null
      } else {
        // First click — record for potential double-click or drag
        this._lastClickIdx  = idx
        this._lastClickTime = now
        this._downIdx = idx
        this._downPt  = { ...point }
      }
      return true
    }

    return true   // consume click within the grid zone
  }

  handlePointerMove(point: Point): void {
    if (this._downIdx === -1) return

    if (this._dragIdx === -1) {
      // Check if we've moved past the drag threshold
      if (this._downPt !== null) {
        const dx = point.x - this._downPt.x
        const dy = point.y - this._downPt.y
        if (Math.hypot(dx, dy) > 8) {
          this._dragIdx = this._downIdx
          this._dragPt  = point
          this._dropIdx = this._computeDropIdx(point)
          this._lastClickIdx  = -1   // cancel pending double-click
          this._lastClickTime = 0
          Node.scheduleFrame?.()
        }
      }
      return
    }

    // Active drag — update position and insertion index
    this._dragPt  = point
    this._dropIdx = this._computeDropIdx(point)
    Node.scheduleFrame?.()
  }

  handlePointerUp(): void {
    if (this._dragIdx !== -1) this._commitReorder()
    this._dragIdx = -1
    this._dragPt  = null
    this._dropIdx = -1
    this._downIdx = -1
    this._downPt  = null
    Node.scheduleFrame?.()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _computeDropIdx(point: Point): number {
    const gb = this._gridBounds()
    const n  = this._layers.length
    if (n === 0) return 0
    const { tw, th, cols, rows } = gb
    const relX = point.x - (gb.x + GRID_PAD)
    const relY = point.y - (gb.y + GRID_PAD)

    if (this._layout === 'column') {
      const colCount = Math.ceil(n / rows)
      const col = Math.max(0, Math.min(colCount - 1, Math.floor(relX / (tw + CELL_GAP))))
      const row = Math.max(0, Math.min(rows - 1, Math.floor(relY / (th + CELL_GAP))))
      const idx = Math.min(col * rows + row, n - 1)
      // Top half of cell → insert before, bottom half → insert after
      const cellTopY = gb.y + GRID_PAD + row * (th + CELL_GAP)
      return point.y < cellTopY + th / 2 ? idx : idx + 1
    }

    const rowCount = Math.ceil(n / cols)
    const row = Math.max(0, Math.min(rowCount - 1, Math.floor(relY / (th + CELL_GAP))))
    const col = Math.max(0, Math.min(cols - 1, Math.floor(relX / (tw + CELL_GAP))))
    const idx = Math.min(row * cols + col, n - 1)
    // Left half of cell → insert before, right half → insert after
    const cellLeftX = gb.x + GRID_PAD + col * (tw + CELL_GAP)
    return point.x < cellLeftX + tw / 2 ? idx : idx + 1
  }

  private _commitReorder(): void {
    const from = this._dragIdx
    let to     = this._dropIdx   // insertion index (0..n), before removal
    const n    = this._layers.length
    if (from < 0 || from >= n || to < 0 || to > n) return
    if (to === from || to === from + 1) return  // no-op

    const [item] = this._layers.splice(from, 1)
    if (to > from) to--   // removal shifted everything after `from` left by one
    this._layers.splice(to, 0, item!)
    this.markDirty()
  }

  private _gridBounds(): GridLayout {
    const cw    = this._layoutWidth()
    const ch    = this._layoutHeight()
    const leftX = contentLeft(cw)
    const n     = this._layers.length
    const gridY = this.panelBottom + INDEX_PILL_H + 8

    if (this._layout === 'column') {
      // Column-wise: fill a column top-to-bottom before wrapping into a
      // new column to the right — the transpose of row-wise below. Bounded
      // by the available height from the grid top to the bottom of the
      // canvas, rather than by width, so it grows rightward instead of
      // downward as items are added.
      const availH  = Math.max(MIN_TH + GRID_PAD * 2, ch - gridY - GRID_PAD - 16)
      const maxRows = n > 0 ? n : EMPTY_COLS
      const rows    = Math.max(1, Math.min(maxRows, Math.floor((availH + CELL_GAP) / (MIN_TH + CELL_GAP))))
      const th      = Math.min(MAX_TH, Math.floor((availH - (rows - 1) * CELL_GAP) / rows))
      const tw      = Math.floor(th / TH_RATIO)
      const cols    = Math.max(1, Math.ceil(n / rows))
      const gridW   = GRID_PAD * 2 + cols * tw + (cols - 1) * CELL_GAP
      const gridH   = GRID_PAD * 2 + rows * th + (rows - 1) * CELL_GAP
      return { x: leftX, y: gridY, width: gridW, height: gridH, tw, th, cols, rows }
    }

    // Row-wise (default): fill a row left-to-right before wrapping into a
    // new row below. Use the full available width to the right of the
    // widget strip — this lets the column count grow on wide screens and
    // shrink on narrow ones, rather than being capped by the 260px panel
    // pill width.
    const availW = Math.max(MIN_TW + GRID_PAD * 2, cw - leftX - GRID_PAD - 16)

    // Allow as many columns as fit, but never more than the number of items
    // (no empty trailing columns). When the grid is empty, use EMPTY_COLS
    // to size the placeholder background.
    const maxCols = n > 0 ? n : EMPTY_COLS
    const cols    = Math.max(1, Math.min(maxCols, Math.floor((availW + CELL_GAP) / (MIN_TW + CELL_GAP))))
    const tw      = Math.min(MAX_TW, Math.floor((availW - (cols - 1) * CELL_GAP) / cols))
    const th      = Math.floor(tw * TH_RATIO)
    const rows    = Math.max(1, Math.ceil(n / cols))
    const gridW   = GRID_PAD * 2 + cols * tw + (cols - 1) * CELL_GAP
    const gridH   = GRID_PAD * 2 + rows * th + (rows - 1) * CELL_GAP
    return { x: leftX, y: gridY, width: gridW, height: gridH, tw, th, cols, rows }
  }

  // Top-left of the cell at array/visual index v (0 = top-left = the
  // earliest-ingested layer, i.e. originally topmost in the stack — see
  // the `items` getter above). Row layout fills left-to-right then wraps
  // down; column layout fills top-to-bottom then wraps right.
  private _cellOrigin(v: number, gb: GridLayout): { tx: number; ty: number } {
    const { x, y, tw, th, cols, rows } = gb
    let col: number, row: number
    if (this._layout === 'column') {
      row = v % rows
      col = Math.floor(v / rows)
    } else {
      col = v % cols
      row = Math.floor(v / cols)
    }
    return { tx: x + GRID_PAD + col * (tw + CELL_GAP), ty: y + GRID_PAD + row * (th + CELL_GAP) }
  }

  private _trashBounds(v: number, gb: GridLayout): BBox {
    const { tx, ty } = this._cellOrigin(v, gb)
    return {
      x:      tx + gb.tw - TRASH_M - TRASH_SZ,
      y:      ty + TRASH_M,
      width:  TRASH_SZ,
      height: TRASH_SZ,
    }
  }

  private _trashIndexAt(point: Point, gb: GridLayout): number {
    const n = this._layers.length
    for (let v = 0; v < n; v++) {
      const b = this._trashBounds(v, gb)
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) return v
    }
    return -1
  }

  private _thumbIndexAt(point: Point, gb: GridLayout): number {
    const relX = point.x - gb.x - GRID_PAD
    const relY = point.y - gb.y - GRID_PAD
    if (relX < 0 || relY < 0) return -1
    const { tw, th, cols, rows } = gb
    const col = Math.floor(relX / (tw + CELL_GAP))
    const row = Math.floor(relY / (th + CELL_GAP))
    if (relX % (tw + CELL_GAP) > tw)    return -1
    if (relY % (th + CELL_GAP) > th)    return -1
    if (this._layout === 'column') {
      if (row < 0 || row >= rows) return -1
      return col * rows + row
    }
    if (col < 0 || col >= cols) return -1
    return row * cols + col
  }

  // Big header buttons — same visual convention as CaptureLayer/CountLayer's
  // big-button rows: a light translucent background square, dimmed when
  // disabled, with the icon centred and scaled to the button size.
  private _drawBigBtn(ctx: Ctx2D, b: BBox, icon: IconName, enabled: boolean): void {
    ctx.fillStyle = enabled ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 6)
    ctx.fill()
    ctx.fillStyle = enabled ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.3)'
    drawIcon(ctx, icon, b.x + b.width / 2, b.y + b.height / 2, Math.min(b.width, b.height) - 16)
  }

  // Replaces the old thin label+status-text strip with a row of big touch
  // buttons — eject-all, row/column layout toggle, Save, Load — matching
  // the app-wide big-button pass. No text label/count readout: the accent
  // stripe plus the grid of thumbnails below already identify the layer
  // and its contents (and per the earlier "#N of M" readout, the selected
  // item is also visually marked by a highlighted cell border in the grid
  // — see _drawGrid), so a restated text status wasn't adding anything a
  // big-button pill needs to keep.
  private _drawHeaderPill(
    ctx: Ctx2D, x: number, y: number, w: number, h: number,
  ): void {
    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 8)
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, h, [4, 0, 0, 4])
    ctx.fill()

    const n = this._layers.length
    const { ejectAll, layout, save, load } = this._bigBtnBounds()
    this._drawBigBtn(ctx, ejectAll, 'eject', n > 0)
    this._drawBigBtn(ctx, layout, this._layout === 'row' ? 'layout-rows' : 'layout-columns', true)
    this._drawBigBtn(ctx, save, 'floppy-disk', n > 0)
    this._drawBigBtn(ctx, load, 'folder-open', true)

    ctx.restore()
  }

  private _drawGrid(ctx: Ctx2D): void {
    const gb = this._gridBounds()
    const { x, y, width: gw, height: gh, tw, th } = gb

    ctx.save()

    const isDragActive = Node.bindDrag.active
    ctx.fillStyle = isDragActive
      ? 'rgba(126,207,126,0.12)'
      : 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(x, y, gw, gh, 6)
    ctx.fill()

    if (isDragActive) {
      ctx.strokeStyle = 'rgba(126,207,126,0.55)'
      ctx.lineWidth   = 1.5
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.roundRect(x + 0.5, y + 0.5, gw - 1, gh - 1, 6)
      ctx.stroke()
      ctx.setLineDash([])
    }

    if (this._layers.length === 0) {
      ctx.fillStyle    = 'rgba(255,255,255,0.25)'
      ctx.font         = '10px monospace'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('drag layers here', x + gw / 2, y + gh / 2)
    } else {
      const cw          = Node.canvasWidth
      const ch          = Node.canvasHeight
      const n           = this._layers.length
      const isReordering = this._dragIdx >= 0

      // Hotspot glow — the "locate" half for this collection (same pattern
      // as DeletionLayer's Background tab, see interaction/hotspot.ts):
      // which single item is worst, gated by whether the collection's own
      // total has cleared the same "still smooth" floor the strip's load
      // bar uses. Note this is purely a *locate* signal — the collection's
      // own card in the stack widget already glows via the ordinary
      // on-stack hotspot path (CollectionLayer isn't hotspotExempt), since
      // its own evalCostMs already includes every ingested item's cost —
      // recompute() evaluates them synchronously inside the timed call, so
      // there's no separate backgroundCostMs-style total to fold in here,
      // unlike the Background collection (which is off-stack and would
      // otherwise be invisible to LayerStackWidget entirely).
      const collFrac = hotspotBarFraction(sumEvalCost(this._layers))
      const worst    = collFrac > 0 ? hotspotWorst(this._layers) : { node: null, load: 0 }

      // Iterate by index v = array index (0 = top-left = the earliest-
      // ingested layer, i.e. originally topmost in the stack — see the
      // `items` getter above; layout mode only changes how v maps to a
      // cell position, via _cellOrigin).
      for (let v = 0; v < n; v++) {
        if (isReordering && v === this._dragIdx) continue  // skip ghost source slot

        const { tx, ty } = this._cellOrigin(v, gb)

        // Cast before anything opaque covers this cell's footprint (the
        // thumbnail draw below), so only the shadow's outward bleed past
        // the rounded card shape remains visible — same technique as
        // every other hotspot glow in the app.
        if (this._layers[v] === worst.node) {
          ctx.save()
          ctx.translate(tx, ty)
          drawHotspotGlow(ctx, tw, th, worst.load, 4)
          ctx.restore()
        }

        const thumb    = new OffscreenCanvas(tw, th)
        const thumbCtx = thumb.getContext('2d')!
        drawLayerThumbnail(thumbCtx, this._layers[v]!, tw, th, cw, ch)

        ctx.save()
        if (isReordering) ctx.globalAlpha = 0.5
        ctx.beginPath()
        ctx.roundRect(tx, ty, tw, th, 4)
        ctx.clip()
        ctx.drawImage(thumb, tx, ty)
        ctx.restore()

        // Cell border — highlighted when this item is the active index.
        const isSelected = this._indexSlot.isActive && v === this.selectedIndex()
        ctx.strokeStyle = isSelected ? '#a0a0a0' : typeColor(this._layers[v]!) + '88'
        ctx.lineWidth   = isSelected ? 2 : 1
        ctx.beginPath()
        ctx.roundRect(tx + 0.5, ty + 0.5, tw - 1, th - 1, 4)
        ctx.stroke()

        // × button — removes the layer from the collection and sends it
        // straight to the deletion archive.
        const tb = this._trashBounds(v, gb)
        ctx.fillStyle = 'rgba(180,50,50,0.75)'
        ctx.beginPath()
        ctx.roundRect(tb.x, tb.y, tb.width, tb.height, 3)
        ctx.fill()
        ctx.fillStyle = 'rgba(255,255,255,0.90)'
        drawIcon(ctx, 'x', tb.x + tb.width / 2, tb.y + tb.height / 2, tb.height - 6)
      }

      // Insertion line — a vertical bar before/after a cell in row layout
      // (the growth direction is horizontal within a row), or a horizontal
      // bar in column layout (growth is vertical within a column).
      if (isReordering && this._dropIdx >= 0) {
        const k = this._dropIdx
        const column = this._layout === 'column'
        let lx: number, ly: number
        if (k < n) {
          const origin = this._cellOrigin(k, gb)
          lx = origin.tx
          ly = origin.ty
        } else {
          const last = this._cellOrigin(n - 1, gb)
          lx = last.tx + (column ? 0 : tw)
          ly = last.ty + (column ? th : 0)
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.lineWidth   = 3
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.moveTo(lx, ly)
        if (column) ctx.lineTo(lx + tw, ly)
        else        ctx.lineTo(lx, ly + th)
        ctx.stroke()
      }

      // Ghost thumbnail following the pointer
      if (isReordering && this._dragPt !== null && this._dragIdx < n) {
        const ghost    = new OffscreenCanvas(tw, th)
        const ghostCtx = ghost.getContext('2d')!
        drawLayerThumbnail(ghostCtx, this._layers[this._dragIdx]!, tw, th, cw, ch)

        const gx = this._dragPt.x - tw / 2
        const gy = this._dragPt.y - th / 2
        ctx.save()
        ctx.globalAlpha = 0.85
        ctx.beginPath()
        ctx.roundRect(gx, gy, tw, th, 4)
        ctx.clip()
        ctx.drawImage(ghost, gx, gy)
        ctx.restore()

        ctx.strokeStyle = 'rgba(255,255,255,0.7)'
        ctx.lineWidth   = 2
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.roundRect(gx + 0.5, gy + 0.5, tw - 1, th - 1, 4)
        ctx.stroke()
      }
    }

    ctx.restore()
  }
}
