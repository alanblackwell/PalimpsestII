import { ShapeLayer } from './ShapeLayer.js'
import { Node } from '../core/Node.js'
import type { Colour, Ctx2D, Point } from '../core/types.js'
import {
  hashString,
  fillTornPaper,
  drawPencilLine, drawNibPen,       NIB_PEN_DEFAULTS,
  drawCalligraphyBrush,             BRUSH_DEFAULTS,
  drawNibBrushBlend,
  drawLichtensteinStroke,
} from './artisticBrush.js'

const BRUSH_TRANSITIONS = [5, 13, 25] as const
const BRUSH_BLEND_HW    = 2
const BRUSH_OFFSETS     = [0, 0, 3, 5, 11]
const BRUSH_SAMPLES     = 200

export class RectLayer extends ShapeLayer {
  constructor(cx: number, cy: number, width: number, height: number, colour?: import('../core/types.js').Colour) {
    super(cx, cy, width, height, colour)
    this.displayBaseName = 'Rectangle'
  }

  private _brushCanvas: OffscreenCanvas = new OffscreenCanvas(1, 1)

  protected override recompute(): void {
    super.recompute()
    this._rebuildBrushCanvas()
  }

  private _rebuildBrushCanvas(): void {
    const w = Node.canvasWidth, h = Node.canvasHeight
    if (this._brushCanvas.width !== w || this._brushCanvas.height !== h)
      this._brushCanvas = new OffscreenCanvas(w, h)
    const bctx = this._brushCanvas.getContext('2d')!
    bctx.clearRect(0, 0, w, h)
    const pts: Point[] = []
    for (let i = 0; i <= BRUSH_SAMPLES; i++)
      pts.push(this.samplePerimeter(i / BRUSH_SAMPLES))
    const sz   = this._strokeWidth
    const col0 = this._colour
    const col  = `#${Math.round(col0.r*255).toString(16).padStart(2,'0')}${Math.round(col0.g*255).toString(16).padStart(2,'0')}${Math.round(col0.b*255).toString(16).padStart(2,'0')}`
    const seed = hashString(this.debugName)
    if (this._filled) {
      if (Node.artisticMode) fillTornPaper(bctx, pts, col, sz, seed)
      return
    }
    if (!Node.artisticMode) return
    const [pt0, pt1, pt2] = BRUSH_TRANSITIONS
    const hw = BRUSH_BLEND_HW
    if (sz > pt1 - hw && sz < pt1 + hw) {
      const t   = (sz - (pt1 - hw)) / (2 * hw)
      const eff = Math.max(1, sz - ((1 - t) * (BRUSH_OFFSETS[2] ?? 0) + t * (BRUSH_OFFSETS[3] ?? 0)))
      drawNibBrushBlend(bctx, pts, col, eff, seed, NIB_PEN_DEFAULTS, BRUSH_DEFAULTS, t)
    } else {
      const caseIdx = sz < pt0 ? 1 : sz < pt1 ? 2 : sz < pt2 ? 3 : 4
      const eff = Math.max(1, sz - (BRUSH_OFFSETS[caseIdx] ?? 0))
      switch (caseIdx) {
        case 1: drawPencilLine(bctx,         pts, col, eff, seed); break
        case 2: drawNibPen(bctx,             pts, col, eff, seed); break
        case 3: drawCalligraphyBrush(bctx,   pts, col, eff, seed); break
        case 4: drawLichtensteinStroke(bctx, pts, col, eff, seed); break
      }
    }
  }

  override renderSelf(ctx: Ctx2D): void {
    if (!Node.artisticMode) {
      super.renderSelf(ctx)
    } else {
      ctx.save()
      ctx.globalAlpha = Math.max(0, Math.min(1, this._opacity * this._colour.a))
      ctx.drawImage(this._brushCanvas, 0, 0)
      ctx.restore()
    }
  }

  protected drawShape(
    ctx: Ctx2D,
    cx: number, cy: number,
    w: number, h: number,
    angle: number,
    colour: Colour,
    opacity: number,
    filled: boolean,
    strokeWidth: number,
  ): void {
    const css = `rgba(${Math.round(colour.r*255)},${Math.round(colour.g*255)},${Math.round(colour.b*255)},${colour.a})`
    ctx.save()
    ctx.globalAlpha = opacity
    ctx.translate(cx, cy)
    ctx.rotate(angle)
    if (filled) {
      ctx.fillStyle = css
      ctx.fillRect(-w / 2, -h / 2, w, h)
    } else {
      ctx.strokeStyle = css
      ctx.lineWidth   = strokeWidth
      ctx.strokeRect(-w / 2, -h / 2, w, h)
    }
    ctx.restore()
  }

  samplePerimeter(t: number): Point {
    const t0    = ((t % 1) + 1) % 1
    const cx    = this._cx
    const cy    = this._cy
    const w     = this._width  * this._scale
    const h     = this._height * this._scale
    const a     = this._angle
    const hw    = w / 2
    const hh    = h / 2
    const perim = 2 * (w + h)
    const d     = t0 * perim

    let lx: number, ly: number
    if (d < w) {
      lx = -hw + d; ly = -hh
    } else if (d < w + h) {
      lx = hw; ly = -hh + (d - w)
    } else if (d < 2 * w + h) {
      lx = hw - (d - w - h); ly = hh
    } else {
      lx = -hw; ly = hh - (d - 2 * w - h)
    }

    const cos = Math.cos(a), sin = Math.sin(a)
    return {
      x: cx + lx * cos - ly * sin,
      y: cy + lx * sin + ly * cos,
    }
  }
}
