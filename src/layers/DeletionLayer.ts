import { Layer }            from '../core/Layer.js'
import { Node }             from '../core/Node.js'
import { ValueType }        from '../core/types.js'
import type { Point, Ctx2D } from '../core/types.js'
import { typeColor, drawLayerThumbnail } from '../interaction/thumbnail.js'
import type { BackgroundLayer } from './BackgroundLayer.js'
import { contentLeft } from '../interaction/layout.js'
import { drawIcon } from '../ui/icons.js'
import { sumEvalCost, hotspotBarFraction, hotspotWorst, drawHotspotGlow } from '../interaction/hotspot.js'

// ------------------------------------------------------------
// DeletionLayer — archive for removed layers, and browser for the
// live Background collection (its default view)
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
//   Single click — select thumbnail (highlight)
//   Double-click — restore layer to stack (just above DeletionLayer)
//   × button     — permanently purge; calls _onPurge(layer)
//   tabs         — "Background" / "Deleted" browser-style tabs switch the
//                  grid between a linked BackgroundLayer's items (the
//                  default view on selection) and the archive

const ACCENT   = '#9090a0'
const PANEL_Y  = 54
const HEADER   = 28
const PAD      = 10
const GAP      = 8
const TRASH_SZ = 20     // × button size
const TRASH_M  = 3      // margin from thumbnail top-right
const TAB_GAP  = 3      // gap between the Background/Deleted tabs
const TAB_R    = 8      // tab top-corner radius
const TAB_PAD_X = 14    // horizontal label padding inside each tab
const MAX_COLS = 4
const TW_MAX   = 180    // max thumbnail width
const TW_MIN   = 70     // min thumbnail width before dropping a column

// Responsive grid layout — recomputed each render from Node.canvasWidth,
// then cached here so hit-testing (which runs outside the render loop) uses
// the same geometry that was last drawn.
type Layout = {
  panX: number    // left edge of the grid panel background
  panW: number    // width of the grid panel background
  tw: number      // thumbnail cell width
  th: number      // thumbnail cell height
  cols: number    // number of columns
  gy: number      // y of the first thumbnail row
}

// Default layout matching the original hardcoded values, used before the
// first render.
const DEFAULT_LAYOUT: Layout = {
  panX: 298, panW: 648, tw: 150, th: 90, cols: 4, gy: PANEL_Y + HEADER + PAD,
}

type BBox = { x: number; y: number; width: number; height: number }

