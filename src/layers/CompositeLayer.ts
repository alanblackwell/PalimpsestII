import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type MaskValue,  type MaskSource,
  type Amount,     type AmountSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// CompositeLayer — blends two images with an optional mask
// ------------------------------------------------------------
//
// Reads baseSlot and blendSlot (both Image), composites them using
// the selected blend mode at the given opacity, and optionally
// constrains the blend to where maskSlot is white.
//
// The result is written to an internal OffscreenCanvas and returned
// from getImage() so downstream layers can consume it.  It is also
// drawn onto the main canvas (full-canvas blit) as the layer's
// visual output.
//
// Compositing pipeline:
//   1. Clear result canvas.
//   2. Draw base (if bound).
//   3. If mask is bound:
//        a. Draw blend onto a temp canvas.
//        b. Apply mask to temp via `destination-in`.
//        c. Draw temp onto result with blend mode + opacity.
//      Else:
//        c. Draw blend directly onto result with blend mode + opacity.
//
// Blend modes (13):
//   normal  multiply  screen  overlay
//   darken  lighten   add     difference
//   exclusion  hard-light  soft-light  color-burn  color-dodge
//
// Input slots:
//   baseSlot    (Image)  — background image
//   blendSlot   (Image)  — foreground image being composited
//   maskSlot    (Mask)   — white=blend, black=base (optional)
//   opacitySlot (Amount) — blend layer opacity [0, 1]; default 1
//
// Visual layout of the stack panel (height ≈ 36 px):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌  [◀] multiply [▶]    base ●  blend ●  mask ○  α ○    │
//   └──────────────────────────────────────────────────────────┘
//
// Call resize(w, h) when the canvas dimensions change.

// ------------------------------------------------------------------
// Blend mode table
// ------------------------------------------------------------------

interface BlendMode {
  readonly label: string
  readonly op:    GlobalCompositeOperation
}

const MODES: readonly BlendMode[] = [
  { label: 'normal',     op: 'source-over'  },
  { label: 'multiply',   op: 'multiply'     },
  { label: 'screen',     op: 'screen'       },
  { label: 'overlay',    op: 'overlay'      },
  { label: 'darken',     op: 'darken'       },
  { label: 'lighten',    op: 'lighten'      },
  { label: 'add',        op: 'lighter'      },
  { label: 'difference', op: 'difference'   },
  { label: 'exclusion',  op: 'exclusion'    },
  { label: 'hard-light', op: 'hard-light'   },
  { label: 'soft-light', op: 'soft-light'   },
  { label: 'burn',       op: 'color-burn'   },
  { label: 'dodge',      op: 'color-dodge'  },
]

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT  = '#7ecf7e'   // Image type colour
const BTN_W   = 18
const BTN_H   = 22
const LABEL_W = 72          // blend mode name zone

