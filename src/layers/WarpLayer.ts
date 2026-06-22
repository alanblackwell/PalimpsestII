import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type PointSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph }        from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'
import { PointLayer }   from './PointLayer.js'
import { contentLeft }  from '../interaction/layout.js'

// ------------------------------------------------------------
// WarpLayer — non-linear image warp driven by control points or shape
// ------------------------------------------------------------
//
// Two modes:
//
//   Shape mode (shapeSlot active + source has samplePerimeter):
//     At bind time, N_SHAPE positions are sampled from the shape perimeter
//     and stored as _initShape. Each frame the shape is re-sampled and the
//     per-sample displacements drive the IDW warp field.
//
//   Point mode:
//     Up to N_HANDLES control points. Each pointSlots[i]:
//       Unbound  — handle displayed but no warp contribution.
//       Bound    — displacement = current – initial (captured at bind time).
//
// Handle first touch (slot is Unbound):
//   A hidden PointLayer is created at the handle's current position, inserted
//   directly below WarpLayer with isHiddenHelper=true, and raw-bound to the
//   slot. Subsequent handle drags call PointLayer.setPoint(). The hidden layer
//   is stored in _hiddenPL[i] (not in this.hiddenHelper, which is singular).
//
// Warp algorithm (IDW):
//   For each output pixel, compute displacement via inverse-distance weighting
//   of all active control pairs, then bilinear-sample the source at the
//   inverse-mapped position. Displacement map is computed at DISP_SCALE
//   (1/4 resolution) and bilinearly interpolated back to full resolution.

// ── Constants ──────────────────────────────────────────────────

const ACCENT      = '#7ecf7e'   // Image type accent
const PT_ACCENT   = '#cf7ecf'   // Point type accent
const MASK_ACCENT = '#cfcf7e'   // Mask type accent

const N_HANDLES   = 5
const HANDLE_R    = 8           // visual radius of unbound/bound handles
const HANDLE_HIT  = 14          // pointer hit radius
const N_SHAPE     = 16          // perimeter sample count
const MIN_DIST_SQ = 10000       // IDW clamped minimum distance² (100 px)
const DISP_SCALE  = 4           // displacement map resolution divisor
const N_EDGE      = 8           // boundary anchor intervals per edge (keeps canvas edges fixed)

// Initial handle positions as fractions of canvas size from centre
const HANDLE_FX = [ 0.00, -0.25,  0.25, -0.25,  0.25 ]
const HANDLE_FY = [ 0.00, -0.25, -0.25,  0.25,  0.25 ]

// ── WarpLayer ─────────────────────────────────────────────────

