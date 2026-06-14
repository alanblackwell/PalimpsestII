import { ShapeLayer } from './ShapeLayer.js'
import type { Colour, Ctx2D, Point } from '../core/types.js'

export class EllipseLayer extends ShapeLayer {
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
    ctx.beginPath()
    ctx.ellipse(cx, cy, w / 2, h / 2, angle, 0, Math.PI * 2)
    if (filled) {
      ctx.fillStyle = css
      ctx.fill()
    } else {
      ctx.strokeStyle = css
      ctx.lineWidth   = strokeWidth
      ctx.stroke()
    }
    ctx.restore()
  }

  samplePerimeter(t: number): Point {
    const t0    = ((t % 1) + 1) % 1
    const angle = t0 * Math.PI * 2
    const cx    = this._cx
    const cy    = this._cy
    const w     = this._width
    const h     = this._height
    const a     = this._angle
    const lx    = (w / 2) * Math.cos(angle)
    const ly    = (h / 2) * Math.sin(angle)
    const cos   = Math.cos(a), sin = Math.sin(a)
    return {
      x: cx + lx * cos - ly * sin,
      y: cy + lx * sin + ly * cos,
    }
  }
}