export class CompositeLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _baseSlot:    ParameterSlot
  private readonly _blendSlot:   ParameterSlot
  private readonly _maskSlot:    ParameterSlot
  private readonly _opacitySlot: ParameterSlot

  private _modeIndex: number = 0  // default: normal

  // Off-screen surfaces — recreated on resize()
  private _result: OffscreenCanvas
  private _temp:   OffscreenCanvas

  constructor(canvasWidth = 1920, canvasHeight = 1080) {
    super()
    this._result      = new OffscreenCanvas(canvasWidth, canvasHeight)
    this._temp        = new OffscreenCanvas(canvasWidth, canvasHeight)
    this._baseSlot    = new ParameterSlot(ValueType.Image,  this)
    this._blendSlot   = new ParameterSlot(ValueType.Image,  this)
    this._maskSlot    = new ParameterSlot(ValueType.Mask,   this)
    this._opacitySlot = new ParameterSlot(ValueType.Amount, this)
    this.slots.push(this._baseSlot, this._blendSlot, this._maskSlot, this._opacitySlot)
    this.debugName = 'CompositeLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._result }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get baseSlot():    ParameterSlot { return this._baseSlot    }
  get blendSlot():   ParameterSlot { return this._blendSlot   }
  get maskSlot():    ParameterSlot { return this._maskSlot    }
  get opacitySlot(): ParameterSlot { return this._opacitySlot }

  // ----------------------------------------------------------
  // Mode cycling
  // ----------------------------------------------------------

  cycleNext(): void { this._modeIndex = (this._modeIndex + 1) % MODES.length; this.markDirty() }
  cyclePrev(): void { this._modeIndex = (this._modeIndex - 1 + MODES.length) % MODES.length; this.markDirty() }

  // ----------------------------------------------------------
  // Resize
  // ----------------------------------------------------------

  resize(w: number, h: number): void {
    this._result = new OffscreenCanvas(w, h)
    this._temp   = new OffscreenCanvas(w, h)
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    const w = this._result.width
    const h = this._result.height

    const base    = this._baseSlot.isActive
      ? (this._baseSlot.source as ImageSource).getImage()    : null
    const blend   = this._blendSlot.isActive
      ? (this._blendSlot.source as ImageSource).getImage()   : null
    const mask    = this._maskSlot.isActive
      ? (this._maskSlot.source as MaskSource).getMask()      : null
    const opacity = this._opacitySlot.isActive
      ? (this._opacitySlot.source as AmountSource).getAmount() as Amount
      : 1.0

    const rctx = this._result.getContext('2d')!
    rctx.clearRect(0, 0, w, h)

    // Draw base
    if (base !== null) {
      rctx.globalCompositeOperation = 'source-over'
      rctx.globalAlpha = 1
      rctx.drawImage(base as CanvasImageSource, 0, 0, w, h)
    }

    if (blend === null) return

    const mode = MODES[this._modeIndex]

    if (mask !== null) {
      // 1. Draw blend onto temp canvas
      const tctx = this._temp.getContext('2d')!
      tctx.clearRect(0, 0, w, h)
      tctx.globalCompositeOperation = 'source-over'
      tctx.globalAlpha = 1
      tctx.drawImage(blend as CanvasImageSource, 0, 0, w, h)

      // 2. Apply mask — keep only where mask is opaque (white)
      tctx.globalCompositeOperation = 'destination-in'
      tctx.globalAlpha = 1
      tctx.drawImage(mask as CanvasImageSource, 0, 0, w, h)

      // 3. Composite masked blend onto result
      rctx.globalCompositeOperation = mode.op
      rctx.globalAlpha = opacity
      rctx.drawImage(this._temp as CanvasImageSource, 0, 0)
    } else {
      // No mask — composite blend directly
      rctx.globalCompositeOperation = mode.op
      rctx.globalAlpha = opacity
      rctx.drawImage(blend as CanvasImageSource, 0, 0, w, h)
    }

    rctx.globalCompositeOperation = 'source-over'
    rctx.globalAlpha = 1
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._prevBtnBounds(), point)) { this.cyclePrev(); return true }
    if (boundingBoxContains(this._nextBtnBounds(), point)) { this.cycleNext(); return true }
    if (boundingBoxContains(this._modeLabelBounds(), point)) { this.cycleNext(); return true }
    return false
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    return boundingBoxContains(this.canvasBounds, point) ? this : null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    // Blit composited result to the main canvas (full size)
    ctx.save()
    ctx.drawImage(this._result as CanvasImageSource, 0, 0)
    ctx.restore()
  }

  // ── Stack panel ─────────────────────────────────────────────

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds
    if (width <= 0 || height <= 0) return

    const midY = y + height / 2

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // [◀] prev
    this._drawNavBtn(ctx, this._prevBtnBounds(), '◀', midY)

    // Mode label
    const mb = this._modeLabelBounds()
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(mb.x, mb.y, mb.width, mb.height, 3)
    ctx.fill()
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(MODES[this._modeIndex].label, mb.x + mb.width / 2, midY)

    // [▶] next
    this._drawNavBtn(ctx, this._nextBtnBounds(), '▶', midY)

    // Slot indicators — right side
    const slots = [
      { slot: this._baseSlot,    label: 'base'  },
      { slot: this._blendSlot,   label: 'blend' },
      { slot: this._maskSlot,    label: 'mask'  },
      { slot: this._opacitySlot, label: 'α'     },
    ]
    let dx = x + width - 8
    ctx.font = '9px monospace'
    for (let i = slots.length - 1; i >= 0; i--) {
      const { slot, label } = slots[i]
      const active = slot.isActive
      ctx.fillStyle    = active ? ACCENT : 'rgba(255,255,255,0.22)'
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(active ? '●' : '○', dx, midY)
      dx -= 12
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText(label, dx, midY)
      dx -= ctx.measureText(label).width + 6
    }

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _drawNavBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    midY: number,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 3)
    ctx.fill()
    ctx.font         = '9px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.55)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, midY)
  }

  private _prevBtnBounds() {
    const { x, y, height } = this.canvasBounds
    return { x: x + 8, y: y + (height - BTN_H) / 2, width: BTN_W, height: BTN_H }
  }

  private _modeLabelBounds() {
    const pb = this._prevBtnBounds()
    return { x: pb.x + BTN_W + 4, y: pb.y, width: LABEL_W, height: BTN_H }
  }

  private _nextBtnBounds() {
    const lb = this._modeLabelBounds()
    return { x: lb.x + LABEL_W + 4, y: lb.y, width: BTN_W, height: BTN_H }
  }
}