export class WarpLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  readonly imageSlot:  ParameterSlot
  readonly pointSlots: ParameterSlot[]
  readonly shapeSlot:  ParameterSlot

  private _offscreen: OffscreenCanvas

  // Canvas-space anchor positions for the 5 control handles.
  // For hidden-PointLayer bindings this is also the initial warp anchor.
  private _handlePos: Point[]

  // Per-slot: initial point captured the moment a slot first becomes active.
  private _initPt: (Point | null)[]
  // Per-slot: source reference at last check — detects new bindings.
  private _prevSrc: (unknown | null)[]

  // Shape mode: initial perimeter samples captured when shapeSlot is bound.
  private _initShape: Point[] = []
  private _prevShapeSrc: unknown | null = null

  // Hidden PointLayers auto-created on handle first-touch.
  // NOT stored in this.hiddenHelper (which is singular).
  private _hiddenPL: (PointLayer | null)[]

  // Drag state
  private _dragIdx:  number | null = null

  constructor() {
    super()
    const w = Node.canvasWidth, h = Node.canvasHeight
    this._offscreen  = new OffscreenCanvas(w, h)

    const cx = w / 2, cy = h / 2
    this._handlePos = Array.from({ length: N_HANDLES }, (_, i) => ({
      x: cx + HANDLE_FX[i]! * w,
      y: cy + HANDLE_FY[i]! * h,
    }))

    this._initPt   = Array(N_HANDLES).fill(null)
    this._prevSrc  = Array(N_HANDLES).fill(null)
    this._hiddenPL = Array(N_HANDLES).fill(null)

    this.imageSlot  = new ParameterSlot(ValueType.Image, this, 'image')
    this.pointSlots = Array.from({ length: N_HANDLES }, (_, i) =>
      new ParameterSlot(ValueType.Point, this, `point ${i + 1}`))
    this.shapeSlot  = new ParameterSlot(ValueType.Mask, this, 'shape')

    this.slots.push(this.imageSlot, ...this.pointSlots, this.shapeSlot)
    this.debugName = 'WarpLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._offscreen }

  // ----------------------------------------------------------
  // Auto-bind: image slot → nearest Image below, send to Background
  // ----------------------------------------------------------

  override autoBindRules(): ReturnType<Layer['autoBindRules']> {
    return [
      {
        slot: this.imageSlot,
        accepts: (l: Layer) => l.types.has(ValueType.Image),
        sendToBackgroundAfterBind: true,
      },
    ]
  }

  // ----------------------------------------------------------
  // Resize
  // ----------------------------------------------------------

  resize(w: number, h: number): void {
    const ow = this._offscreen.width, oh = this._offscreen.height
    this._offscreen = new OffscreenCanvas(w, h)
    for (let i = 0; i < N_HANDLES; i++) {
      this._handlePos[i] = {
        x: (this._handlePos[i]!.x / ow) * w,
        y: (this._handlePos[i]!.y / oh) * h,
      }
    }
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Recompute — collect warp pairs then apply IDW warp
  // ----------------------------------------------------------

  protected override recompute(): void {
    const ctx = this._offscreen.getContext('2d')!
    ctx.clearRect(0, 0, this._offscreen.width, this._offscreen.height)

    if (!this.imageSlot.isActive) return
    const src = (this.imageSlot.source as ImageSource).getImage()
    if (!src) return

    const pairs: Array<{ init: Point; curr: Point }> = []

    // Shape mode
    if (this.shapeSlot.isActive) {
      const ss = this.shapeSlot.source as unknown
      if (typeof (ss as any).samplePerimeter === 'function') {
        if (ss !== this._prevShapeSrc || this._initShape.length === 0) {
          this._initShape = Array.from({ length: N_SHAPE }, (_, i) => {
            const p = (ss as any).samplePerimeter(i / N_SHAPE) as Point
            return { ...p }
          })
          this._prevShapeSrc = ss
        }
        for (let i = 0; i < N_SHAPE; i++) {
          const curr = (ss as any).samplePerimeter(i / N_SHAPE) as Point
          pairs.push({ init: this._initShape[i]!, curr })
        }
      }
    }

    // Point mode: collect all active point slots
    for (let i = 0; i < N_HANDLES; i++) {
      const slot = this.pointSlots[i]!
      if (!slot.isActive) continue
      const psrc = slot.source as PointSource
      if (slot.source !== this._prevSrc[i]) {
        this._initPt[i]  = psrc.getPoint()
        this._prevSrc[i] = slot.source
      }
      pairs.push({ init: this._initPt[i]!, curr: psrc.getPoint() })
    }

    if (pairs.length === 0) {
      ctx.drawImage(src, 0, 0)
      return
    }

    const hasDisp = pairs.some(p =>
      Math.abs(p.curr.x - p.init.x) > 0.5 || Math.abs(p.curr.y - p.init.y) > 0.5)
    if (!hasDisp) {
      ctx.drawImage(src, 0, 0)
      return
    }

    // Add zero-displacement boundary anchors so the canvas edges stay fixed
    const W = this._offscreen.width, H = this._offscreen.height
    for (let j = 0; j <= N_EDGE; j++) {
      const tx = j * W / N_EDGE, ty = j * H / N_EDGE
      const top = { x: tx, y: 0 }, bot = { x: tx, y: H }
      pairs.push({ init: top, curr: top }, { init: bot, curr: bot })
      if (j > 0 && j < N_EDGE) {
        const lft = { x: 0, y: ty }, rgt = { x: W, y: ty }
        pairs.push({ init: lft, curr: lft }, { init: rgt, curr: rgt })
      }
    }

    this._applyWarp(ctx as OffscreenCanvasRenderingContext2D, src, pairs)
  }

  private _applyWarp(
    ctx: OffscreenCanvasRenderingContext2D,
    src: ImageBitmap | OffscreenCanvas,
    pairs: Array<{ init: Point; curr: Point }>,
  ): void {
    const W = this._offscreen.width
    const H = this._offscreen.height
    const sw = Math.ceil(W / DISP_SCALE)
    const sh = Math.ceil(H / DISP_SCALE)

    // Build IDW displacement map at reduced resolution
    const dxMap = new Float32Array(sw * sh)
    const dyMap = new Float32Array(sw * sh)
    for (let r = 0; r < sh; r++) {
      for (let c = 0; c < sw; c++) {
        const px = (c + 0.5) * DISP_SCALE
        const py = (r + 0.5) * DISP_SCALE
        let sumW = 0, sumDx = 0, sumDy = 0
        for (const { init, curr } of pairs) {
          const ex = px - init.x, ey = py - init.y
          const w  = 1 / Math.max(MIN_DIST_SQ, ex * ex + ey * ey)
          sumW  += w
          sumDx += w * (curr.x - init.x)
          sumDy += w * (curr.y - init.y)
        }
        const idx = r * sw + c
        dxMap[idx] = sumDx / sumW
        dyMap[idx] = sumDy / sumW
      }
    }

    // Read source pixels
    const tmpCanvas = new OffscreenCanvas(W, H)
    const tmpCtx    = tmpCanvas.getContext('2d')!
    tmpCtx.drawImage(src, 0, 0)
    const sd = tmpCtx.getImageData(0, 0, W, H).data

    const outData = ctx.createImageData(W, H)
    const od = outData.data

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Bilinear sample of displacement map
        const mc = x / DISP_SCALE - 0.5
        const mr = y / DISP_SCALE - 0.5
        const c0 = Math.max(0, Math.min(sw - 1, Math.floor(mc)))
        const r0 = Math.max(0, Math.min(sh - 1, Math.floor(mr)))
        const c1 = Math.min(sw - 1, c0 + 1)
        const r1 = Math.min(sh - 1, r0 + 1)
        const fc = mc - c0, fr = mr - r0

        const dx = lerp(
          lerp(dxMap[r0*sw+c0]!, dxMap[r0*sw+c1]!, fc),
          lerp(dxMap[r1*sw+c0]!, dxMap[r1*sw+c1]!, fc),
          fr)
        const dy = lerp(
          lerp(dyMap[r0*sw+c0]!, dyMap[r0*sw+c1]!, fc),
          lerp(dyMap[r1*sw+c0]!, dyMap[r1*sw+c1]!, fc),
          fr)

        // Inverse map: source pixel at (x-dx, y-dy)
        const sx = x - dx, sy = y - dy
        const sx0 = Math.floor(sx), sy0 = Math.floor(sy)
        const sx1 = sx0 + 1,       sy1 = sy0 + 1
        const fsx = sx - sx0,      fsy = sy - sy0

        const clX = (v: number) => Math.max(0, Math.min(W - 1, v))
        const clY = (v: number) => Math.max(0, Math.min(H - 1, v))

        const i00 = (clY(sy0) * W + clX(sx0)) * 4
        const i10 = (clY(sy0) * W + clX(sx1)) * 4
        const i01 = (clY(sy1) * W + clX(sx0)) * 4
        const i11 = (clY(sy1) * W + clX(sx1)) * 4

        const oi = (y * W + x) * 4
        for (let ch = 0; ch < 4; ch++) {
          od[oi+ch] = Math.round(lerp(
            lerp(sd[i00+ch]!, sd[i10+ch]!, fsx),
            lerp(sd[i01+ch]!, sd[i11+ch]!, fsx),
            fsy))
        }
      }
    }

    ctx.putImageData(outData, 0, 0)
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  override renderSelf(ctx: Ctx2D): void {
    ctx.drawImage(this._offscreen, 0, 0)
  }

  override renderPanel(ctx: Ctx2D): void {
    const b  = this.bounds
    const cb = this.canvasBounds

    ctx.save()
    ctx.font = '11px monospace'
    ctx.textBaseline = 'middle'

    for (const pill of [b, cb]) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.beginPath(); ctx.roundRect(pill.x, pill.y, pill.width, pill.height, 6); ctx.fill()
      ctx.fillStyle = ACCENT
      ctx.beginPath(); ctx.roundRect(pill.x, pill.y, 4, pill.height, [6, 0, 0, 6]); ctx.fill()
    }

    // Label in strip pill
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.textAlign = 'left'
    ctx.fillText('Warp', b.x + 10, b.y + b.height / 2)

    // Slot indicator dots in canvas pill, right-to-left
    const allSlots    = [this.imageSlot, ...this.pointSlots, this.shapeSlot]
    const slotColours = [ACCENT, ...Array(N_HANDLES).fill(PT_ACCENT), MASK_ACCENT]
    let rx = cb.x + cb.width - 6
    for (let i = allSlots.length - 1; i >= 0; i--) {
      const slot = allSlots[i]!
      const col  = slotColours[i]!
      const dot  = slot.isActive ? '●' : slot.state === SlotState.SuspendedBound ? '◐' : '○'
      ctx.fillStyle = slot.isActive ? col : 'rgba(255,255,255,0.4)'
      ctx.textAlign = 'right'
      ctx.fillText(dot, rx, cb.y + cb.height / 2)
      rx -= 14
    }

    ctx.restore()
  }

  // Current draggable position for handle i: follows the hidden PointLayer when bound.
  private _handleCurrentPos(i: number): Point {
    const pl = this._hiddenPL[i]
    const slot = this.pointSlots[i]!
    if (pl !== null && slot.source === pl && slot.isActive) return pl.getPoint()
    return this._handlePos[i]!
  }

  override renderOverlay(ctx: Ctx2D): void {
    ctx.save()
    ctx.font = '9px monospace'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'

    for (let i = 0; i < N_HANDLES; i++) {
      const anchor  = this._handlePos[i]!
      const slot    = this.pointSlots[i]!
      const pl      = this._hiddenPL[i]
      const isHidden = pl !== null && slot.source === pl && slot.isActive
      const active   = slot.isActive
      const curr     = this._handleCurrentPos(i)

      // Draw displacement line for hidden PointLayer handles
      if (isHidden) {
        const dx = curr.x - anchor.x, dy = curr.y - anchor.y
        if (dx * dx + dy * dy > 4) {
          ctx.strokeStyle = 'rgba(207,126,207,0.5)'
          ctx.lineWidth   = 1.5
          ctx.setLineDash([4, 3])
          ctx.beginPath()
          ctx.moveTo(anchor.x, anchor.y)
          ctx.lineTo(curr.x, curr.y)
          ctx.stroke()
          ctx.setLineDash([])
          // Small anchor dot
          ctx.fillStyle = 'rgba(255,255,255,0.35)'
          ctx.beginPath()
          ctx.arc(anchor.x, anchor.y, 3, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // Main handle at current position
      ctx.beginPath()
      ctx.arc(curr.x, curr.y, HANDLE_R, 0, Math.PI * 2)

      if (active && isHidden) {
        ctx.fillStyle = PT_ACCENT + 'cc'
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.lineWidth   = 1.5
        ctx.setLineDash([])
      } else if (active) {
        ctx.fillStyle = 'rgba(180,180,255,0.5)'
        ctx.fill()
        ctx.strokeStyle = PT_ACCENT
        ctx.lineWidth   = 1.5
        ctx.setLineDash([])
      } else {
        // Unbound — faint purple fill + dashed PT_ACCENT outline, visible on white or dark
        ctx.fillStyle = PT_ACCENT + '30'
        ctx.fill()
        ctx.strokeStyle = PT_ACCENT + 'b0'
        ctx.lineWidth   = 1.5
        ctx.setLineDash([4, 3])
      }
      ctx.stroke()
      ctx.setLineDash([])

      ctx.fillStyle = active ? 'rgba(255,255,255,0.9)' : PT_ACCENT
      ctx.fillText(String(i + 1), curr.x, curr.y)
    }

    ctx.restore()
  }

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const PILL_GAP = 8
    const bot0 = this.renderSlotGroup(ctx, [this.imageSlot], this.panelBottom)
    const bot1 = this.renderSlotGroup(ctx, this.pointSlots, bot0 + PILL_GAP)
    this.renderSlotGroup(ctx, [this.shapeSlot], bot1 + PILL_GAP)
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point): Node | null {
    for (let i = 0; i < N_HANDLES; i++) {
      const p  = this._handleCurrentPos(i)
      const dx = point.x - p.x, dy = point.y - p.y
      if (dx * dx + dy * dy <= HANDLE_HIT * HANDLE_HIT) return this
    }
    return null
  }

  // ----------------------------------------------------------
  // Pointer interaction
  // ----------------------------------------------------------

  private _ensureHiddenPL(i: number): void {
    const slot = this.pointSlots[i]!
    if (this._hiddenPL[i] !== null && slot.source === this._hiddenPL[i]) return

    // Clean up any orphaned hidden PL (left behind if its binding was deleted via inspector)
    const stale = this._hiddenPL[i]
    if (stale != null && !stale.outsideStack) stale.removeFromStack()
    this._hiddenPL[i] = null

    // Capture state BEFORE any mutations
    const isFirstTouch = slot.state === SlotState.Unbound
    const startPos = slot.isActive
      ? (slot.source as PointSource).getPoint()
      : { ...this._handlePos[i]! }

    const pl = new PointLayer({ ...startPos })
    Layer.assignDebugName(pl)
    pl.isHiddenHelper = true
    pl.helperHost     = this
    pl.insertAbove(this)
    this._hiddenPL[i] = pl
    // BindingLayer.create removes any prior binding then binds pl, making
    // right-click on this slot show the standard binding inspector.
    BindingLayer.create(pl, slot)

    if (isFirstTouch) {
      // Let recompute capture _initPt = pl.getPoint() = _handlePos[i]
      this._prevSrc[i] = null
    } else {
      // Taking over from external: set initPt to grab position so
      // displacement starts at zero and grows as the user drags
      this._initPt[i]  = { ...startPos }
      this._prevSrc[i] = pl
    }
    Node.scheduleFrame?.()
  }

  handlePointerDown(point: Point): boolean {
    for (let i = 0; i < N_HANDLES; i++) {
      const p  = this._handleCurrentPos(i)
      const dx = point.x - p.x, dy = point.y - p.y
      if (dx * dx + dy * dy > HANDLE_HIT * HANDLE_HIT) continue

      this._ensureHiddenPL(i)
      this._dragIdx = i
      return true
    }
    return false
  }

  handlePointerMove(point: Point): void {
    if (this._dragIdx === null) return
    const i  = this._dragIdx
    const pl = this._hiddenPL[i]!

    // Update both the handle visual position and the hidden PointLayer
    // The handle position is used as the initial anchor in the warp;
    // we keep it fixed and move only the PointLayer's position.
    // (Initial anchor = _handlePos[i] is not changed by dragging.)
    pl.setPoint(point)
    this.markDirty()
  }

  handlePointerUp(): void {
    this._dragIdx = null
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      ...super.serializeState(),
      handlePos:  this._handlePos,
      initPt:     this._initPt,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    super.deserializeState(state)
    if (Array.isArray(state['handlePos'])) {
      this._handlePos = (state['handlePos'] as Point[]).map(p => ({ ...p }))
    }
    if (Array.isArray(state['initPt'])) {
      this._initPt = (state['initPt'] as (Point | null)[]).map(p => p ? { ...p } : null)
    }
  }

  // ----------------------------------------------------------
  // Slot default for slot-click-to-create (Point slots → PointLayer at handle pos)
  // ----------------------------------------------------------

  override getSlotDefault(slot: ParameterSlot): Point | number | null {
    const idx = this.pointSlots.indexOf(slot)
    if (idx >= 0) {
      // Return the hidden PL's current position when it exists so that
      // re-enabling a suspended binding doesn't snap the handle back to its anchor.
      const pl = this._hiddenPL[idx]
      return pl != null ? pl.getPoint() : { ...this._handlePos[idx]! }
    }
    return null
  }
}
