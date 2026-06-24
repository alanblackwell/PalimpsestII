import { Layer } from '../core/Layer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type EventValue, type EventSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { drawLayerThumbnail } from '../interaction/thumbnail.js'

// ------------------------------------------------------------
// SelectLayer — A/B image switch
// ------------------------------------------------------------
//
// Two Image inputs (leftSlot, rightSlot). The currently-selected one is
// passed through unchanged as this layer's own ImageSource output.
//
// Controls are drawn centred on the canvas (renderPanel, selected-only,
// edit-mode-only — same precedent as RootLayer's clock-dial readout):
// small live thumbnails of the two source images, left and right of centre,
// with a block-arrow toggle in between pointing at whichever side is
// currently active.
//
// toggleSlot (Event) flips the selection on each rising edge. Operating the
// arrow manually always flips the selection too, and — if toggleSlot is
// currently Bound — suspends it, handing control to the user (same
// permanent-suspend-on-touch convention as MaskLayer's invert toggle).

const ACCENT = '#7ecf7e'   // Image type colour
const STRIPE = 4

const THUMB_W   = 120
const THUMB_H   = 90
const THUMB_GAP = 70   // gap between the two thumbnails, occupied by the arrow

type BBox = { x: number; y: number; width: number; height: number }

export class SelectLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  readonly leftSlot:   ParameterSlot
  readonly rightSlot:  ParameterSlot
  readonly toggleSlot: ParameterSlot

  // 0 = left source selected, 1 = right source selected
  private _selected: 0 | 1 = 0
  private _lastEventTime: EventValue = null
  private _result: ImageValue = null

  private _arrowBounds: BBox | null = null
  private _leftThumbBounds:  BBox | null = null
  private _rightThumbBounds: BBox | null = null

  constructor() {
    super()
    this.leftSlot   = new ParameterSlot(ValueType.Image, this, 'left')
    this.rightSlot  = new ParameterSlot(ValueType.Image, this, 'right')
    this.toggleSlot = new ParameterSlot(ValueType.Event, this, 'toggle')
    this.slots.push(this.leftSlot, this.rightSlot, this.toggleSlot)
    this.displayBaseName = 'Choose'
    this.debugName = 'Choose'
    graph.register(this)
  }

  // ── ImageSource ───────────────────────────────────────────────

  getImage(): ImageValue { return this._result }

  // ── Persistence ───────────────────────────────────────────────

  override serializeState(): Record<string, unknown> {
    return { selected: this._selected, lastEventTime: this._lastEventTime }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (state.selected === 0 || state.selected === 1) this._selected = state.selected
    if (typeof state.lastEventTime === 'number' || state.lastEventTime === null) {
      this._lastEventTime = state.lastEventTime as EventValue
    }
  }

  // ── Node ──────────────────────────────────────────────────────

  protected recompute(): void {
    if (this.toggleSlot.isActive) {
      const t = (this.toggleSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastEventTime) {
        this._lastEventTime = t
        this._selected = this._selected === 0 ? 1 : 0
      }
    }

    const slot = this._selected === 0 ? this.leftSlot : this.rightSlot
    this._result = slot.isActive ? (slot.source as ImageSource).getImage() : null
  }

  // ── Rendering ─────────────────────────────────────────────────

  renderSelf(ctx: Ctx2D): void {
    if (this._result === null) return
    ctx.drawImage(
      this._result as CanvasImageSource, 0, 0,
      Node.canvasWidth, Node.canvasHeight,
    )
  }

  renderPanel(ctx: Ctx2D): void {
    this._drawStripPill(ctx, this.bounds)
  }

  override renderOverlay(ctx: Ctx2D): void {
    this._renderOverlay(ctx)
  }

  // Strip pill in the left widget area.
  private _drawStripPill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, STRIPE, height, [4, 0, 0, 4])
    ctx.fill()

    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Select', x + 12, y + height / 2)
    ctx.restore()
  }

  // Two source thumbnails either side of canvas centre, with a block-arrow
  // toggle in the gap between them pointing at the active side.
  private _renderOverlay(ctx: Ctx2D): void {
    const cw = Node.canvasWidth
    const ch = Node.canvasHeight
    if (cw <= 0 || ch <= 0) return

    const cx = cw / 2
    const cy = ch / 2

    const leftB:  BBox = { x: cx - THUMB_GAP / 2 - THUMB_W, y: cy - THUMB_H / 2, width: THUMB_W, height: THUMB_H }
    const rightB: BBox = { x: cx + THUMB_GAP / 2,           y: cy - THUMB_H / 2, width: THUMB_W, height: THUMB_H }
    this._leftThumbBounds  = leftB
    this._rightThumbBounds = rightB

    this._drawThumb(ctx, leftB,  this.leftSlot,  this._selected === 0)
    this._drawThumb(ctx, rightB, this.rightSlot, this._selected === 1)

    const arrowB: BBox = { x: cx - THUMB_GAP / 2, y: cy - THUMB_H / 2, width: THUMB_GAP, height: THUMB_H }
    this._arrowBounds = arrowB
    this._drawArrow(ctx, arrowB)
  }

  private _drawThumb(ctx: Ctx2D, b: BBox, slot: ParameterSlot, active: boolean): void {
    const { x, y, width, height } = b

    ctx.save()
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, 6)
    ctx.clip()
    ctx.translate(x, y)

    if (slot.isActive) {
      drawLayerThumbnail(ctx, slot.source as Layer, width, height, Node.canvasWidth, Node.canvasHeight)
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(0, 0, width, height)
      ctx.fillStyle    = 'rgba(255,255,255,0.28)'
      ctx.font         = '11px monospace'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('unbound', width / 2, height / 2)
    }

    ctx.restore()

    // Drop-target highlight while a compatible card is being dragged —
    // these thumbnails accept the same drop as the left/right slot rows.
    const drag = Node.bindDrag
    const isCompat = drag.active && drag.source !== null && drag.source.types.has(ValueType.Image)
    if (isCompat) {
      ctx.save()
      ctx.fillStyle = 'rgba(50,200,70,0.18)'
      ctx.beginPath()
      ctx.roundRect(x, y, width, height, 6)
      ctx.fill()
      ctx.strokeStyle = 'rgba(50,200,70,0.85)'
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.roundRect(x + 0.5, y + 0.5, width - 1, height - 1, 6)
      ctx.stroke()
      ctx.restore()
      return
    }

    // Border — bright accent on the active side, dim otherwise.
    ctx.save()
    ctx.strokeStyle = active ? ACCENT : 'rgba(255,255,255,0.25)'
    ctx.lineWidth   = active ? 3 : 1
    ctx.beginPath()
    ctx.roundRect(x + 0.5, y + 0.5, width - 1, height - 1, 6)
    ctx.stroke()
    ctx.restore()
  }

  // An arrow with its base at the centre of `b` (the midpoint between the
  // two thumbnails) and its point touching whichever thumbnail is selected —
  // never spanning the full gap, so it doesn't read as a connection between
  // the two. The manual toggle control; hit-testing uses the whole of `b`.
  private _drawArrow(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    const cx = x + width / 2
    const cy = y + height / 2
    const halfGap = width / 2

    const pointRight = this._selected === 1
    const shaftW = halfGap * 0.45
    const headW  = halfGap * 0.55
    const shaftH = height  * 0.22
    const headH  = height  * 0.5

    ctx.save()
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    if (pointRight) {
      ctx.moveTo(cx,             cy - shaftH / 2)
      ctx.lineTo(cx + shaftW,    cy - shaftH / 2)
      ctx.lineTo(cx + shaftW,    cy - headH / 2)
      ctx.lineTo(cx + shaftW + headW, cy)
      ctx.lineTo(cx + shaftW,    cy + headH / 2)
      ctx.lineTo(cx + shaftW,    cy + shaftH / 2)
      ctx.lineTo(cx,             cy + shaftH / 2)
    } else {
      ctx.moveTo(cx,             cy - shaftH / 2)
      ctx.lineTo(cx - shaftW,    cy - shaftH / 2)
      ctx.lineTo(cx - shaftW,    cy - headH / 2)
      ctx.lineTo(cx - shaftW - headW, cy)
      ctx.lineTo(cx - shaftW,    cy + headH / 2)
      ctx.lineTo(cx - shaftW,    cy + shaftH / 2)
      ctx.lineTo(cx,             cy + shaftH / 2)
    }
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  // ── Interaction ───────────────────────────────────────────────

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    if (this._arrowBounds !== null && boundingBoxContains(this._arrowBounds, point)) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    if (this._arrowBounds !== null && boundingBoxContains(this._arrowBounds, point)) {
      this._handleToggle()
      return true
    }
    return false
  }

  handlePointerUp(): void {}

  // Dropping a card onto either thumbnail binds it to the corresponding
  // slot, just as if it had been dropped on that slot's row — the
  // thumbnails are a much larger, more tempting target.
  override hitTestSlot(point: Point): ParameterSlot | null {
    if (this._leftThumbBounds  !== null && boundingBoxContains(this._leftThumbBounds,  point)) return this.leftSlot
    if (this._rightThumbBounds !== null && boundingBoxContains(this._rightThumbBounds, point)) return this.rightSlot
    return super.hitTestSlot(point)
  }

  // On creation, bind the two nearest Image-producing layers below to
  // left/right and send each to the Background collection — "wire up
  // whatever's already there" convenience, same pattern as FillLayer's
  // colour auto-binding.
  override autoBindRules(): ReturnType<Layer['autoBindRules']> {
    const isImage = (l: Layer) => l.types.has(ValueType.Image)
    return [
      { slot: this.leftSlot,  accepts: isImage, sendToBackgroundAfterBind: true },
      { slot: this.rightSlot, accepts: isImage, sendToBackgroundAfterBind: true },
    ]
  }

  // ── Private helpers ───────────────────────────────────────────

  private _handleToggle(): void {
    if (this.toggleSlot.state === SlotState.Bound) {
      this.toggleSlot.suspend()
    }
    this._selected = this._selected === 0 ? 1 : 0
    this.markDirty()
  }
}
