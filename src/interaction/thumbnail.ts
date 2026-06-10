import { Layer }    from '../core/Layer.js'
import { ValueType } from '../core/types.js'
import type { Ctx2D, Colour } from '../core/types.js'

// Shared thumbnail rendering used by LayerStackWidget and DeletionLayer.

const LABEL_RATIO = 0.13    // label height as fraction of card height

// ── Accent colour per primary type ────────────────────────────────────────

export function typeColor(layer: Layer): string {
  const t = layer.types
  if (t.has(ValueType.Amount))    return '#4a8fe8'
  if (t.has(ValueType.Colour))    return '#e8944a'
  if (t.has(ValueType.Image))     return '#7ecf7e'
  if (t.has(ValueType.Mask))      return '#cfcf7e'
  if (t.has(ValueType.Point))     return '#cf7ecf'
  if (t.has(ValueType.Direction)) return '#7ecfcf'
  if (t.has(ValueType.Rate))      return '#e87e7e'
  if (t.has(ValueType.Count))     return '#a0a0a0'
  if (t.has(ValueType.Event))     return '#e0e060'
  if (t.has(ValueType.Collection))return '#a0a4b8'
  return '#888888'
}

// ── Label strip at the bottom of each thumbnail ───────────────────────────

function drawLabel(ctx: Ctx2D, layer: Layer, w: number, h: number): void {
  const lh = Math.max(16, Math.round(h * LABEL_RATIO))
  ctx.fillStyle = 'rgba(0,0,0,0.68)'
  ctx.fillRect(0, h - lh, w, lh)
  const tc = typeColor(layer)
  ctx.fillStyle = tc
  ctx.fillRect(0, h - lh, 3, lh)
  ctx.fillStyle    = 'rgba(255,255,255,0.92)'
  ctx.font         = `${Math.max(9, Math.round(lh * 0.62))}px monospace`
  ctx.textAlign    = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(layer.debugName, 7, h - lh / 2)
}

// ── Thumbnail content ─────────────────────────────────────────────────────
//
// canvasW / canvasH are the full canvas dimensions, used to scale spatial
// data (points, masks) into the thumbnail cell.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLayer = any

