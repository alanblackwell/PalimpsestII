import { Layer } from '../core/Layer.js'
import { Node }  from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type CountSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { drawLayerThumbnail, typeColor } from '../interaction/thumbnail.js'
import { contentLeft } from '../interaction/layout.js'

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
// into any image-accepting slot (ClipLayer, TileLayer, …).
//
// Double-clicking a thumbnail in the grid ejects that layer
// back into the main stack, above the CollectionLayer.
//
// Visual layout (canvas-side):
//
//   ┌─────────────────────────────────────────┐  ← header pill
//   │ ▌  Collection                 N layers  │
//   └─────────────────────────────────────────┘
//   ┌─────────────────────────────────────────┐  ← thumbnail grid
//   │  [thumb] [thumb] [thumb]                │
//   │  [thumb] [thumb]                        │
//   │         drag layers here                │  ← when empty
//   └─────────────────────────────────────────┘

const ACCENT    = '#7ecf7e'  // Image type colour
const CELL_GAP  = 6
const GRID_PAD  = 8
const MIN_TW    = 60         // minimum thumbnail width (determines max columns)
const MAX_TW    = 120        // maximum thumbnail width (caps growth on wide screens)
const TH_RATIO  = 0.75       // height/width ratio (original 60/80)
const EMPTY_COLS = 3         // column count shown when grid is empty

// _gridBounds() returns this so callers share the same computed layout.
type GridLayout = {
  x: number; y: number; width: number; height: number
  tw: number; th: number; cols: number
}

