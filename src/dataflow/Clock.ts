import { Layer } from '../core/Layer.js'
import { ValueType } from '../core/types.js'
import type { Ctx2D } from '../core/types.js'
import { graph } from './Graph.js'

// ------------------------------------------------------------
// Clock — a continuously advancing time source
// ------------------------------------------------------------
// Clock is a source-only Layer (no parameter slots) that produces
// an elapsed-time value in seconds. It is driven externally by
// the Evaluator on each animation frame.
//
// Value type: Amount  (conventionally [0, 1], but Clock's value
// grows without bound — Rate layers wrap it into a cycling phase).
//
// Clock does not render any visible content.

export class Clock extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Amount])

  private _elapsed  = 0    // total seconds since start
  protected _startTs: number | null = null  // protected: ClockLayer adjusts for pause/resume

  constructor() {
    super()
    this.debugName = 'Clock'
    graph.register(this)
    // Clock starts dirty so its first read triggers recompute.
    // (Node starts dirty by default, so nothing extra needed.)
  }

  // ----------------------------------------------------------
  // Driven by the Evaluator
  // ----------------------------------------------------------

  // Called once per animation frame with the rAF timestamp (ms).
  tick(timestamp: number): void {
    if (this._startTs === null) this._startTs = timestamp
    const newElapsed = (timestamp - this._startTs) / 1000
    if (newElapsed !== this._elapsed) {
      this._elapsed = newElapsed
      this.forceDirty()  // propagates to all dependent nodes
    }
  }

  // Reset the clock to zero.
  reset(): void {
    this._startTs = null
    this._elapsed = 0
    this.forceDirty()
  }

  // ----------------------------------------------------------
  // Value access
  // ----------------------------------------------------------

  // Elapsed time in seconds since the clock was started (or last reset).
  get elapsed(): number {
    return this._elapsed
  }

  // ----------------------------------------------------------
  // Node implementation
  // ----------------------------------------------------------

  protected recompute(): void {
    // Clock has no inputs to pull; its value is updated by tick().
  }

  // Clock produces no visible render.
  renderSelf(_ctx: Ctx2D): void {}

  protected hitTestSelf(_point: { x: number; y: number }): null {
    return null
  }
}
