import { Layer }     from '../core/Layer.js'
import { Node }      from '../core/Node.js'
import type { Ctx2D, Point } from '../core/types.js'
import { typeColor, drawLayerThumbnail } from './thumbnail.js'
import { stackWidgetWidth } from './layout.js'

// ------------------------------------------------------------
// LayerStackWidget — overlapping thumbnail card stack
// ------------------------------------------------------------
//
// Renders a stack of partly-overlapping tilted thumbnail cards
// on the left side of the canvas, faithfully reproducing the
// visual character of the original Palimpsest.
//
// Visual parameters (all matching the original Java implementation):
//   • 2° clockwise tilt per card
//   • 6 px shadow radius (blur 12)
//   • 90 % card opacity; selected layer at 100 %
//   • Selected card: rgb(168, 240, 240) background — the original
//     exact selection colour
//
// Card thumbnails show each layer's current visual output:
//   Image layers    → downscaled offscreen canvas
//   Colour layers   → solid colour swatch
//   Amount layers   → filled value bar
//   Point layers    → crosshair + dot at the current point
//   Direction layers→ arrow at the current angle / magnitude
//   Event layers    → flash that decays over 1 s after each pulse
//   Count layers    → large counter numeral
//   Root layer      → scaled checkerboard
//   Others          → type-tinted background
//
// Interaction:
//   Click  → select the layer (highlighted in cyan)
//   Drag   → reorder: cards animate apart to show drop position;
//             dropping commits the move into the live stack
//
// Call setStack(topLayer) after the stack is fully wired.
// Call render(ctx) from the Evaluator each frame.

// ── Visual constants ─────────────────────────────────────────

const CARD_X      = 16      // left margin within strip (room for shadow + tilt)
const CARD_MARGIN = 20      // gap between the card's right edge and the strip's right edge
const TILT        = Math.PI / 90           // 2 ° clockwise
const SHADOW_CLR  = 'rgba(0,0,0,0.50)'
const SHADOW_BLR  = 12                     // canvas shadowBlur (≈ 6 px radius)
const SHADOW_OX   = 2
const SHADOW_OY   = 3
const CARD_ALPHA  = 0.90                   // non-selected opacity
const SEL_R = 168; const SEL_G = 240; const SEL_B = 240
const SEL_BG      = `rgb(${SEL_R},${SEL_G},${SEL_B})`
const SEL_TINT    = `rgba(${SEL_R},${SEL_G},${SEL_B},0.32)`
const SEL_BORDER  = `rgba(60,160,160,0.85)`
const TOP_MARGIN  = 28   // room for the current-layer label strip above the first card
const MIN_SPACING = 22      // minimum gap between successive card tops
const GAP_CURRENT = 40      // gap above the current card (must exceed shadow bleed ~15px)

// ─────────────────────────────────────────────────────────────

export class LayerStackWidget {
  private readonly _canvas: HTMLCanvasElement

  // layers[0] = root (bottom), layers[N-1] = topmost visible layer
  private _layers:   Layer[] = []
  private _selected: Layer | null = null

  // ── Drag state ───────────────────────────────────────────────
  private _visible     = true
  private _dragging    = false
  private _dragLayer:    Layer | null = null
  private _dragOffsetY = 0      // pointer y relative to card top when drag started
  private _dragY       = 0      // current absolute pointer y
  private _dropIndex   = -1     // insertion index in _layers when dropped

