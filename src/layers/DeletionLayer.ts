import { Layer }            from '../core/Layer.js'
import { Node }             from '../core/Node.js'
import { ValueType }        from '../core/types.js'
import type { Point, Ctx2D } from '../core/types.js'
import { typeColor, drawLayerThumbnail } from '../interaction/thumbnail.js'
import type { BackgroundLayer } from './BackgroundLayer.js'

// ------------------------------------------------------------
// DeletionLayer — archive for removed layers
// ------------------------------------------------------------
//
// Sits at the bottom of the stack (just above RootLayer).
// When a layer is deleted, it is removed from the stack and
// pushed onto this layer's archive list.
//
// Archived layers:
//   • Continue to evaluate so downstream bindings still work.
//   • Are shown as live thumbnails when DeletionLayer is selected.
//   • Can be restored by double-clicking their thumbnail.
//   • Can be permanently purged (with all bindings cleared) by
//     clicking the × button on each thumbnail.
//
// Interaction:
//   Single click  — select thumbnail (highlight)
//   Double-click  — restore layer to stack (just above DeletionLayer)
//   × button      — permanently purge; calls _onPurge(layer)
//   toggle button — switch the grid between the archive ("Deleted")
//                   and a linked BackgroundLayer's items ("Background")

const ACCENT  = '#9090a0'
const COLS    = 4
const TW      = 150
const TH      = 90
const GAP     = 8
const PANEL_X = 308
const PANEL_Y = 54
const HEADER  = 28
const PAD     = 10

const TRASH_SZ = 16     // size of the × button
const TRASH_M  = 3      // margin from thumbnail top-right corner

const TOGGLE_W = 110    // size of the "Deleted"/"Background" toggle button
const TOGGLE_H = 20

type BBox = { x: number; y: number; width: number; height: number }

