type AnyCtx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const MINOR    = 25
const MAJOR_NTH = 4
const MINOR_COL = 'rgba(100, 160, 220, 0.18)'
const MAJOR_COL = 'rgba(80,  140, 210, 0.38)'

export function drawOutlineGrid(ctx: AnyCtx2D, width: number, height: number): void {
  ctx.save()
  ctx.fillStyle = 'rgba(235, 243, 255, 0.30)'
  ctx.fillRect(0, 0, width, height)

  ctx.lineWidth = 1
  const cols = Math.ceil(width  / MINOR)
  const rows = Math.ceil(height / MINOR)
  for (let c = 0; c <= cols; c++) {
    const x = c * MINOR + 0.5
    ctx.strokeStyle = c % MAJOR_NTH === 0 ? MAJOR_COL : MINOR_COL
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke()
  }
  for (let r = 0; r <= rows; r++) {
    const y = r * MINOR + 0.5
    ctx.strokeStyle = r % MAJOR_NTH === 0 ? MAJOR_COL : MINOR_COL
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke()
  }
  ctx.restore()
}