export class DeletionLayer extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set()
  override readonly hotspotExempt = true

  private _archived:      Layer[] = []
  private _background:    BackgroundLayer | null = null
  private _showBackground = false
  private _onRestore:     ((layer: Layer) => void) | null = null
  private _onPurge:       ((layer: Layer) => void) | null = null
  private _cpBounds:      BBox | null = null
  private _bgTabBounds:   BBox | null = null
  private _delTabBounds:  BBox | null = null
  private _selected:      number = -1
  private _lastClickTime = 0
  private _lastClickIdx  = -1
  private _layout:        Layout = DEFAULT_LAYOUT

  constructor() {
    super()
    this.debugName = 'Background'
  }

  // DeletionLayer is permanently part of the stack (directly above Root),
  // but stays invisible — like RootLayer — until either it holds an
  // archived layer or the user navigates to it directly.
  override get thumbnailOnlyWhenSelected(): boolean {
    return this._archived.length === 0
  }

  // Background items keep recomputing every frame (self-perpetuating, see
  // BackgroundLayer) even though they're invisible off-stack — this is
  // what lets LayerStackWidget fold that cost into the strip's load bar
  // and into this layer's own card glow. Scoped to Background only, not
  // the archive: the archive's own layers also keep evaluating (see
  // recompute() below), but the user asked specifically about the
  // Background collection — the archive is a natural follow-up, not yet
  // covered.
  override get backgroundCostMs(): number {
    return sumEvalCost(this._background?.items ?? [])
  }

  // Always default to the Background tab on entry — Deleted is now an
  // explicit tab switch rather than something the layer falls back to.
  override onSelected(): void {
    this._showBackground = true
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
    return this._activeItems().length > 0 ||
      this._bgTabBounds !== null || this._delTabBounds !== null
  }

  protected override hitTestSelf(point: Point): this | null {
    if (this._bgTabBounds  !== null && this._inBBox(point, this._bgTabBounds))  return this
    if (this._delTabBounds !== null && this._inBBox(point, this._delTabBounds)) return this
    if (this._cpBounds === null) return null
    const b = this._cpBounds
    if (point.x < b.x || point.x > b.x + b.width ||
        point.y < b.y || point.y > b.y + b.height) return null
    return (this._thumbAt(point) >= 0 || this._trashAt(point) >= 0) ? this : null
  }

  handlePointerDown(point: Point): boolean {
    if (this._bgTabBounds !== null && this._inBBox(point, this._bgTabBounds)) {
      if (!this._showBackground) {
        this._showBackground = true
        this._selected      = -1
        this._lastClickIdx  = -1
        this.markDirty()
      }
      return true
    }
    if (this._delTabBounds !== null && this._inBBox(point, this._delTabBounds)) {
      if (this._showBackground) {
        this._showBackground = false
        this._selected      = -1
        this._lastClickIdx  = -1
        this.markDirty()
      }
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
    const { panX, tw, th, cols, gy } = this._layout
    const col = i % cols
    const row = Math.floor(i / cols)
    return {
      x:      panX + PAD + col * (tw + GAP),
      y:      gy        + row * (th + GAP),
      width:  tw,
      height: th,
    }
  }

  private _trashBounds(i: number): BBox {
    const c  = this._cellBounds(i)
    const tw = this._layout.tw
    return {
      x:      c.x + tw - TRASH_M - TRASH_SZ,
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
    const n     = items.length

    // Responsive layout — compute from Node.canvasWidth (viewport width on
    // desktop during the temp-swap in Evaluator; content width on mobile).
    const cw      = Node.canvasWidth
    const leftX   = contentLeft(cw)
    const panX    = leftX - PAD                // align pill left edge with other panels
    const availW  = Math.max(TW_MIN + 1, cw - leftX - PAD - 16)
    const cols    = Math.max(1, Math.min(MAX_COLS, Math.floor((availW + GAP) / (TW_MIN + GAP))))
    const tw      = Math.min(TW_MAX, Math.floor((availW - (cols - 1) * GAP) / cols))
    const th      = Math.floor(tw * 0.60)
    const gy      = PANEL_Y + HEADER + PAD

    const rows    = Math.max(1, Math.ceil(n / cols))
    const gridW   = cols * tw + (cols - 1) * GAP
    const gridH   = rows * th + (rows - 1) * GAP
    const panW    = gridW + PAD * 2
    const panH    = HEADER + PAD + gridH + PAD

    // Cache layout so hit-testing (outside the render loop) uses the same
    // geometry that was last drawn.
    this._layout = { panX, panW, tw, th, cols, gy }

    this._cpBounds = n > 0 ? { x: panX, y: PANEL_Y, width: panW, height: panH } : null

    // Tab bounds — "Background" / "Deleted", sized to fit the longer label
    // so both tabs match width, browser-tab style.
    const bgLabel  = `Background (${this._background?.items.length ?? 0})`
    const delLabel = `Deleted (${this._archived.length})`
    ctx.font = '10px monospace'
    const tabW = Math.max(ctx.measureText(bgLabel).width, ctx.measureText(delLabel).width) + TAB_PAD_X * 2

    let tabX = panX + PAD
    if (this._background !== null) {
      this._bgTabBounds = { x: tabX, y: PANEL_Y, width: tabW, height: HEADER }
      tabX += tabW + TAB_GAP
    } else {
      this._bgTabBounds = null
    }
    this._delTabBounds = { x: tabX, y: PANEL_Y, width: tabW, height: HEADER }

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

    // Tabs — active tab shares the panel's fill and drops its bottom edge
    // so it visually fuses with the content area below; the inactive tab
    // sits behind it, dimmer, with a full border.
    this._drawTab(ctx, this._bgTabBounds,  bgLabel,  this._showBackground)
    this._drawTab(ctx, this._delTabBounds, delLabel, !this._showBackground)

    // Full-width separator along the tab row's straight bottom edge —
    // browser-tab style. Broken across the active tab's own width so that
    // tab still reads as fused with the grid below it.
    const tabLineY = PANEL_Y + HEADER + 0.5
    const activeTab = this._showBackground ? this._bgTabBounds : this._delTabBounds
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    if (activeTab !== null) {
      if (activeTab.x > panX) {
        ctx.moveTo(panX, tabLineY)
        ctx.lineTo(activeTab.x, tabLineY)
      }
      const activeRight = activeTab.x + activeTab.width
      if (activeRight < panX + panW) {
        ctx.moveTo(activeRight, tabLineY)
        ctx.lineTo(panX + panW, tabLineY)
      }
    } else {
      ctx.moveTo(panX, tabLineY)
      ctx.lineTo(panX + panW, tabLineY)
    }
    ctx.stroke()

    // Hint text — right-aligned in whatever header space the tabs leave;
    // skipped on narrow panels where it would collide with them.
    const tabsRight = this._delTabBounds.x + this._delTabBounds.width
    const hintX     = panX + panW - 14
    if (hintX - tabsRight > 60) {
      const noun = this._showBackground ? 'background' : 'deleted'
      const hint = n === 0 ? `No ${noun} layers` : 'Double-click to restore'
      ctx.fillStyle    = 'rgba(255,255,255,0.4)'
      ctx.font         = '10px monospace'
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(hint, hintX, PANEL_Y + HEADER / 2)
      ctx.textAlign = 'left'
    }

    if (n === 0) { ctx.restore(); return }

    const ch = Node.canvasHeight

    // Hotspot glow — the "locate" half for the Background collection (see
    // Layer.backgroundCostMs and spec/live-performance-hotspots.md), only
    // meaningful on the Background tab: which single item is worst, gated
    // by whether the Background collection's own total has cleared the
    // same "still smooth" floor the strip's load bar uses. Computed once
    // per _drawGrid call, not per item.
    const bgFrac  = this._showBackground ? hotspotBarFraction(this.backgroundCostMs) : 0
    const bgWorst = bgFrac > 0 ? hotspotWorst(items) : { node: null, load: 0 }

    for (let i = 0; i < n; i++) {
      const layer  = items[i]!
      const c      = this._cellBounds(i)
      const tc     = typeColor(layer)
      const isSel  = i === this._selected

      // Cast before anything opaque covers this cell's footprint (the
      // thumbnail draw below), so only the shadow's outward bleed past the
      // rounded card shape remains visible — same technique as the on-stack
      // card glow in LayerStackWidget._drawCard.
      if (layer === bgWorst.node) {
        ctx.save()
        ctx.translate(c.x, c.y)
        drawHotspotGlow(ctx, tw, th, bgWorst.load, 6)
        ctx.restore()
      }

      // Card border / background
      ctx.fillStyle = isSel ? tc + '44' : tc + '1a'
      ctx.beginPath()
      ctx.roundRect(c.x, c.y, tw, th, 6)
      ctx.fill()

      ctx.strokeStyle = isSel ? tc : tc + '55'
      ctx.lineWidth   = isSel ? 1.5 : 1
      ctx.beginPath()
      ctx.roundRect(c.x + 0.5, c.y + 0.5, tw - 1, th - 1, 6)
      ctx.stroke()

      // Thumbnail clipped to card
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(c.x, c.y, tw, th, 6)
      ctx.clip()
      ctx.translate(c.x, c.y)
      drawLayerThumbnail(ctx, layer, tw, th, cw, ch)
      ctx.restore()

      // Left accent stripe on top of thumbnail
      ctx.fillStyle = tc + 'cc'
      ctx.beginPath()
      ctx.roundRect(c.x, c.y, 3, th, [6, 0, 0, 6])
      ctx.fill()

      // × (trash) button — top-right corner
      const tb = this._trashBounds(i)
      ctx.fillStyle = 'rgba(180,50,50,0.75)'
      ctx.beginPath()
      ctx.roundRect(tb.x, tb.y, tb.width, tb.height, 3)
      ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,0.90)'
      drawIcon(ctx, 'x', tb.x + tb.width / 2, tb.y + tb.height / 2, tb.height - 6)
    }

    ctx.restore()
  }

  // A single browser-style tab. The active tab's fill matches the panel
  // body and it has no bottom border, so it reads as fused with the grid
  // immediately below; the inactive tab is dimmer with a full outline.
  private _drawTab(ctx: Ctx2D, b: BBox | null, label: string, active: boolean): void {
    if (b === null) return
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, [TAB_R, TAB_R, 0, 0])
    ctx.fillStyle = active ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.30)'
    ctx.fill()
    if (active) {
      ctx.fillStyle = ACCENT
      ctx.beginPath()
      ctx.roundRect(b.x, b.y, b.width, 3, [TAB_R, TAB_R, 0, 0])
      ctx.fill()
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.14)'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.roundRect(b.x + 0.5, b.y + 0.5, b.width - 1, b.height - 1, [TAB_R, TAB_R, 0, 0])
      ctx.stroke()
    }
    ctx.fillStyle    = active ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.40)'
    ctx.font         = '10px monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2 + 1)
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