export class DeletionLayer extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set()

  private _archived:      Layer[] = []
  private _background:    BackgroundLayer | null = null
  private _showBackground = false
  private _onRestore:     ((layer: Layer) => void) | null = null
  private _onPurge:       ((layer: Layer) => void) | null = null
  private _cpBounds:      BBox | null = null
  private _toggleBounds:  BBox | null = null
  private _selected:      number = -1    // highlighted thumbnail index
  private _lastClickTime = 0
  private _lastClickIdx  = -1

  constructor() {
    super()
    this.debugName = 'Deleted'
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  setRestoreCallback(fn: (layer: Layer) => void): void {
    this._onRestore = fn
  }

  // Called after permanent purge — caller is responsible for unbinding
  // any BindingLayers that still source from the purged layer.
  setPurgeCallback(fn: (layer: Layer) => void): void {
    this._onPurge = fn
  }

  // Links the Background collection so its items can be browsed via the
  // toggle button. Both lists share the restore/purge callbacks above.
  setBackgroundLayer(background: BackgroundLayer): void {
    this._background = background
  }

  /** Remove a layer from the stack and move it into this archive. */
  archive(layer: Layer): void {
    layer.removeFromStack()
    this._archived.push(layer)
    this.markDirty()
  }

  get archivedLayers(): readonly Layer[] { return this._archived }

  /** Remove a layer from the archive (without restoring it above the
   *  DeletionLayer) so the caller can re-insert it elsewhere. Returns
   *  true if the layer was found and removed. */
  removeFromArchive(layer: Layer): boolean {
    const idx = this._archived.indexOf(layer)
    if (idx < 0) return false
    this._archived.splice(idx, 1)
    if (this._selected === idx) this._selected = -1
    else if (this._selected > idx) this._selected -= 1
    this.markDirty()
    return true
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    // Keep archived layers evaluated so their outputs remain available
    // to any downstream nodes that are still bound to them.
    for (const layer of this._archived) {
      layer.evaluate()
    }
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(_ctx: Ctx2D): void {}

  renderPanel(ctx: Ctx2D): void {
    this._drawPill(ctx, this.bounds)
    this._drawGrid(ctx)
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  get isInteractive(): boolean {
    return this._activeItems().length > 0 || this._toggleBounds !== null
  }

  protected override hitTestSelf(point: Point): this | null {
    if (this._toggleBounds !== null && this._inBBox(point, this._toggleBounds)) return this
    if (this._cpBounds === null) return null
    const b = this._cpBounds
    if (point.x < b.x || point.x > b.x + b.width ||
        point.y < b.y || point.y > b.y + b.height) return null
    return (this._thumbAt(point) >= 0 || this._trashAt(point) >= 0) ? this : null
  }

  handlePointerDown(point: Point): boolean {
    if (this._toggleBounds !== null && this._inBBox(point, this._toggleBounds)) {
      this._showBackground = !this._showBackground
      this._selected      = -1
      this._lastClickIdx  = -1
      this.markDirty()
      return true
    }

    // Trash button takes priority over thumbnail click.
    const ti = this._trashAt(point)
    if (ti >= 0) {
      const items = this._activeItems()
      const layer = items[ti]!
      this._removeFromActive(ti)
      if (this._selected >= ti) this._selected = Math.max(-1, this._selected - 1)
      this.markDirty()
      this._onPurge?.(layer)
      return true
    }

    const idx = this._thumbAt(point)
    if (idx < 0) return false

    const now = performance.now()
    if (idx === this._lastClickIdx && now - this._lastClickTime < 400) {
      // Double-click → restore
      this._lastClickTime = 0
      this._lastClickIdx  = -1
      this._selected      = -1
      const layer = this._activeItems()[idx]!
      this._removeFromActive(idx)
      this.markDirty()
      this._onRestore?.(layer)
    } else {
      this._lastClickTime = now
      this._lastClickIdx  = idx
      this._selected      = idx
      this.markDirty()
    }
    return true
  }

  handlePointerUp(): void {}

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  // The list currently shown in the grid — the archive, or (when toggled)
  // the linked BackgroundLayer's items.
  private _activeItems(): readonly Layer[] {
    return this._showBackground ? (this._background?.items ?? []) : this._archived
  }

  // Remove the item at `idx` of the active list, without re-inserting it.
  private _removeFromActive(idx: number): void {
    if (this._showBackground) {
      const layer = this._background?.items[idx]
      if (layer) this._background!.removeItem(layer)
    } else {
      this._archived.splice(idx, 1)
    }
  }

  private _inBBox(point: Point, b: BBox): boolean {
    return point.x >= b.x && point.x <= b.x + b.width &&
           point.y >= b.y && point.y <= b.y + b.height
  }

  private _cellBounds(i: number): BBox {
    const gy  = PANEL_Y + HEADER + PAD
    const col = i % COLS
    const row = Math.floor(i / COLS)
    return {
      x:      PANEL_X + col * (TW + GAP),
      y:      gy      + row * (TH + GAP),
      width:  TW,
      height: TH,
    }
  }

  private _trashBounds(i: number): BBox {
    const c = this._cellBounds(i)
    return {
      x:      c.x + TW - TRASH_M - TRASH_SZ,
      y:      c.y + TRASH_M,
      width:  TRASH_SZ,
      height: TRASH_SZ,
    }
  }

  private _thumbAt(point: Point): number {
    const items = this._activeItems()
    for (let i = 0; i < items.length; i++) {
      const c = this._cellBounds(i)
      if (point.x >= c.x && point.x <= c.x + c.width &&
          point.y >= c.y && point.y <= c.y + c.height) return i
    }
    return -1
  }

  private _trashAt(point: Point): number {
    const items = this._activeItems()
    for (let i = 0; i < items.length; i++) {
      const t = this._trashBounds(i)
      if (point.x >= t.x && point.x <= t.x + t.width &&
          point.y >= t.y && point.y <= t.y + t.height) return i
    }
    return -1
  }

  private _drawGrid(ctx: Ctx2D): void {
    const items = this._activeItems()
    const n    = items.length
    const rows = Math.max(1, Math.ceil(n / COLS))
    const gridW = COLS * TW + (COLS - 1) * GAP
    const gridH = rows * TH + (rows - 1) * GAP
    const panW  = gridW + PAD * 2
    const panH  = HEADER + PAD + gridH + PAD
    const panX  = PANEL_X - PAD

    this._cpBounds = n > 0 ? { x: panX, y: PANEL_Y, width: panW, height: panH } : null

    // Toggle button — switches between the archive and the linked
    // BackgroundLayer's items. Hit-testable independent of _cpBounds, so
    // it still works when the active list is empty.
    this._toggleBounds = this._background !== null
      ? { x: panX + panW - TOGGLE_W - PAD, y: PANEL_Y + (HEADER - TOGGLE_H) / 2, width: TOGGLE_W, height: TOGGLE_H }
      : null

    ctx.save()

    // Panel background
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(panX, PANEL_Y, panW, panH, 10)
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(panX, PANEL_Y, 4, panH, [4, 0, 0, 4])
    ctx.fill()

    // Header label
    ctx.fillStyle    = 'rgba(255,255,255,0.55)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    const noun = this._showBackground ? 'background' : 'deleted'
    const hint = n === 0 ? `No ${noun} layers` : 'Double-click to restore'
    ctx.fillText(hint, panX + 14, PANEL_Y + HEADER / 2)

    // Toggle button
    if (this._toggleBounds !== null) {
      const tb = this._toggleBounds
      ctx.fillStyle = 'rgba(255,255,255,0.12)'
      ctx.beginPath()
      ctx.roundRect(tb.x, tb.y, tb.width, tb.height, tb.height / 2)
      ctx.fill()
      ctx.fillStyle    = 'rgba(255,255,255,0.75)'
      ctx.font         = '10px monospace'
      ctx.textAlign    = 'center'
      const label = this._showBackground ? `Deleted (${this._archived.length})` : `Background (${this._background!.items.length})`
      ctx.fillText(label, tb.x + tb.width / 2, tb.y + tb.height / 2)
      ctx.textAlign = 'left'
    }

    if (n === 0) { ctx.restore(); return }

    const cw = Node.canvasWidth
    const ch = Node.canvasHeight

    for (let i = 0; i < n; i++) {
      const layer  = items[i]!
      const c      = this._cellBounds(i)
      const tc     = typeColor(layer)
      const isSel  = i === this._selected

      // Card border / background
      ctx.fillStyle = isSel ? tc + '44' : tc + '1a'
      ctx.beginPath()
      ctx.roundRect(c.x, c.y, TW, TH, 6)
      ctx.fill()

      ctx.strokeStyle = isSel ? tc : tc + '55'
      ctx.lineWidth   = isSel ? 1.5 : 1
      ctx.beginPath()
      ctx.roundRect(c.x + 0.5, c.y + 0.5, TW - 1, TH - 1, 6)
      ctx.stroke()

      // Thumbnail clipped to card
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(c.x, c.y, TW, TH, 6)
      ctx.clip()
      ctx.translate(c.x, c.y)
      drawLayerThumbnail(ctx, layer, TW, TH, cw, ch)
      ctx.restore()

      // Left accent stripe on top of thumbnail
      ctx.fillStyle = tc + 'cc'
      ctx.beginPath()
      ctx.roundRect(c.x, c.y, 3, TH, [6, 0, 0, 6])
      ctx.fill()

      // × (trash) button — top-right corner
      const tb = this._trashBounds(i)
      ctx.fillStyle = 'rgba(180,50,50,0.75)'
      ctx.beginPath()
      ctx.roundRect(tb.x, tb.y, tb.width, tb.height, 3)
      ctx.fill()
      ctx.fillStyle    = 'rgba(255,255,255,0.90)'
      ctx.font         = 'bold 11px monospace'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('×', tb.x + tb.width / 2, tb.y + tb.height / 2)
    }

    ctx.restore()
  }

  private _drawPill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return
    const n = this._activeItems().length
    const label = this._showBackground ? 'Background' : 'Deleted'

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${label}  (${n})`, x + 12, y + height / 2)
    ctx.restore()
  }
}