  constructor(canvas: HTMLCanvasElement) {
    this._canvas = canvas
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  setStack(top: Layer): void {
    this._layers = []
    let l: Layer | null = top
    while (l !== null) {
      if (!l.isInfrastructure && !l.isHiddenHelper) this._layers.unshift(l)   // root at [0]
      l = l.layerBelow
    }
    // Default selection: second-from-top, so the gap is visible immediately.
    if (this._selected === null || !this._layers.includes(this._selected)) {
      const n = this._layers.length
      this._selected = this._layers[Math.max(0, n - 2)] ?? null
    }
  }

  get selected(): Layer | null { return this._selected }
  set selected(l: Layer | null) { this._selected = l }

  get widgetWidth(): number { return this._widgetW() }

  // Handle a key press. Returns true if the key was consumed.
  handleKey(key: string): boolean {
    if (key === 'Shift+ArrowUp')   { this.moveUp();      return true }
    if (key === 'Shift+ArrowDown') { this.moveDown();    return true }
    if (key === 'ArrowUp')         { this.navigateUp();  return true }
    if (key === 'ArrowDown')       { this.navigateDown(); return true }
    if (key === 'h' || key === 'H') { this.toggleVisible(); return true }
    return false
  }

  toggleVisible(): void { this.setVisible(!this._visible) }

  setVisible(v: boolean): void {
    this._visible = v
    Node.scheduleFrame?.()
  }

  get isVisible(): boolean { return this._visible }

  // Move current layer one step up in the stack (towards topmost).
  navigateUp(): void {
    const ci = this._currentIndex()
    if (ci < this._layers.length - 1) {
      this._selected = this._layers[ci + 1] ?? this._selected
      Node.scheduleFrame?.()
    }
  }

  // Move current layer one step down in the stack (towards root).
  navigateDown(): void {
    const ci = this._currentIndex()
    if (ci > 0) {
      this._selected = this._layers[ci - 1] ?? this._selected
      Node.scheduleFrame?.()
    }
  }

  // Reorder: move selected layer one position higher (Shift+ArrowUp).
  // ci === 0 is Root, which never moves.
  moveUp(): void {
    const ci = this._currentIndex()
    if (ci <= 0 || ci >= this._layers.length - 1) return
    const layer = this._layers[ci]!
    const to    = ci + 1
    this._layers.splice(ci, 1)
    this._layers.splice(to, 0, layer)
    this._reorderLiveStack(layer, to)
    Node.scheduleFrame?.()
  }

  // Reorder: move selected layer one position lower (Shift+ArrowDown).
  // ci <= 1 is Root itself, or the layer directly above it — neither may
  // move into Root's slot at index 0.
  moveDown(): void {
    const ci = this._currentIndex()
    if (ci <= 1) return
    const layer = this._layers[ci]!
    const to    = ci - 1
    this._layers.splice(ci, 1)
    this._layers.splice(to, 0, layer)
    this._reorderLiveStack(layer, to)
    Node.scheduleFrame?.()
  }

  // ------------------------------------------------------------------
  // Geometry
  // ------------------------------------------------------------------

  // Total strip width — 20% of canvas width, clamped to a usable range.
  private _widgetW(): number {
    return stackWidgetWidth(this._canvas.width)
  }

  // Untilted card width — fills the strip, minus the left margin and right gap.
  private _cardW(): number {
    return this._widgetW() - CARD_X - CARD_MARGIN
  }

  private _cardH(): number {
    return Math.round(this._cardW() * this._canvas.height / this._canvas.width)
  }

  private _spacing(): number {
    const n  = this._layers.length
    if (n <= 1) return 0
    const ch = this._cardH()
    // The gap at the current card costs an extra ch + GAP_CURRENT beyond normal spacing,
    // so subtract that from the available height before calculating per-card spacing.
    const available = this._canvas.height - TOP_MARGIN - ch - ch - GAP_CURRENT
    return Math.max(MIN_SPACING, Math.floor(available / (n - 1)))
  }

  private _currentIndex(): number {
    return this._selected !== null ? this._layers.indexOf(this._selected) : -1
  }

  // y-coordinate of the top-left of the card for layer at index i.
  //
  // The stack is rendered in two sections separated by a gap at the current
  // card, so the current card is always fully visible:
  //
  //   ┌──────────────────────┐  ← TOP_MARGIN
  //   │  card N-1 (topmost)  │
  //      ...overlapping...
  //   │  card ci+1           │
  //   └──────────────────────┘
  //          GAP_CURRENT px
  //   ┌──────────────────────┐  ← fully visible current card
  //   │  card ci  (current)  │
  //   └──────────────────────┘
  //   │  card ci-1           │
  //      ...overlapping...
  //   │  card 0  (root)      │
  //
  // i = 0 (root) → near bottom;  i = N-1 (topmost) → near TOP_MARGIN.
  private _cardY(i: number, sp: number): number {
    const ci = this._currentIndex()
    const n  = this._layers.length
    const ch = this._cardH()

    if (ci < 0) {
      // No current layer — normal uniform layout.
      return TOP_MARGIN + (n - 1 - i) * sp
    }

    // Y of the current card's top edge.
    // If current is the topmost card, it sits at TOP_MARGIN.
    // Otherwise it sits one full card-height + GAP_CURRENT below the bottom
    // edge of the card above it.
    const currentY = ci === n - 1
      ? TOP_MARGIN
      : TOP_MARGIN + (n - 2 - ci) * sp + ch + GAP_CURRENT

    if (i > ci)  return TOP_MARGIN + (n - 1 - i) * sp   // above section
    if (i === ci) return currentY                          // current card
    return currentY + (ci - i) * sp                       // below section
  }

  // During a drag, shift cards above / below the gap to open space.
  private _cardYDrag(i: number, sp: number): number {
    if (!this._dragging || this._dragLayer === null) return this._cardY(i, sp)
    const di = this._layers.indexOf(this._dragLayer)
    if (i === di) return this._cardY(i, sp)  // will be skipped

    // Open a gap at _dropIndex: cards above gap shift up, below shift down.
    const above = i > di ? i - 1 : i          // logical position after removing dragged card
    const gap   = this._dropIndex
    const shift = sp * 0.55                    // half-card-spacing gap

    let y = this._cardY(i, sp)
    if (above >= gap) y -= shift              // cards above gap move up
    else              y += shift              // cards below gap move down
    return y
  }

  private _hitTest(pt: Point): Layer | null {
    const sp = this._spacing()
    const ch = this._cardH()
    const ci = this._currentIndex()
    const n  = this._layers.length
    // Test from topmost (drawn last, highest z) downward.
    // Hit area matches the *visible* portion of each card:
    //   • current card and topmost card (fully visible) → full card height
    //   • all others → only the bottom sp pixels (the label strip), since
    //     each card's upper portion is covered by the card above it in z-order
    for (let i = n - 1; i >= 0; i--) {
      const y    = this._cardY(i, sp)
      const full = (i === ci || i === n - 1)
      const hitY = full ? y : y + ch - sp
      const hitH = full ? ch : sp
      if (pt.y >= hitY && pt.y < hitY + hitH) return this._layers[i] ?? null
    }
    return null
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  render(ctx: Ctx2D): void {
    if (!this._visible) return
    const n  = this._layers.length
    if (n === 0) return
    const sp = this._spacing()
    const ch = this._cardH()

    // Draw root-to-top so each later card occludes the earlier ones.
    for (let i = 0; i < n; i++) {
      const layer = this._layers[i]!
      if (layer === this._dragLayer) continue
      const y = this._dragging
        ? this._cardYDrag(i, sp)
        : this._cardY(i, sp)
      this._drawCard(ctx, layer, y, this._cardW(), ch)
    }

    // Drop-target indicator line.
    if (this._dragging && this._dragLayer !== null) {
      this._drawDropIndicator(ctx, sp, ch)
    }

    // Dragged card floats above everything.
    if (this._dragLayer !== null) {
      this._drawCard(ctx, this._dragLayer, this._dragY, this._cardW(), ch, true)
    }

    // Current-layer name strip at the very bottom of the widget area.
    this._drawCurrentLabel(ctx)
  }

  private _drawCurrentLabel(ctx: Ctx2D): void {
    const lh = TOP_MARGIN - 2   // fits exactly in the top margin above the first card
    if (lh < 8) return
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.72)'
    ctx.fillRect(0, 0, this._widgetW(), lh)
    if (this._selected !== null) {
      const tc = typeColor(this._selected)
      ctx.fillStyle = tc
      ctx.fillRect(0, 0, 3, lh)
      ctx.fillStyle    = 'rgba(255,255,255,0.90)'
      ctx.font         = '11px monospace'
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(`▸ ${this._selected.debugName}`, 8, lh / 2)
    }
    ctx.restore()
  }

  // ── Card ──────────────────────────────────────────────────────────

  private _drawCard(
    ctx: Ctx2D, layer: Layer,
    y: number, w: number, h: number,
    floating = false,
  ): void {
    const isSel = layer === this._selected

    ctx.save()
    ctx.translate(CARD_X, y)
    ctx.rotate(TILT)
    ctx.globalAlpha = floating ? 0.78 : isSel ? 1.0 : CARD_ALPHA

    const blank = layer.thumbnailOnlyWhenSelected && !isSel

    if (!blank) {
      // Drop shadow — drawn as a filled rect with canvas shadow, then
      // the card body is drawn over it without shadow.
      ctx.save()
      ctx.shadowColor   = SHADOW_CLR
      ctx.shadowBlur    = SHADOW_BLR
      ctx.shadowOffsetX = SHADOW_OX
      ctx.shadowOffsetY = SHADOW_OY
      ctx.fillStyle     = isSel ? SEL_BG : '#ffffff'
      ctx.fillRect(0, 0, w, h)
      ctx.restore()   // ← clears shadow before drawing thumbnail

      // Thumbnail, clipped to card bounds.
      ctx.save()
      ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip()
      this._drawThumbnail(ctx, layer, w, h)
      ctx.restore()

      // Selection tint (cyan wash over thumbnail).
      if (isSel) {
        ctx.fillStyle = SEL_TINT
        ctx.fillRect(0, 0, w, h)
      }

      // Card border.
      ctx.strokeStyle = isSel ? SEL_BORDER : 'rgba(0,0,0,0.18)'
      ctx.lineWidth   = isSel ? 1.5 : 0.75
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1)
    }

    ctx.restore()
  }