export function drawLayerThumbnail(
  ctx: Ctx2D, layer: Layer, w: number, h: number,
  canvasW: number, canvasH: number,
): void {
  const cw = canvasW, ch = canvasH
  const t  = layer.types as ReadonlySet<ValueType>
  const l  = layer as AnyLayer

  ctx.fillStyle = '#16161e'
  ctx.fillRect(0, 0, w, h)

  // ── Image ──────────────────────────────────────────────────
  if (t.has(ValueType.Image)) {
    const img = l['getImage']?.()
    if (img != null) {
      try { ctx.drawImage(img as CanvasImageSource, 0, 0, w, h) } catch { /* skip */ }
      drawLabel(ctx, layer, w, h)
      return
    }
  }

  // ── Mask ───────────────────────────────────────────────────
  if (t.has(ValueType.Mask)) {
    const mask = l['getMask']?.()
    if (mask != null) {
      try { ctx.drawImage(mask as CanvasImageSource, 0, 0, w, h) } catch { /* skip */ }
      drawLabel(ctx, layer, w, h)
      return
    }
  }

  // ── Colour ─────────────────────────────────────────────────
  if (t.has(ValueType.Colour)) {
    const col = l['getColour']?.() as Colour | undefined
    if (col) {
      ctx.fillStyle = `rgba(${(col.r*255)|0},${(col.g*255)|0},${(col.b*255)|0},${col.a})`
      ctx.fillRect(0, 0, w, h)
      drawLabel(ctx, layer, w, h)
      return
    }
  }

  // ── Clock (Amount with elapsed time) ───────────────────────
  const elapsed = l['elapsed'] as number | undefined
  if (t.has(ValueType.Amount) && typeof elapsed === 'number') {
    const tc   = typeColor(layer)
    const barH = Math.round(h * 0.25)
    ctx.fillStyle = tc + '1a'
    ctx.fillRect(0, 0, w, h)
    const proportion = Math.min(1, elapsed / 3600)
    ctx.save()
    ctx.globalAlpha *= 0.12
    ctx.fillStyle = tc
    ctx.fillRect(0, h - barH, Math.round(proportion * w), barH)
    ctx.restore()
    const totalCs = Math.floor(elapsed * 100)
    const cs  = totalCs % 100
    const ss  = Math.floor(totalCs / 100) % 60
    const mm  = Math.floor(totalCs / 6000) % 60
    const hh  = Math.floor(totalCs / 360000)
    const pad = (n: number) => String(n).padStart(2, '0')
    const timeStr = hh > 0
      ? `${hh}:${pad(mm)}:${pad(ss)}.${pad(cs)}`
      : `${mm}:${pad(ss)}.${pad(cs)}`
    ctx.fillStyle    = 'rgba(255,255,255,0.70)'
    ctx.font         = `bold ${Math.round(h * 0.16)}px monospace`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(timeStr, w / 2, (h - barH) / 2)
    drawLabel(ctx, layer, w, h)
    return
  }

  // ── Amount ─────────────────────────────────────────────────
  if (t.has(ValueType.Amount)) {
    const amt  = (l['getAmount']?.() as number) ?? 0
    const tc   = typeColor(layer)
    const barH = Math.round(h * 0.25)
    ctx.fillStyle = tc + '1a'
    ctx.fillRect(0, 0, w, h)
    ctx.save()
    if (t.has(ValueType.Rate)) ctx.globalAlpha *= 0.12
    ctx.fillStyle = tc
    ctx.fillRect(0, h - barH, Math.round(amt * w), barH)
    ctx.fillStyle    = 'rgba(255,255,255,0.70)'
    ctx.font         = `bold ${Math.round(h * 0.22)}px monospace`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(amt.toFixed(2), w / 2, (h - barH) / 2)
    ctx.restore()
    drawLabel(ctx, layer, w, h)
    return
  }

  // ── Direction ──────────────────────────────────────────────
  if (t.has(ValueType.Direction)) {
    const dir = l['getDirection']?.() as { angle: number; magnitude: number } | undefined
    if (dir) {
      const tc  = typeColor(layer)
      const cx  = w / 2, cy = h / 2
      const len = Math.min(w, h) * 0.38 * dir.magnitude
      ctx.fillStyle = tc + '1a'; ctx.fillRect(0, 0, w, h)
      ctx.strokeStyle = tc; ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(cx, cy)
      const ex = cx + Math.cos(dir.angle) * len
      const ey = cy + Math.sin(dir.angle) * len
      ctx.lineTo(ex, ey); ctx.stroke()
      ctx.fillStyle = tc
      ctx.beginPath(); ctx.arc(ex, ey, 3, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = tc + '66'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.arc(cx, cy, len, 0, Math.PI * 2); ctx.stroke()
    }
    drawLabel(ctx, layer, w, h)
    return
  }

  // ── Point ──────────────────────────────────────────────────
  if (t.has(ValueType.Point)) {
    const pt = l['getPoint']?.() as { x: number; y: number } | undefined
    if (pt) {
      const tc = typeColor(layer)
      const nx = Math.max(2, Math.min(w - 2, (pt.x / cw) * w))
      const ny = Math.max(2, Math.min(h - 2, (pt.y / ch) * h))
      ctx.strokeStyle = tc + '44'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(0, ny); ctx.lineTo(w, ny); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(nx, 0); ctx.lineTo(nx, h); ctx.stroke()
      ctx.fillStyle = tc
      ctx.beginPath(); ctx.arc(nx, ny, 4, 0, Math.PI * 2); ctx.fill()
    }
    drawLabel(ctx, layer, w, h)
    return
  }

  // ── Event ──────────────────────────────────────────────────
  if (t.has(ValueType.Event)) {
    const et      = l['getEventTime']?.() as number | null
    const age     = et !== null && et !== undefined ? performance.now() - et : 9999
    const pulse   = Math.max(0, 1 - age / 900)
    const tc      = typeColor(layer)
    ctx.fillStyle = tc + Math.round(pulse * 200).toString(16).padStart(2, '0')
    ctx.fillRect(0, 0, w, h)
    if (pulse > 0.05) {
      ctx.fillStyle = `rgba(255,255,200,${pulse * 0.8})`
      ctx.beginPath()
      ctx.arc(w / 2, h / 2, Math.round(h * 0.25 * pulse), 0, Math.PI * 2)
      ctx.fill()
    }
    drawLabel(ctx, layer, w, h)
    return
  }

  // ── Count ──────────────────────────────────────────────────
  if (t.has(ValueType.Count)) {
    const count = (l['getCount']?.() as number) ?? 0
    ctx.fillStyle = '#a0a0a01a'; ctx.fillRect(0, 0, w, h)
    ctx.fillStyle    = 'rgba(210,210,210,0.90)'
    ctx.font         = `bold ${Math.round(h * 0.42)}px monospace`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(count), w / 2, h / 2 - Math.round(h * 0.05))
    drawLabel(ctx, layer, w, h)
    return
  }

  // ── Fallback: scaled renderSelf ────────────────────────────
  ctx.save()
  ctx.scale(w / cw, h / ch)
  try { layer.renderSelf(ctx) } catch { /* ignore */ }
  ctx.restore()
  drawLabel(ctx, layer, w, h)
}
