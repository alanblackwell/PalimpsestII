import { ShapeLayer } from './ShapeLayer.js'
import type { Colour, Ctx2D } from '../core/types.js'

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
}
