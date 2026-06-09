import { ShapeLayer } from './ShapeLayer.js'
import type { Colour, Ctx2D } from '../core/types.js'

export class EllipseLayer extends ShapeLayer {
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
    ctx.beginPath()
    ctx.ellipse(cx, cy, w / 2, h / 2, angle, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}
