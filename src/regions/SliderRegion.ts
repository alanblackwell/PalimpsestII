import { Region } from '../core/Region.js'
import { ValueType, type Amount, type Ctx2D, type Point } from '../core/types.js'
import type { Layer } from '../core/Layer.js'

// ------------------------------------------------------------
// SliderRegion — a horizontal slider for an Amount value
// ------------------------------------------------------------
// Lives inside an AmountLayer (or any other parameterised layer
// that needs a proportion control).
//
// Interactive states:
//   isInteractive = true  → thumb is draggable; value is user-set
//   isInteractive = false → thumb is locked; value is driven by
//                           the parent layer's bound source
//
// The parent layer calls setInteractive() and displayValue after
// each recompute() to keep the visual in sync.

// Promotion factory — set by AmountLayer at import time to avoid
// a circular dependency (SliderRegion → AmountLayer → SliderRegion).
type LayerFactory = (initial: Amount) => Layer
export let promotionFactory: LayerFactory | null = null
export function registerPromotionFactory(f: LayerFactory): void {
  promotionFactory = f
}

export class SliderRegion extends Region {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Amount])

  // Current value driven by user interaction.
  private _value: Amount

  // Visual display value (may differ from _value when driven by a source).
  displayValue: Amount

  // Whether the slider is in interactive (draggable) mode.
  private _interactive = true

  // Drag state.
  private _dragging = false

  constructor(parent: Layer, initial: Amount = 0.5) {
    super(parent)
    this._value    = initial
    this.displayValue = initial
    this.debugName = 'SliderRegion'
  }

  // ----------------------------------------------------------
  // Value
  // ----------------------------------------------------------

  get value(): Amount { return this._value }

  // Called by the parent layer to sync interactive state with its slot.
  set interactive(v: boolean) { this._interactive = v }

  override get isInteractive(): boolean { return this._interactive }

  // ----------------------------------------------------------
  // Pointer interaction (called by the interaction system)
  // ----------------------------------------------------------

  // Returns true if the pointer hit this slider and interaction began.
  handlePointerDown(point: Point): boolean {
    if (!this._interactive) return false
    this._dragging = true
    this._applyPointer(point.x)
    this.markDirty()
    return true
  }

  handlePointerMove(point: Point): void {
    if (!this._dragging) return
    this._applyPointer(point.x)
    this.markDirty()
  }

  handlePointerUp(): void {
    this._dragging = false
    this.markDirty()
  }

  private _applyPointer(px: number): void {
    const { x, width } = this.bounds
    if (width <= 0) return
    const t = Math.max(0, Math.min(1, (px - x) / width))
    this._value = t
    this.displayValue = t
    // Notify the parent layer so it propagates the change to its dependents.
    const p = this.parentLayer as Record<string, unknown>
    if (typeof p['setValue'] === 'function') {
      (p['setValue'] as (v: Amount) => void)(t)
    }
  }

  // ----------------------------------------------------------
  // Promotion
  // ----------------------------------------------------------

  override promoteToLayer(): Layer {
    if (promotionFactory === null) {
      throw new Error(
        'SliderRegion: promotionFactory not registered. ' +
        'Import AmountLayer before calling promoteToLayer().'
      )
    }
    return promotionFactory(this._value)
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    // Value is set externally (by parent layer or user interaction).
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    const { x, y, width, height } = this.bounds
    if (width <= 0 || height <= 0) return

    const v       = this.displayValue
    const thumbR  = Math.min(height / 2 - 1, 7)
    const midY    = y + height / 2
    const x1      = x + thumbR
    const x2      = x + width - thumbR
    const range   = Math.max(0, x2 - x1)
    const thumbX  = x1 + v * range

    // Track — background
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.lineWidth   = 4
    ctx.lineCap     = 'round'
    ctx.beginPath()
    ctx.moveTo(x1, midY)
    ctx.lineTo(x2, midY)
    ctx.stroke()

    // Track — filled portion (value indicator)
    ctx.strokeStyle = this._interactive ? '#4a8fe8' : '#5fa0a8'
    ctx.lineWidth   = 4
    ctx.beginPath()
    ctx.moveTo(x1, midY)
    ctx.lineTo(thumbX, midY)
    ctx.stroke()

    // Thumb
    ctx.fillStyle = this._interactive ? '#e8e8e8' : '#848484'
    ctx.beginPath()
    ctx.arc(thumbX, midY, thumbR, 0, Math.PI * 2)
    ctx.fill()

    // Drag highlight ring
    if (this._dragging) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.arc(thumbX, midY, thumbR + 2.5, 0, Math.PI * 2)
      ctx.stroke()
    }

    ctx.restore()
  }
}