  // ── Thumbnail content ─────────────────────────────────────────────

  private _drawThumbnail(ctx: Ctx2D, layer: Layer, w: number, h: number): void {
    if (layer.thumbnailOnlyWhenSelected && layer !== this._selected) return
    drawLayerThumbnail(ctx, layer, w, h, this._canvas.width, this._canvas.height)
  }


  // ------------------------------------------------------------------
  // Interaction
  // ------------------------------------------------------------------

  inBounds(pt: Point): boolean {
    return this._visible && pt.x >= 0 && pt.x < this._widgetW()
  }

  handlePointerDown(pt: Point): boolean {
    if (!this.inBounds(pt)) return false
    this._canvas.focus()   // ensure canvas receives subsequent key events
    const hit = this._hitTest(pt)
    if (hit !== null) {
      this._dragLayer   = hit
      const i           = this._layers.indexOf(hit)
      this._dragOffsetY = pt.y - this._cardY(i, this._spacing())
      this._dragY       = this._cardY(i, this._spacing())
      this._dropIndex   = i
    }
    return true   // always consume events within the widget strip
  }

  handlePointerMove(pt: Point): void {
    if (this._dragLayer === null) return
    const i  = this._layers.indexOf(this._dragLayer)
    const sp = this._spacing()

    if (pt.x > this._widgetW()) {
      // Pointer left the strip — bind-drag mode
      Node.bindDrag.active = true
      Node.bindDrag.source = this._dragLayer
      Node.bindDrag.x      = pt.x
      Node.bindDrag.y      = pt.y
      this._dragging = false   // suppress reorder ghost
      Node.scheduleFrame?.()
      return
    }

    // Back inside strip — cancel any bind-drag
    if (Node.bindDrag.active) {
      Node.bindDrag.active = false
      Node.bindDrag.source = null
    }

    if (!this._dragging && Math.abs(pt.y - (this._cardY(i, sp) + this._dragOffsetY)) > 6) {
      this._dragging = true
    }
    if (this._dragging) {
      this._dragY = pt.y - this._dragOffsetY
      this._updateDropIndex(pt.y)
      Node.scheduleFrame?.()
    }
  }

