// Shared layout, rendering, and hit-testing for the "Move" convenience
// button shown on Clip<Shape> layers (ClipRect, ClipEllipse, ClipPath,
// ClipDrawing) when they are selected. Drawn via renderOverlay (unclipped).

import { Node }        from '../core/Node.js'
import { contentLeft } from '../interaction/layout.js'
import type { Point, Ctx2D } from '../core/types.js'

const BTN_H      = 30
const BTN_W      = 60
const BTN_GAP    = 14          // gap from bottom edge of viewport
const BTN_COLOUR = '#7ecf7e'   // Image accent

function btnRect(): { x: number; y: number } {
  const left = contentLeft(Node.canvasWidth)
  const x    = left + Math.max(0, (Node.viewportWidth - left - BTN_W) / 2)
  const y    = Node.viewportHeight - BTN_H - BTN_GAP
  return { x, y }
}

export function moveButtonHitTest(point: Point, done: boolean): boolean {
  if (done) return false
  const { x, y } = btnRect()
  return point.x >= x && point.x <= x + BTN_W &&
         point.y >= y && point.y <= y + BTN_H
}

export function renderMoveButton(ctx: Ctx2D, done: boolean): void {
  if (done) return
  const { x, y } = btnRect()
  const midY = y + BTN_H / 2

  ctx.save()

  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.beginPath()
  ctx.roundRect(x, y, BTN_W, BTN_H, 5)
  ctx.fill()

  ctx.fillStyle = BTN_COLOUR + 'cc'
  ctx.beginPath()
  ctx.roundRect(x, y, 3, BTN_H, [5, 0, 0, 5])
  ctx.fill()

  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, BTN_W, BTN_H)
  ctx.clip()
  ctx.fillStyle    = 'rgba(255,255,255,0.85)'
  ctx.font         = '11px monospace'
  ctx.textAlign    = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('Move', x + 10, midY)
  ctx.restore()

  ctx.restore()
}
