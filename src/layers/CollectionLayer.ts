import { Layer } from '../core/Layer.js'
import { Node }  from '../core/Node.js'
import {
  ValueType,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { drawLayerThumbnail, typeColor } from '../interaction/thumbnail.js'

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

const ACCENT   = '#7ecf7e'   // Image type colour
const COLS     = 3
const TW       = 80          // thumbnail width
const TH       = 60          // thumbnail height
const CELL_GAP = 6
const GRID_PAD = 8

export class CollectionLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private _layers:          Layer[] = []
  private _compositeCanvas: OffscreenCanvas | null = null
  private _ejectCallback:   (() => void) | null = null

  // Double-click tracking
  private _lastClickTime = 0
  private _lastClickIdx  = -1

  constructor() {
    super()
    this.debugName = 'Collection'
    graph.register(this)
  }

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

    for (const layer of this._layers) {
      layer.evaluate()
      layer.renderSelf(ctx)
    }
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

    const idx = this._thumbIndexAt(point, gb)
    if (idx >= 0 && idx < this._layers.length) {
      const now = performance.now()
      if (idx === this._lastClickIdx && now - this._lastClickTime < 400) {
        // Double-click → eject
        this.eject(idx)
        this._lastClickIdx  = -1
        this._lastClickTime = 0
      } else {
        this._lastClickIdx  = idx
        this._lastClickTime = now
      }
      return true
    }

    return true   // consume click within the grid zone
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _gridBounds(): { x: number; y: number; width: number; height: number } {
    const { x, y, height } = this.canvasBounds
    const gridY = y + height + 8
    const rows  = Math.max(1, Math.ceil(this._layers.length / COLS))
    const gridH = GRID_PAD * 2 + rows * TH + (rows - 1) * CELL_GAP
    const gridW = GRID_PAD * 2 + COLS * TW + (COLS - 1) * CELL_GAP
    return { x, y: gridY, width: gridW, height: gridH }
  }

  private _thumbIndexAt(
    point: Point,
    gb: { x: number; y: number; width: number; height: number },
  ): number {
    const relX = point.x - gb.x - GRID_PAD
    const relY = point.y - gb.y - GRID_PAD
    if (relX < 0 || relY < 0) return -1
    const col = Math.floor(relX / (TW + CELL_GAP))
    const row = Math.floor(relY / (TH + CELL_GAP))
    if (col < 0 || col >= COLS) return -1
    if (relX % (TW + CELL_GAP) > TW)  return -1
    if (relY % (TH + CELL_GAP) > TH)  return -1
    return row * COLS + col
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
    ctx.fillText(
      n > 0 ? `${n} layer${n !== 1 ? 's' : ''}` : 'empty',
      x + w - 8, midY,
    )

    ctx.restore()
  }

  private _drawGrid(ctx: Ctx2D): void {
    const gb = this._gridBounds()
    const { x, y, width: gw, height: gh } = gb

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
      const cw = Node.canvasWidth
      const ch = Node.canvasHeight

      for (let i = 0; i < this._layers.length; i++) {
        const col = i % COLS
        const row = Math.floor(i / COLS)
        const tx  = x + GRID_PAD + col * (TW + CELL_GAP)
        const ty  = y + GRID_PAD + row * (TH + CELL_GAP)

        // Draw thumbnail into a small offscreen, then blit it clipped.
        const thumb    = new OffscreenCanvas(TW, TH)
        const thumbCtx = thumb.getContext('2d')!
        drawLayerThumbnail(thumbCtx, this._layers[i], TW, TH, cw, ch)

        ctx.save()
        ctx.beginPath()
        ctx.roundRect(tx, ty, TW, TH, 4)
        ctx.clip()
        ctx.drawImage(thumb, tx, ty)
        ctx.restore()

        // Cell border
        ctx.strokeStyle = typeColor(this._layers[i]) + '88'
        ctx.lineWidth   = 1
        ctx.beginPath()
        ctx.roundRect(tx + 0.5, ty + 0.5, TW - 1, TH - 1, 4)
        ctx.stroke()
      }
    }

    ctx.restore()
  }
}
