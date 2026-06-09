import { ShapeLayer } from './ShapeLayer.js'
import type { Colour, Ctx2D, Point } from '../core/types.js'

export class RectLayer extends ShapeLayer {
  protected drawShape(
    ctx: Ctx2D,
    cx: number, cy: number,
    w: number, h: number,
    angle: number,
    colour: Colour,
    opacity: number,
  ): void {
    ctx.save()
    ctx.globalAlpha = opacity
    ctx.fillStyle = `rgba(${Math.round(colour.r*255)},${Math.round(colour.g*255)},${Math.round(colour.b*255)},${colour.a})`
    ctx.translate(cx, cy)
    ctx.rotate(angle)
    ctx.fillRect(-w / 2, -h / 2, w, h)
    ctx.restore()
  }

  samplePerimeter(t: number): Point {
    const t0    = ((t % 1) + 1) % 1
    const cx    = this._cx
    const cy    = this._cy
    const w     = this._width
    const h     = this._height
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
