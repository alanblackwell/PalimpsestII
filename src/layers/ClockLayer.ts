import { Clock } from '../dataflow/Clock.js'
import { boundingBoxContains, type AmountSource, type Amount, type Ctx2D, type Point } from '../core/types.js'
import { drawIcon, type IconName } from '../ui/icons.js'

// ------------------------------------------------------------
// ClockLayer — visible, controllable time source in the stack
// ------------------------------------------------------------
//
// Extends the infrastructure Clock (so Evaluator.setClock() accepts
// it directly), adds:
//
//   • AmountSource interface — getAmount() returns elapsed seconds,
//     which downstream RateLayers wrap into a cycling [0,1] phase
//   • Play / pause toggle — freezes elapsed without losing position
//   • Reset button — resets elapsed to zero
//   • renderSelf — dark pill showing elapsed time and the two buttons
//
// Pause/resume implementation:
//   On pause  — capture elapsed at pause time (_holdElapsed).
//   On resume — rebase _startTs so the first post-resume tick yields
//               the same elapsed value, then advances normally.
//   While paused, tick() is skipped so nothing downstream is dirtied.
//
// Visual:
//
//   ┌─────────────────────────────────────────────┐
//   │ ⏱  12.45 s                      [▶/⏸]  [↺] │
//   └─────────────────────────────────────────────┘

const ACCENT = '#e8c44a'   // warm gold — distinguishes time from value types

export class ClockLayer extends Clock implements AmountSource {

  private _paused         = false
  private _holdElapsed    = 0       // elapsed captured at the moment of pause
  private _resumePending  = false   // true between resume() and the next tick()
  private _cpBounds: { x: number; y: number; width: number; height: number } | null = null

  // Button layout constants.
  private static readonly BTN   = 24
  private static readonly BTN_M = 6
  private static readonly BTN_G = 4

  constructor() {
    super()
    this.debugName = 'Clock'
  }

  // ----------------------------------------------------------
  // AmountSource
  // ----------------------------------------------------------

  // Returns elapsed seconds (grows without bound; RateLayer wraps it).
  getAmount(): Amount { return this.elapsed }

  // ----------------------------------------------------------
  // Controls
  // ----------------------------------------------------------

  get paused(): boolean { return this._paused }

  togglePause(): void {
    if (this._paused) {
      // Resume: rebase _startTs on the next tick.
      this._paused        = false
      this._resumePending = true
    } else {
      // Pause: capture current elapsed.
      this._holdElapsed = this.elapsed
      this._paused      = true
    }
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Tick (called by Evaluator each frame)
  // ----------------------------------------------------------

  override tick(timestamp: number): void {
    if (this._paused) return   // no advancement while paused

    if (this._resumePending) {
      // Rebase: make (timestamp - _startTs) / 1000 === _holdElapsed,
      // so elapsed continues seamlessly from the pause point.
      this._startTs      = timestamp - this._holdElapsed * 1000
      this._resumePending = false
    }

    super.tick(timestamp)
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  override reset(): void {
    super.reset()
    this._holdElapsed   = 0
    this._paused        = false
    this._resumePending = false
  }

  // Restore elapsed time + paused state from a save file. If resuming
  // (not paused), _resumePending rebases _startTs on the next tick so
  // playback continues seamlessly from `elapsed`.
  restoreState(elapsed: number, paused: boolean): void {
    this.setElapsed(elapsed)
    this._holdElapsed   = elapsed
    this._paused        = paused
    this._resumePending = !paused
  }

  protected override recompute(): void {
    // Value is updated by tick(); nothing to pull from slots.
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    const b = this._cpBounds ?? this.bounds
    if (boundingBoxContains(this._pauseBtnBounds(b), point)) {
      this.togglePause()
      return true
    }
    if (boundingBoxContains(this._resetBtnBounds(b), point)) {
      this.reset()
      return true
    }
    return false
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    return (this._cpBounds && boundingBoxContains(this._cpBounds, point))
      ? this : null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width <= 0 || this.bounds.height <= 0) return
    this._drawPill(ctx, this.bounds)
    const cp = this.canvasBounds
    this._cpBounds = cp
    this._drawPill(ctx, cp)
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    const midY = y + height / 2

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // Elapsed time label
    const sec = this.elapsed.toFixed(2)
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(`⏱  ${sec} s`, x + 12, midY)

    // Paused indicator (dim overlay when paused)
    if (this._paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)'
      ctx.beginPath()
      ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
      ctx.fill()
    }

    // Play/pause button
    this._drawBtn(ctx, this._pauseBtnBounds(b), this._paused ? 'play' : 'pause', ACCENT)

    // Reset button
    this._drawBtn(ctx, this._resetBtnBounds(b), 'arrow-counter-clockwise', 'rgba(255,255,255,0.55)')

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _drawBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    icon: IconName,
    colour: string,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    ctx.fillStyle = colour
    drawIcon(ctx, icon, b.x + b.width / 2, b.y + b.height / 2, Math.min(b.width, b.height) - 8)
  }

  private _resetBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const { x, y, width, height } = b ?? this.bounds
    const m = ClockLayer.BTN_M
    const s = ClockLayer.BTN
    return { x: x + width - m - s, y: y + (height - s) / 2, width: s, height: s }
  }

  private _pauseBtnBounds(b?: { x: number; y: number; width: number; height: number }) {
    const rb = this._resetBtnBounds(b)
    const s  = ClockLayer.BTN
    const g  = ClockLayer.BTN_G
    return { x: rb.x - s - g, y: rb.y, width: s, height: s }
  }
}