export class CollectionLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private _layers:          Layer[] = []
  private _compositeCanvas: OffscreenCanvas | null = null
  private _ejectCallback:   (() => void) | null = null

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
    this.debugName = 'Collection'
    graph.register(this)
  }

  get indexSlot(): ParameterSlot { return this._indexSlot }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue {
    return this._layers.length > 0 ? this._compositeCanvas : null
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  setEjectCallback(fn: () => void): void {
    this._ejectCallback = fn
  }

  // Ingest a layer from the main stack into this collection.
  ingest(layer: Layer): void {
    if (this._layers.includes(layer)) return
    layer.removeFromStack()
    this._layers.push(layer)
    layer.addDependent(this)
    this.markDirty()
  }

  // The ingested layers, in render order — read by Persistence.ts to assign
  // ids to layers not otherwise reachable via the stack/background/archive.
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

  // Exposed for InteractionSystem duck-typing — drop zone for ingest.
  get dropZoneBounds(): { x: number; y: number; width: number; height: number } {
    return this._gridBounds()
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._layers.length === 0) {
      this._compositeCanvas = null
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

    const ctx = this._compositeCanvas.getContext('2d')!
    ctx.clearRect(0, 0, w, h)

    if (this._indexSlot.isActive) {
      const layer = this._layers[this.selectedIndex()]!
      layer.evaluate()
      layer.renderSelf(ctx)
    } else {
      for (const layer of this._layers) {
        layer.evaluate()
        layer.renderSelf(ctx)
      }
    }
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

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width: w, height: h } = this.canvasBounds
    if (w <= 0 || h <= 0) return
    this._drawHeaderPill(ctx, x, y, w, h)
    this._drawGrid(ctx)
  }

  // Slot rows are drawn below the thumbnail grid, not directly below the
  // header pill.
  override get panelBottom(): number {
    const gb = this._gridBounds()
    return gb.y + gb.height + 8
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
    const gb = this._gridBounds()
    if (!boundingBoxContains(gb, point)) return false

    const idx = this._thumbIndexAt(point, gb)   // visual index (0 = top-left = newest)
    if (idx >= 0 && idx < this._layers.length) {
      const now = performance.now()
      if (idx === this._lastClickIdx && now - this._lastClickTime < 400) {
        // Double-click → eject (convert visual index to array index)
        this.eject(this._layers.length - 1 - idx)
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
    const { tw, th, cols } = gb
    const rows = Math.ceil(n / cols)

    const relX = point.x - (gb.x + GRID_PAD)
    const relY = point.y - (gb.y + GRID_PAD)
    const row  = Math.max(0, Math.min(rows - 1, Math.floor(relY / (th + CELL_GAP))))
    const col  = Math.max(0, Math.min(cols - 1, Math.floor(relX / (tw + CELL_GAP))))
    const idx  = Math.min(row * cols + col, n - 1)

    // Left half of cell → insert before, right half → insert after
    const cellLeftX = gb.x + GRID_PAD + col * (tw + CELL_GAP)
    return point.x < cellLeftX + tw / 2 ? idx : idx + 1
  }

  private _commitReorder(): void {
    const vFrom = this._dragIdx   // visual drag index
    const vTo   = this._dropIdx   // visual insertion index (0..n)
    const n     = this._layers.length
    if (vFrom < 0 || vFrom >= n || vTo < 0 || vTo > n) return
    if (vTo === vFrom || vTo === vFrom + 1) return  // no-op

    // Visual index → array index: arrFrom = n-1-vFrom.
    // After removing arrFrom, insert so the item lands at visual position adjVTo
    // in the final n-item array. adjVTo accounts for the gap left by the removed
    // item shifting visual indices. The final array index = (n-1)-adjVTo, which
    // is the splice position in the post-removal (n-1)-item array.
    const arrFrom   = n - 1 - vFrom
    const adjVTo    = vTo > vFrom ? vTo - 1 : vTo
    const arrInsert = (n - 1) - adjVTo

    const [item] = this._layers.splice(arrFrom, 1)
    this._layers.splice(arrInsert, 0, item!)
    this.markDirty()
  }

  private _gridBounds(): GridLayout {
    // Use the full available width to the right of the widget strip — this
    // lets the column count grow on wide screens and shrink on narrow ones,
    // rather than being capped by the 260px panel pill width.
    const cw     = Node.canvasWidth
    const leftX  = contentLeft(cw)
    const availW = Math.max(MIN_TW + GRID_PAD * 2, cw - leftX - GRID_PAD - 16)
    const n      = this._layers.length

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
    const cb      = this.canvasBounds
    return { x: leftX, y: cb.y + cb.height + 8, width: gridW, height: gridH, tw, th, cols }
  }

  private _thumbIndexAt(point: Point, gb: GridLayout): number {
    const relX = point.x - gb.x - GRID_PAD
    const relY = point.y - gb.y - GRID_PAD
    if (relX < 0 || relY < 0) return -1
    const { tw, th, cols } = gb
    const col = Math.floor(relX / (tw + CELL_GAP))
    const row = Math.floor(relY / (th + CELL_GAP))
    if (col < 0 || col >= cols)         return -1
    if (relX % (tw + CELL_GAP) > tw)    return -1
    if (relY % (th + CELL_GAP) > th)    return -1
    return row * cols + col
  }

  private _drawHeaderPill(
    ctx: Ctx2D, x: number, y: number, w: number, h: number,
  ): void {
    const midY = y + h / 2

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, Math.min(h / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, h, [4, 0, 0, 4])
    ctx.fill()

    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Collection', x + 12, midY)

    const n = this._layers.length
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.textAlign = 'right'
    const countText = n > 0 ? `${n} layer${n !== 1 ? 's' : ''}` : 'empty'
    ctx.fillText(
      this._indexSlot.isActive && n > 0
        ? `#${this.selectedIndex()} of ${countText}`
        : countText,
      x + w - 8, midY,
    )

    ctx.restore()
  }

  private _drawGrid(ctx: Ctx2D): void {
    const gb = this._gridBounds()
    const { x, y, width: gw, height: gh, tw, th, cols } = gb

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

      // Iterate by visual position v (0 = top-left = most-recently-added).
      // Array index i = n-1-v so that _layers[n-1] (newest) appears first.
      for (let v = 0; v < n; v++) {
        if (isReordering && v === this._dragIdx) continue  // skip ghost source slot

        const i   = n - 1 - v
        const col = v % cols
        const row = Math.floor(v / cols)
        const tx  = x + GRID_PAD + col * (tw + CELL_GAP)
        const ty  = y + GRID_PAD + row * (th + CELL_GAP)

        const thumb    = new OffscreenCanvas(tw, th)
        const thumbCtx = thumb.getContext('2d')!
        drawLayerThumbnail(thumbCtx, this._layers[i]!, tw, th, cw, ch)

        ctx.save()
        if (isReordering) ctx.globalAlpha = 0.5
        ctx.beginPath()
        ctx.roundRect(tx, ty, tw, th, 4)
        ctx.clip()
        ctx.drawImage(thumb, tx, ty)
        ctx.restore()

        // Cell border — highlighted when this item is the active index.
        const isSelected = this._indexSlot.isActive && i === this.selectedIndex()
        ctx.strokeStyle = isSelected ? '#a0a0a0' : typeColor(this._layers[i]!) + '88'
        ctx.lineWidth   = isSelected ? 2 : 1
        ctx.beginPath()
        ctx.roundRect(tx + 0.5, ty + 0.5, tw - 1, th - 1, 4)
        ctx.stroke()
      }

      // Insertion line
      if (isReordering && this._dropIdx >= 0) {
        const k = this._dropIdx
        let lx: number, ly: number, lh: number
        if (k < n) {
          const col = k % cols
          const row = Math.floor(k / cols)
          lx = x + GRID_PAD + col * (tw + CELL_GAP)
          ly = y + GRID_PAD + row * (th + CELL_GAP)
          lh = th
        } else {
          const lastCol = (n - 1) % cols
          const lastRow = Math.floor((n - 1) / cols)
          lx = x + GRID_PAD + lastCol * (tw + CELL_GAP) + tw
          ly = y + GRID_PAD + lastRow * (th + CELL_GAP)
          lh = th
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.lineWidth   = 3
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.moveTo(lx, ly)
        ctx.lineTo(lx, ly + lh)
        ctx.stroke()
      }

      // Ghost thumbnail following the pointer
      if (isReordering && this._dragPt !== null && this._dragIdx < n) {
        const ghost    = new OffscreenCanvas(tw, th)
        const ghostCtx = ghost.getContext('2d')!
        drawLayerThumbnail(ghostCtx, this._layers[n - 1 - this._dragIdx]!, tw, th, cw, ch)

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
