import { Layer }            from '../core/Layer.js'
import { ValueType }        from '../core/types.js'
import type { Point, Ctx2D } from '../core/types.js'

// ------------------------------------------------------------
// DeletionLayer — archive for removed layers
// ------------------------------------------------------------
//
// Sits at the bottom of the stack (just above RootLayer).
// When a layer is deleted, it is removed from the stack and
// pushed onto this layer's archive list.
//
// Archived layers:
//   • Continue to evaluate, so downstream bindings still work.
//   • Are shown as thumbnails when DeletionLayer is selected.
//   • Can be restored by double-clicking their thumbnail.
//
// Interaction:
//   Single click  — select thumbnail (highlight)
//   Double-click  — restore layer to stack (just above DeletionLayer)

const ACCENT  = '#9090a0'
const COLS    = 4
const TW      = 150
const TH      = 90
const GAP     = 8
const PANEL_X = 308
const PANEL_Y = 54
const HEADER  = 28
const PAD     = 10

type BBox = { x: number; y: number; width: number; height: number }

export class DeletionLayer extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set()

  private _archived:      Layer[] = []
  private _onRestore:     ((layer: Layer) => void) | null = null
  private _cpBounds:      BBox | null = null
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

  /** Remove a layer from the stack and move it into this archive. */
  archive(layer: Layer): void {
    layer.removeFromStack()
    this._archived.push(layer)
    this.markDirty()
  }

  get archivedLayers(): readonly Layer[] { return this._archived }

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

  get isInteractive(): boolean { return this._archived.length > 0 }

  protected override hitTestSelf(point: Point): this | null {
    if (this._cpBounds === null) return null
    const b = this._cpBounds
    if (point.x < b.x || point.x > b.x + b.width ||
        point.y < b.y || point.y > b.y + b.height) return null
    return this._thumbAt(point) >= 0 ? this : null
  }

  handlePointerDown(point: Point): boolean {
    const idx = this._thumbAt(point)
    if (idx < 0) return false

    const now = performance.now()
    if (idx === this._lastClickIdx && now - this._lastClickTime < 400) {
      // Double-click → restore
      this._lastClickTime = 0
      this._lastClickIdx  = -1
      this._selected      = -1
      const layer = this._archived.splice(idx, 1)[0]!
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

  private _thumbAt(point: Point): number {
    const gy = PANEL_Y + HEADER + PAD
    for (let i = 0; i < this._archived.length; i++) {
      const col = i % COLS
      const row = Math.floor(i / COLS)
      const bx  = PANEL_X + col * (TW + GAP)
      const by  = gy       + row * (TH + GAP)
      if (point.x >= bx && point.x <= bx + TW &&
          point.y >= by && point.y <= by + TH) return i
    }
    return -1
  }

  private _drawGrid(ctx: Ctx2D): void {
    const n    = this._archived.length
    const rows = Math.max(1, Math.ceil(n / COLS))
    const gridW = COLS * TW + (COLS - 1) * GAP
    const gridH = rows * TH + (rows - 1) * GAP
    const panW  = gridW + PAD * 2
    const panH  = HEADER + PAD + gridH + PAD
    const panX  = PANEL_X - PAD

    this._cpBounds = n > 0 ? { x: panX, y: PANEL_Y, width: panW, height: panH } : null

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
    const hint = n === 0 ? 'No deleted layers' : 'Double-click to restore'
    ctx.fillText(hint, panX + 14, PANEL_Y + HEADER / 2)

    if (n === 0) {
      ctx.restore()
      return
    }

    const gy = PANEL_Y + HEADER + PAD

    for (let i = 0; i < n; i++) {
      const layer  = this._archived[i]!
      const col    = i % COLS
      const row    = Math.floor(i / COLS)
      const bx     = PANEL_X + col * (TW + GAP)
      const by     = gy       + row * (TH + GAP)
      const tc     = this._typeColor(layer)
      const isSel  = i === this._selected

      // Card background
      ctx.fillStyle = isSel ? tc + '44' : tc + '1a'
      ctx.beginPath()
      ctx.roundRect(bx, by, TW, TH, 6)
      ctx.fill()

      // Border
      ctx.strokeStyle = isSel ? tc : tc + '55'
      ctx.lineWidth   = isSel ? 1.5 : 1
      ctx.beginPath()
      ctx.roundRect(bx + 0.5, by + 0.5, TW - 1, TH - 1, 6)
      ctx.stroke()

      // Left accent stripe
      ctx.fillStyle = tc + 'cc'
      ctx.beginPath()
      ctx.roundRect(bx, by, 3, TH, [6, 0, 0, 6])
      ctx.fill()

      // Layer name
      ctx.fillStyle    = 'rgba(255,255,255,0.90)'
      ctx.font         = 'bold 12px monospace'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(layer.debugName, bx + TW / 2, by + TH / 2 - 9)

      // Type label
      ctx.fillStyle = tc
      ctx.font      = '10px monospace'
      ctx.fillText(this._typeName(layer), bx + TW / 2, by + TH / 2 + 9)
    }

    ctx.restore()
  }

  private _drawPill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return
    const n = this._archived.length

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
    ctx.fillText(`Deleted  (${n})`, x + 12, y + height / 2)
    ctx.restore()
  }

  private _typeColor(layer: Layer): string {
    const t = layer.types
    if (t.has(ValueType.Image))      return '#7ecf7e'
    if (t.has(ValueType.Mask))       return '#cfcf7e'
    if (t.has(ValueType.Colour))     return '#e8944a'
    if (t.has(ValueType.Amount))     return '#4a8fe8'
    if (t.has(ValueType.Direction))  return '#7ecfcf'
    if (t.has(ValueType.Point))      return '#cf7ecf'
    if (t.has(ValueType.Rate))       return '#e87e7e'
    if (t.has(ValueType.Count))      return '#a0a0a0'
    if (t.has(ValueType.Event))      return '#e0e060'
    if (t.has(ValueType.Collection)) return '#a0a4b8'
    return '#888888'
  }

  private _typeName(layer: Layer): string {
    const t = layer.types
    if (t.has(ValueType.Image))      return 'Image'
    if (t.has(ValueType.Mask))       return 'Mask'
    if (t.has(ValueType.Colour))     return 'Colour'
    if (t.has(ValueType.Amount))     return 'Amount'
    if (t.has(ValueType.Direction))  return 'Direction'
    if (t.has(ValueType.Point))      return 'Point / Shape'
    if (t.has(ValueType.Rate))       return 'Rate'
    if (t.has(ValueType.Count))      return 'Count'
    if (t.has(ValueType.Event))      return 'Event'
    if (t.has(ValueType.Collection)) return 'Collection'
    return 'Layer'
  }
}