  handlePointerUp(_pt: Point): void {
    // Always clear bind-drag state — the actual binding is handled by InteractionSystem.
    Node.bindDrag.active = false
    Node.bindDrag.source = null

    if (this._dragging && this._dragLayer !== null && this._dropIndex >= 0) {
      this._commitDrop()
      Node.scheduleFrame?.()
    } else if (!this._dragging && this._dragLayer !== null) {
      // Click (no drag) — select the layer now.
      this._selected = this._dragLayer
      Node.scheduleFrame?.()
    }
    this._dragging  = false
    this._dragLayer = null
  }

  // Draw a thin cyan line at the current drop target position.
  private _drawDropIndicator(ctx: Ctx2D, sp: number, ch: number): void {
    const di   = this._layers.indexOf(this._dragLayer!)
    const drop = this._dropIndex

    // Find the card that will end up just above the gap (lower y on screen).
    // After the drag card is logically removed, slot `drop` in the remaining
    // list maps to actual index `drop + (drop >= di ? 1 : 0)`.
    const aboveActual = drop + (drop >= di ? 1 : 0)
    const belowActual = (drop - 1) + (drop - 1 >= di ? 1 : 0)

    let lineY: number
    const aboveOk = aboveActual < this._layers.length
    const belowOk = belowActual >= 0

    if (aboveOk && belowOk) {
      // Centre between bottom-of-below and top-of-above (screen coords).
      lineY = (this._cardY(belowActual, sp) + ch + this._cardY(aboveActual, sp)) / 2
    } else if (aboveOk) {
      lineY = this._cardY(aboveActual, sp) - sp * 0.55
    } else if (belowOk) {
      lineY = this._cardY(belowActual, sp) + ch + sp * 0.55
    } else {
      return
    }

    ctx.save()
    ctx.shadowColor = 'rgba(100,220,220,0.70)'
    ctx.shadowBlur  = 6
    ctx.strokeStyle = 'rgba(80,200,200,0.92)'
    ctx.lineWidth   = 2
    ctx.beginPath()
    ctx.moveTo(CARD_X + 6, lineY)
    ctx.lineTo(CARD_X + this._cardW() - 6, lineY)
    ctx.stroke()
    // Small chevron ▶ at left edge to indicate insertion point.
    const aw = 6
    ctx.fillStyle = 'rgba(80,200,200,0.92)'
    ctx.beginPath()
    ctx.moveTo(CARD_X,      lineY - aw / 2)
    ctx.lineTo(CARD_X + aw, lineY)
    ctx.lineTo(CARD_X,      lineY + aw / 2)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  // ------------------------------------------------------------------
  // Drag helpers
  // ------------------------------------------------------------------

  private _updateDropIndex(mouseY: number): void {
    const sp = this._spacing()
    const ch = this._cardH()
    // Find the index where inserting would be closest to the mouse.
    // Index 0 is Root's slot and is never a valid drop target.
    let best = 1, bestDist = Infinity
    for (let i = 1; i < this._layers.length; i++) {
      if (this._layers[i] === this._dragLayer) continue
      const y    = this._cardY(i, sp)
      const mid  = y + ch / 2
      const dist = Math.abs(mouseY - mid)
      if (dist < bestDist) { bestDist = dist; best = i }
    }
    this._dropIndex = best
  }

  private _commitDrop(): void {
    const layer = this._dragLayer!
    const from  = this._layers.indexOf(layer)
    if (from <= 0) return   // Root never moves
    const to = Math.max(1, Math.min(this._layers.length - 1, this._dropIndex))
    if (from === to) return

    this._layers.splice(from, 1)
    this._layers.splice(to,   0, layer)
    this._reorderLiveStack(layer, to)
  }

  // ------------------------------------------------------------------
  // External (OS file) drag — driven by main.ts's dragover/drop handlers.
  // `layer` is a freshly-created, not-yet-placed Layer (outsideStack).
  // ------------------------------------------------------------------

  // Open a gap and start floating `layer` at `pt`, as if its thumbnail card
  // had been picked up and was already being dragged within the widget.
  beginExternalDrag(layer: Layer, pt: Point): void {
    this._layers.push(layer)
    this._dragLayer = layer
    this._dragging  = true
    this._dragY     = pt.y - this._cardH() / 2
    this._updateDropIndex(pt.y)
    Node.scheduleFrame?.()
  }

  // Track the pointer during an external drag.
  updateExternalDrag(pt: Point): void {
    if (this._dragLayer === null) return
    this._dragY = pt.y - this._cardH() / 2
    this._updateDropIndex(pt.y)
    Node.scheduleFrame?.()
  }

  // Insert `layer` into the live stack at its current drop position.
  commitExternalDrag(): void {
    const layer = this._dragLayer
    if (layer === null) return
    const from = this._layers.indexOf(layer)
    const to   = Math.max(1, Math.min(this._layers.length - 1, this._dropIndex))
    this._layers.splice(from, 1)
    this._layers.splice(to,   0, layer)
    this._reorderLiveStack(layer, to)
    this._dragLayer = null
    this._dragging  = false
  }

  // Abandon an external drag — remove the placeholder card without touching
  // the live stack (the caller is responsible for discarding `layer`).
  cancelExternalDrag(): void {
    if (this._dragLayer === null) return
    const i = this._layers.indexOf(this._dragLayer)
    if (i >= 0) this._layers.splice(i, 1)
    this._dragLayer = null
    this._dragging  = false
    Node.scheduleFrame?.()
  }

  // Update the live linked-list layer stack to match the display-list position `to`.
  // Index 0 = root (bottommost), index N-1 = topmost.
  private _reorderLiveStack(layer: Layer, to: number): void {
    const below = this._layers[to - 1] ?? null
    const above = this._layers[to + 1] ?? null

    layer.removeFromStack()

    if (below !== null) {
      layer.insertAbove(below)
    } else if (above !== null) {
      // Insert at the very bottom — below above's chain.
      let cursor = above
      while (cursor.layerBelow !== null) cursor = cursor.layerBelow
      layer.insertAbove(cursor.layerBelow ?? cursor)
    }

    // A hidden helper stays directly above (or, if helperBelow, directly
    // below) its host wherever it moves.
    if (layer.hiddenHelper !== null) {
      const helper = layer.hiddenHelper
      helper.removeFromStack()
      if (layer.helperBelow) helper.insertBelow(layer)
      else helper.insertAbove(layer)
    }
  }
}
