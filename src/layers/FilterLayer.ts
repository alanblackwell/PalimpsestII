import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type AmountSource,
  type EventValue, type EventSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { filterGL } from './FilterGL.js'
import { contentLeft } from '../interaction/layout.js'

// ------------------------------------------------------------
// FilterLayer — composable image-filter chain
// ------------------------------------------------------------
//
// All 8 filters are shown as a draggable column of pills.
// Each pill has:
//   ≡  drag handle — drag vertically to reorder
//   ◉  enable toggle — manual on/off; optionally bound to an
//      Event slot (each event toggles enabled state)
//   [name]  filter label
//   [══]    intensity slider — manual; suspends Amount binding
//            when dragged
//   ○ ○    Event slot indicator / Amount slot indicator —
//            drop binding targets
//
// Filters apply top-to-bottom; disabled rows pass the image
// through with no canvas work.

// ── Pixel-level filter implementations ───────────────────────
// Using ImageData pixel manipulation — works in all browsers
// (CanvasRenderingContext2D.filter is not supported in Safari < 18).

type ApplyFn = (d: Uint8ClampedArray, t: number, w: number, h: number) => void

function _grayscale(d: Uint8ClampedArray, t: number): void {
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!, g = d[i+1]!, b = d[i+2]!
    const v = 0.2126*r + 0.7152*g + 0.0722*b
    d[i] = r + (v-r)*t;  d[i+1] = g + (v-g)*t;  d[i+2] = b + (v-b)*t
  }
}

function _brightness(d: Uint8ClampedArray, t: number): void {
  const f = t * 2   // slider 0→1 maps to brightness 0→2× (neutral at 0.5)
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.min(255, d[i]! * f);  d[i+1] = Math.min(255, d[i+1]! * f)
    d[i+2] = Math.min(255, d[i+2]! * f)
  }
}

function _contrast(d: Uint8ClampedArray, t: number): void {
  const f = t * 2   // CSS contrast formula: f*(c-127.5)+127.5
  for (let i = 0; i < d.length; i += 4) {
    d[i]   = Math.max(0, Math.min(255, f*(d[i]!   - 127.5) + 127.5))
    d[i+1] = Math.max(0, Math.min(255, f*(d[i+1]! - 127.5) + 127.5))
    d[i+2] = Math.max(0, Math.min(255, f*(d[i+2]! - 127.5) + 127.5))
  }
}

function _saturate(d: Uint8ClampedArray, t: number): void {
  const s = t * 3   // CSS feColorMatrix saturate matrix
  const a=0.213+0.787*s, b=0.715-0.715*s, c=0.072-0.072*s
  const e=0.213-0.213*s, f=0.715+0.285*s, g=0.072-0.072*s
  const h=0.213-0.213*s, k=0.715-0.715*s, m=0.072+0.928*s
  for (let i = 0; i < d.length; i += 4) {
    const r=d[i]!, gr=d[i+1]!, bl=d[i+2]!
    d[i]   = Math.max(0, Math.min(255, a*r + b*gr + c*bl))
    d[i+1] = Math.max(0, Math.min(255, e*r + f*gr + g*bl))
    d[i+2] = Math.max(0, Math.min(255, h*r + k*gr + m*bl))
  }
}

function _hueRotate(d: Uint8ClampedArray, t: number): void {
  const θ = t * 2 * Math.PI, cos = Math.cos(θ), sin = Math.sin(θ)
  // CSS hue-rotate matrix
  const a=0.213+cos*0.787-sin*0.213, b=0.715-cos*0.715-sin*0.715, c=0.072-cos*0.072+sin*0.928
  const e=0.213-cos*0.213+sin*0.143, f=0.715+cos*0.285+sin*0.140, g=0.072-cos*0.072-sin*0.283
  const h=0.213-cos*0.213-sin*0.787, k=0.715-cos*0.715+sin*0.715, m=0.072+cos*0.928+sin*0.072
  for (let i = 0; i < d.length; i += 4) {
    const r=d[i]!, gr=d[i+1]!, bl=d[i+2]!
    d[i]   = Math.max(0, Math.min(255, a*r + b*gr + c*bl))
    d[i+1] = Math.max(0, Math.min(255, e*r + f*gr + g*bl))
    d[i+2] = Math.max(0, Math.min(255, h*r + k*gr + m*bl))
  }
}

function _invert(d: Uint8ClampedArray, t: number): void {
  for (let i = 0; i < d.length; i += 4) {
    d[i]   = d[i]!   + (255 - 2*d[i]!)   * t
    d[i+1] = d[i+1]! + (255 - 2*d[i+1]!) * t
    d[i+2] = d[i+2]! + (255 - 2*d[i+2]!) * t
  }
}

function _sepia(d: Uint8ClampedArray, t: number): void {
  for (let i = 0; i < d.length; i += 4) {
    const r=d[i]!, g=d[i+1]!, b=d[i+2]!
    d[i]   = r + (Math.min(255, 0.393*r + 0.769*g + 0.189*b) - r) * t
    d[i+1] = g + (Math.min(255, 0.349*r + 0.686*g + 0.168*b) - g) * t
    d[i+2] = b + (Math.min(255, 0.272*r + 0.534*g + 0.131*b) - b) * t
  }
}

// Box blur — 3-pass approximation of Gaussian blur.
// Horizontal and vertical passes use an O(n) sliding window.
function _blur(d: Uint8ClampedArray, t: number, w: number, h: number): void {
  const r = Math.round(t * 20)
  if (r <= 0) return
  for (let p = 0; p < 3; p++) { _boxH(d, w, h, r); _boxV(d, w, h, r) }
}

function _boxH(d: Uint8ClampedArray, w: number, h: number, r: number): void {
  const iar = 1 / (2*r + 1)
  const tmp = new Float32Array(w * 4)
  for (let y = 0; y < h; y++) {
    const base = y * w * 4
    let sr=0, sg=0, sb=0, sa=0
    for (let kx = -r; kx <= r; kx++) {
      const o = base + Math.max(0, Math.min(w-1, kx)) * 4
      sr += d[o]!; sg += d[o+1]!; sb += d[o+2]!; sa += d[o+3]!
    }
    for (let x = 0; x < w; x++) {
      tmp[x*4]=sr*iar; tmp[x*4+1]=sg*iar; tmp[x*4+2]=sb*iar; tmp[x*4+3]=sa*iar
      const lo = base + Math.max(0, x-r)     * 4
      const ro = base + Math.min(w-1, x+r+1) * 4
      sr += d[ro]!-d[lo]!; sg += d[ro+1]!-d[lo+1]!
      sb += d[ro+2]!-d[lo+2]!; sa += d[ro+3]!-d[lo+3]!
    }
    for (let x = 0; x < w; x++) {
      d[base+x*4]=tmp[x*4]!; d[base+x*4+1]=tmp[x*4+1]!
      d[base+x*4+2]=tmp[x*4+2]!; d[base+x*4+3]=tmp[x*4+3]!
    }
  }
}

function _boxV(d: Uint8ClampedArray, w: number, h: number, r: number): void {
  const iar = 1 / (2*r + 1)
  const tmp = new Float32Array(h * 4)
  for (let x = 0; x < w; x++) {
    let sr=0, sg=0, sb=0, sa=0
    for (let ky = -r; ky <= r; ky++) {
      const o = Math.max(0, Math.min(h-1, ky)) * w * 4 + x * 4
      sr += d[o]!; sg += d[o+1]!; sb += d[o+2]!; sa += d[o+3]!
    }
    for (let y = 0; y < h; y++) {
      tmp[y*4]=sr*iar; tmp[y*4+1]=sg*iar; tmp[y*4+2]=sb*iar; tmp[y*4+3]=sa*iar
      const to = Math.max(0, y-r)     * w * 4 + x * 4
      const bo = Math.min(h-1, y+r+1) * w * 4 + x * 4
      sr += d[bo]!-d[to]!; sg += d[bo+1]!-d[to+1]!
      sb += d[bo+2]!-d[to+2]!; sa += d[bo+3]!-d[to+3]!
    }
    for (let y = 0; y < h; y++) {
      const o = y * w * 4 + x * 4
      d[o]=tmp[y*4]!; d[o+1]=tmp[y*4+1]!; d[o+2]=tmp[y*4+2]!; d[o+3]=tmp[y*4+3]!
    }
  }
}

// ── Threshold: centre (t=0.5) = no effect; t→0 cuts dark areas,
//   t→1 cuts light areas.
function _threshold(d: Uint8ClampedArray, t: number): void {
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.2126 * d[i]! + 0.7152 * d[i+1]! + 0.0722 * d[i+2]!
    if (t < 0.5) {
      if (lum < (1 - 2 * t) * 255) d[i+3] = 0
    } else {
      if (lum > (2 - 2 * t) * 255) d[i+3] = 0
    }
  }
}

// ── Edge extraction (Sobel) ───────────────────────────────────────
function _edges(d: Uint8ClampedArray, t: number, w: number, h: number): void {
  const src   = new Uint8ClampedArray(d)
  const scale = t * 2
  const L = (y: number, x: number): number => {
    const o = (y * w + x) * 4
    return 0.2126 * src[o]! + 0.7152 * src[o+1]! + 0.0722 * src[o+2]!
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = -L(y-1,x-1) - 2*L(y,x-1) - L(y+1,x-1)
               +  L(y-1,x+1) + 2*L(y,x+1) + L(y+1,x+1)
      const gy = -L(y-1,x-1) - 2*L(y-1,x) - L(y-1,x+1)
               +  L(y+1,x-1) + 2*L(y+1,x) + L(y+1,x+1)
      const mag = Math.min(255, Math.sqrt(gx*gx + gy*gy) * scale)
      const i = (y * w + x) * 4
      d[i] = mag; d[i+1] = mag; d[i+2] = mag
    }
  }
  // Border pixels: zero RGB (alpha already from source)
  for (let x = 0; x < w; x++) {
    const ta = x * 4;                d[ta] = 0; d[ta+1] = 0; d[ta+2] = 0
    const tb = ((h-1)*w + x) * 4;   d[tb] = 0; d[tb+1] = 0; d[tb+2] = 0
  }
  for (let y = 1; y < h-1; y++) {
    const tl = y*w*4;                d[tl] = 0; d[tl+1] = 0; d[tl+2] = 0
    const tr = (y*w + w-1)*4;       d[tr] = 0; d[tr+1] = 0; d[tr+2] = 0
  }
}

// ── Gradient map ──────────────────────────────────────────────────
// t=0.5 = pass-through (no effect).
// t=0   = chrome: cool gunmetal shadows → cold steel → silver → icy white.
// t=1   = neon:   deep purple → hot pink → neon lime → electric yellow.
function _gradientMap(d: Uint8ClampedArray, t: number): void {
  const useChrome = t < 0.5
  const blend = useChrome ? 1 - t * 2 : (t - 0.5) * 2

  // Chrome palette (luminance stops 0 / 0.33 / 0.66 / 1.0)
  const cr0r=18,  cr0g=18,  cr0b=24    // gunmetal
  const cr1r=58,  cr1g=68,  cr1b=88    // cold steel
  const cr2r=160, cr2g=168, cr2b=180   // silver
  const cr3r=230, cr3g=235, cr3b=242   // icy white

  // Neon palette (luminance stops 0 / 0.33 / 0.66 / 1.0)
  const ne0r=8,   ne0g=4,   ne0b=20    // deep purple
  const ne1r=255, ne1g=10,  ne1b=145   // hot pink
  const ne2r=150, ne2g=255, ne2b=20    // neon lime
  const ne3r=235, ne3g=255, ne3b=20    // electric yellow

  const p0r=useChrome?cr0r:ne0r, p0g=useChrome?cr0g:ne0g, p0b=useChrome?cr0b:ne0b
  const p1r=useChrome?cr1r:ne1r, p1g=useChrome?cr1g:ne1g, p1b=useChrome?cr1b:ne1b
  const p2r=useChrome?cr2r:ne2r, p2g=useChrome?cr2g:ne2g, p2b=useChrome?cr2b:ne2b
  const p3r=useChrome?cr3r:ne3r, p3g=useChrome?cr3g:ne3g, p3b=useChrome?cr3b:ne3b

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!, g = d[i+1]!, b = d[i+2]!
    const lum = (0.2126*r + 0.7152*g + 0.0722*b) / 255
    let mr: number, mg: number, mb: number
    if (lum < 0.33) {
      const f = lum / 0.33
      mr = p0r + (p1r-p0r)*f;  mg = p0g + (p1g-p0g)*f;  mb = p0b + (p1b-p0b)*f
    } else if (lum < 0.66) {
      const f = (lum - 0.33) / 0.33
      mr = p1r + (p2r-p1r)*f;  mg = p1g + (p2g-p1g)*f;  mb = p1b + (p2b-p1b)*f
    } else {
      const f = (lum - 0.66) / 0.34
      mr = p2r + (p3r-p2r)*f;  mg = p2g + (p3g-p2g)*f;  mb = p2b + (p3b-p2b)*f
    }
    d[i]   = Math.round(r + (mr-r)*blend)
    d[i+1] = Math.round(g + (mg-g)*blend)
    d[i+2] = Math.round(b + (mb-b)*blend)
  }
}

// ── False colour (thermal: blue→green→red) ───────────────────────
// Maps luminance 0→1 to hue 240°→0° (S=1, V=1); t blends from original.
function _falseColour(d: Uint8ClampedArray, t: number): void {
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!, g = d[i+1]!, b = d[i+2]!
    const lum = (0.2126*r + 0.7152*g + 0.0722*b) / 255
    const h  = (1 - lum) * 240
    const hi = Math.floor(h / 60) % 6
    const f  = h / 60 - Math.floor(h / 60)
    let fr: number, fg: number, fb: number
    switch (hi) {
      case 0:  fr = 1;   fg = f;   fb = 0; break
      case 1:  fr = 1-f; fg = 1;   fb = 0; break
      case 2:  fr = 0;   fg = 1;   fb = f; break
      case 3:  fr = 0;   fg = 1-f; fb = 1; break
      default: fr = f;   fg = 0;   fb = 1; break  // hi == 4 (h in [240, 300))
    }
    d[i]   = Math.round(r + (fr*255 - r) * t)
    d[i+1] = Math.round(g + (fg*255 - g) * t)
    d[i+2] = Math.round(b + (fb*255 - b) * t)
  }
}

// ── Opacity ───────────────────────────────────────────────────────
function _opacity(d: Uint8ClampedArray, t: number): void {
  for (let i = 0; i < d.length; i += 4) {
    d[i+3] = Math.round(d[i+3]! * t)
  }
}

// ── Solarisation (Sabattier effect) ───────────────────────────────
// Pixels brighter than the fold point are inverted; darker pass through.
// t = 0.5 is the classic darkroom fold at mid-tone.
function _solarise(d: Uint8ClampedArray, t: number): void {
  const fold = Math.round(t * 255)
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = d[i+c]!
      d[i+c] = v < fold ? v : 255 - v
    }
  }
}

// ── Pixelisation ──────────────────────────────────────────────────
function _pixelise(d: Uint8ClampedArray, t: number, w: number, h: number): void {
  const size = Math.max(2, Math.round(t * 64))
  for (let by = 0; by < h; by += size) {
    for (let bx = 0; bx < w; bx += size) {
      const bw = Math.min(size, w - bx), bh = Math.min(size, h - by)
      let sr = 0, sg = 0, sb = 0, sa = 0
      for (let y = by; y < by + bh; y++)
        for (let x = bx; x < bx + bw; x++) {
          const i = (y*w+x)*4
          sr += d[i]!; sg += d[i+1]!; sb += d[i+2]!; sa += d[i+3]!
        }
      const n = bw * bh
      const ar = sr/n, ag = sg/n, ab = sb/n, aa = sa/n
      for (let y = by; y < by + bh; y++)
        for (let x = bx; x < bx + bw; x++) {
          const i = (y*w+x)*4
          d[i] = ar; d[i+1] = ag; d[i+2] = ab; d[i+3] = aa
        }
    }
  }
}

// ── Mosaic / crystallise (Voronoi regions) ────────────────────────
// Deterministic hash via sin — stable per-session pattern.
function _mosaicH(a: number, b: number): number {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return v - Math.floor(v)
}

function _mosaic(d: Uint8ClampedArray, t: number, w: number, h: number): void {
  const cellSize = Math.max(4, Math.round(t * 80 + 4))
  const cols     = Math.ceil(w / cellSize) + 1
  const rows     = Math.ceil(h / cellSize) + 1

  // Jittered seed point for grid cell (c, r)
  const sX = (c: number, r: number) =>
    (c + 0.5 + (_mosaicH(c*2,   r*2  ) - 0.5) * 0.8) * cellSize
  const sY = (c: number, r: number) =>
    (r + 0.5 + (_mosaicH(c*2+1, r*2+1) - 0.5) * 0.8) * cellSize

  // Assign each pixel to its nearest seed (check 9 adjacent cells)
  const assign = new Int32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c0 = Math.floor(x / cellSize), r0 = Math.floor(y / cellSize)
      let bestD = Infinity, bestId = 0
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const c = c0+dc, r = r0+dr
          if (c < 0 || r < 0 || c >= cols || r >= rows) continue
          const dx = x - sX(c, r), dy = y - sY(c, r)
          const dist = dx*dx + dy*dy
          if (dist < bestD) { bestD = dist; bestId = r * cols + c }
        }
      }
      assign[y * w + x] = bestId
    }
  }

  // Accumulate average colour per cell
  const nc = cols * rows
  const sum = new Float32Array(nc * 4)
  const cnt = new Int32Array(nc)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const pi = y*w+x, ci = assign[pi]!, di = pi*4
      sum[ci*4]+=d[di]!; sum[ci*4+1]+=d[di+1]!
      sum[ci*4+2]+=d[di+2]!; sum[ci*4+3]+=d[di+3]!
      cnt[ci]++
    }

  // Fill pixels with cell average
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const pi = y*w+x, ci = assign[pi]!, n = cnt[ci] || 1, di = pi*4
      d[di]=sum[ci*4]/n; d[di+1]=sum[ci*4+1]/n
      d[di+2]=sum[ci*4+2]/n; d[di+3]=sum[ci*4+3]/n
    }
}

// ── Drop shadow ───────────────────────────────────────────────────
// Blurs and offsets the alpha channel, composites it as a black shadow
// behind the original pixels using source-over compositing.

function _saBH(a: Float32Array, w: number, h: number, r: number): void {
  const iar = 1 / (2*r + 1), tmp = new Float32Array(w)
  for (let y = 0; y < h; y++) {
    const base = y * w; let s = 0
    for (let kx = -r; kx <= r; kx++) s += a[base + Math.max(0, Math.min(w-1, kx))]!
    for (let x = 0; x < w; x++) {
      tmp[x] = s * iar
      s += a[base + Math.min(w-1, x+r+1)]! - a[base + Math.max(0, x-r)]!
    }
    for (let x = 0; x < w; x++) a[base + x] = tmp[x]!
  }
}
function _saBV(a: Float32Array, w: number, h: number, r: number): void {
  const iar = 1 / (2*r + 1), tmp = new Float32Array(h)
  for (let x = 0; x < w; x++) {
    let s = 0
    for (let ky = -r; ky <= r; ky++) s += a[Math.max(0, Math.min(h-1, ky)) * w + x]!
    for (let y = 0; y < h; y++) {
      tmp[y] = s * iar
      s += a[Math.min(h-1, y+r+1) * w + x]! - a[Math.max(0, y-r) * w + x]!
    }
    for (let y = 0; y < h; y++) a[y * w + x] = tmp[y]!
  }
}

function _dropShadow(d: Uint8ClampedArray, t: number, w: number, h: number): void {
  const offset  = Math.round(t * 24)
  const blur    = Math.max(1, Math.round(t * 16))
  const opacity = 0.75

  // Shadow alpha: offset copy of the source alpha channel
  const sa = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sy = y - offset, sx = x - offset
      if (sy >= 0 && sy < h && sx >= 0 && sx < w)
        sa[y * w + x] = d[(sy * w + sx) * 4 + 3]! / 255
    }
  for (let p = 0; p < 3; p++) { _saBH(sa, w, h, blur); _saBV(sa, w, h, blur) }

  // Composite shadow (black) behind original via source-over
  const src = new Uint8ClampedArray(d)
  for (let i = 0; i < w * h; i++) {
    const di = i * 4, srcA = src[di+3]! / 255, shdA = sa[i]! * opacity
    const outA = srcA + shdA * (1 - srcA)
    if (outA < 0.001) { d[di] = d[di+1] = d[di+2] = d[di+3] = 0; continue }
    const f = srcA / outA
    d[di]   = Math.round(src[di]!   * f)
    d[di+1] = Math.round(src[di+1]! * f)
    d[di+2] = Math.round(src[di+2]! * f)
    d[di+3] = Math.round(outA * 255)
  }
}

// ── Filter definitions ───────────────────────────────────────

interface FilterDef {
  readonly label:    string
  readonly defaultT: number
  readonly apply:    ApplyFn
}

const FILTER_DEFS: readonly FilterDef[] = [
  { label: 'blur',       defaultT: 0.15, apply: _blur       },
  { label: 'brightness', defaultT: 0.75, apply: _brightness },
  { label: 'contrast',   defaultT: 0.75, apply: _contrast   },
  { label: 'saturate',   defaultT: 0.75, apply: _saturate   },
  { label: 'hue-rotate', defaultT: 0.25, apply: _hueRotate  },
  { label: 'grayscale',  defaultT: 1.00, apply: _grayscale  },
  { label: 'invert',     defaultT: 1.00, apply: _invert     },
  { label: 'sepia',      defaultT: 1.00, apply: _sepia      },
  { label: 'threshold',  defaultT: 0.50, apply: _threshold  },
  { label: 'edges',      defaultT: 0.50, apply: _edges      },
  { label: 'solarise',   defaultT: 0.50, apply: _solarise   },
  { label: 'pixelise',   defaultT: 0.10, apply: _pixelise   },
  { label: 'mosaic',     defaultT: 0.15, apply: _mosaic     },
  { label: 'shadow',        defaultT: 0.40, apply: _dropShadow  },
  { label: 'opacity',       defaultT: 1.00, apply: _opacity     },
  { label: 'gradient-map',  defaultT: 0.50, apply: _gradientMap },
  { label: 'false-colour',  defaultT: 1.00, apply: _falseColour },
]

// ── Per-filter state ─────────────────────────────────────────

interface FilterRow {
  readonly def:        FilterDef
  enabled:             boolean
  intensity:           number
  readonly enableSlot: ParameterSlot
  readonly amountSlot: ParameterSlot
  lastEventTime:       EventValue
  sliderDragging:      boolean
}

// ── Layout (all coordinates are canvas-space) ────────────────

const ACCENT  = '#7ecf7e'    // Image type / enabled colour
const EV_COL  = '#e0e060'    // Event type colour
const AM_COL  = '#4a8fe8'    // Amount type colour

const PY0     = 50            // pill column top (= canvasBounds.y)

// Each pill has 3 equal rows:
//   Row 1: drag handle | filter name | thumbnail
//   Row 2: toggle button | enable slot (no label)
//   Row 3: slider + mini dotted square  OR  collapse-button + amount slot
const ROW_H   = 26            // height of each row
const ROW_PAD = 3             // top/bottom padding inside pill
const ROW_GAP = 3             // vertical gap between rows
const PH = ROW_PAD + ROW_H + ROW_GAP + ROW_H + ROW_GAP + ROW_H + ROW_PAD  // = 90
const PGAP    = 4             // gap between pills

// Column layout — pills are centred in the space to the right of the
// LayerStackWidget, shrinking width (down to PW_MIN) if there isn't room
// for all columns at PW_MAX. Same general approach as MenuLayer._layout().
const PW_MAX       = 260
const PW_MIN       = 190
const COL_GAP      = 16        // horizontal gap between columns
const RIGHT_MARGIN = 12        // minimum gap to the canvas's right edge

// Left side offsets (relative to each pill's left edge):
const STRIPE  = 4             // accent stripe width
const DRAG_OX = STRIPE + 4   // left edge of the button/handle column  (8)
const BTN_W   = 22            // width of toggle button and collapse button
const DRAG_W  = 14            // drag-handle bars width (centred in BTN_W column)

// Content starts after the left-column button in rows 2 and 3, and after
// the drag-handle region in row 1.
const SLT_X   = DRAG_OX + BTN_W + 4   // slot / name content left  (34)

// Right side — relative to each pill's left edge
const RPAD    = 8

// Row 3 mini amount-slot square
const MINI_SQ  = 22           // side length of mini slot square
const MINI_GAP = 4            // gap between slider track end and mini square

// Source slot row height — the image source row above the pills is a plain
// slot row and keeps its own fixed height independent of the pill rows above.
const SLT_H   = 26
// Slot row label column width (matches Layer.renderSlots LABEL_W)
const SLT_LW  = 78

// Intermediate preview thumbnails — overlaid at the top-right of row 1.
const THUMB_W   = 40
const THUMB_H   = 24
const THUMB_GAP = 6     // gap between name/slider and thumbnail

type BBox = { x: number; y: number; width: number; height: number }

// ── FilterLayer ──────────────────────────────────────────────

export class FilterLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  // Image source slot — shown as a standard slot row below the pills.
  private readonly _sourceSlot: ParameterSlot

  // Per-filter rows (mutable order for drag-to-reorder).
  private readonly _rows: FilterRow[]

  // Working canvas for ImageData operations and thumbnail capture.
  private _workCanvas: OffscreenCanvas | null = null
  private _result:     OffscreenCanvas | null = null

  // Opacity applied in renderSelf() via globalAlpha, bypassing the filter
  // pipeline so premultiplied-alpha round-trips in WebGL can't corrupt it.
  private _renderOpacity = 1.0

  // Drag-to-reorder state.
  private _dragRow:     number = -1   // index of row being dragged
  private _dragOffsetX: number = 0    // pointer x − pill left on mousedown
  private _dragOffset:  number = 0    // pointer y − pill top on mousedown
  private _dragX:       number = 0    // current pill left during drag
  private _dragY:       number = 0    // current pill top during drag
  private _dragTarget:  number = -1   // computed drop index

  // Hit-test bounds for per-filter slots (populated in renderPanel).
  private _filterSlotBounds = new Map<ParameterSlot, BBox>()

  // Intermediate preview thumbnails: source image + per-filter outputs.
  // Populated during recompute(); drawn in renderPanel().
  private _srcPreview:  OffscreenCanvas | null = null
  private _rowPreviews: Map<FilterRow, OffscreenCanvas> = new Map()

  constructor() {
    super()

    this._sourceSlot = new ParameterSlot(ValueType.Image, this, 'image')

    this._rows = FILTER_DEFS.map(def => ({
      def,
      enabled:       false,
      intensity:     def.defaultT,
      enableSlot:    new ParameterSlot(ValueType.Event,  this, def.label + ' toggle'),
      amountSlot:    new ParameterSlot(ValueType.Amount, this, def.label + ' amount'),
      lastEventTime: null,
      sliderDragging: false,
    }))

    // Registered on `this.slots` (in fixed FILTER_DEFS order, independent of
    // `_rows`'s mutable drag-to-reorder order) purely so the persistence
    // walker (`slotList`) can save/restore their bindings — FilterLayer
    // draws its own slot rows in renderPanel and overrides renderSlots to a
    // no-op, so this has no rendering/hit-testing effect.
    this.slots.push(this._sourceSlot)
    for (const row of this._rows) this.slots.push(row.enableSlot, row.amountSlot)

    this.debugName = 'Filter'
    graph.register(this)
  }

  // Slot rows are drawn as part of renderPanel's custom pill layout, not via
  // the generic Layer.renderSlots pill (kept as a no-op now that `this.slots`
  // is populated for persistence — see constructor).
  override renderSlots(_ctx: Ctx2D): void {}

  // ----------------------------------------------------------
  // Accessors
  // ----------------------------------------------------------

  get sourceSlot(): ParameterSlot { return this._sourceSlot }

  // Seed a newly-created layer (via slot-click-to-create) with the value
  // currently shown by the corresponding intensity slider, so the binding
  // starts as a no-op.
  override getSlotDefault(slot: ParameterSlot): Point | number | null {
    for (const row of this._rows) {
      if (slot === row.amountSlot) return row.intensity
    }
    return null
  }

  override autoBindRules() {
    return [{
      slot:                  this._sourceSlot,
      accepts:               (l: Layer) => l.types.has(ValueType.Image),
      sendToBackgroundAfterBind: true,
    }]
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._result }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  // `this.slots` (and therefore slot-binding persistence) stays in fixed
  // FILTER_DEFS order regardless of drag-to-reorder — only the *visual*
  // order (_rows) and each row's enabled/intensity are saved here, keyed by
  // filter label so they can be matched back to the right ParameterSlots.
  override serializeState(): Record<string, unknown> {
    return {
      rows: this._rows.map(row => ({
        label:     row.def.label,
        enabled:   row.enabled,
        intensity: row.intensity,
      })),
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (!Array.isArray(state.rows)) return
    const byLabel = new Map(this._rows.map(row => [row.def.label, row]))
    const reordered: FilterRow[] = []
    for (const entry of state.rows as Array<Record<string, unknown>>) {
      const row = typeof entry.label === 'string' ? byLabel.get(entry.label) : undefined
      if (!row) continue
      if (typeof entry.enabled === 'boolean')   row.enabled   = entry.enabled
      if (typeof entry.intensity === 'number')  row.intensity = entry.intensity
      byLabel.delete(row.def.label)
      reordered.push(row)
    }
    // Any rows not mentioned (e.g. a future filter added after this save
    // was made) keep their default state and are appended at the end.
    for (const row of byLabel.values()) reordered.push(row)
    this._rows.length = 0
    this._rows.push(...reordered)
  }

  // ----------------------------------------------------------
  // Node — evaluate & recompute
  // ----------------------------------------------------------

  // Pull per-filter slot sources before the main evaluate loop.
  override evaluate(): void {
    for (const row of this._rows) {
      if (row.enableSlot.isActive) row.enableSlot.source!.evaluate()
      if (row.amountSlot.isActive) row.amountSlot.source!.evaluate()
    }
    super.evaluate()
  }

  protected recompute(): void {
    // ── Read per-filter slot values ──────────────────────────
    for (const row of this._rows) {
      if (row.enableSlot.isActive) {
        const t = (row.enableSlot.source as EventSource).getEventTime()
        if (t !== null && t !== row.lastEventTime) {
          row.lastEventTime = t
          row.enabled = !row.enabled
        }
      }
      if (row.amountSlot.isActive) {
        row.intensity = (row.amountSlot.source as AmountSource).getAmount()
      }
    }

    // ── Acquire source image ─────────────────────────────────
    const w = Node.canvasWidth
    const h = Node.canvasHeight

    const src = this._sourceSlot.isActive
      ? (this._sourceSlot.source as ImageSource).getImage()
      : null

    if (src === null) {
      this._srcPreview  = null
      this._rowPreviews.clear()
      this._result = null
      return
    }

    if (!this._result || this._result.width !== w || this._result.height !== h)
      this._result = new OffscreenCanvas(w, h)

    // ── Capture source thumbnail ─────────────────────────────
    if (!this._srcPreview || this._srcPreview.height !== THUMB_H)
      this._srcPreview = new OffscreenCanvas(THUMB_W, THUMB_H)
    const spctx = this._srcPreview.getContext('2d')!
    spctx.clearRect(0, 0, THUMB_W, THUMB_H)
    spctx.drawImage(src as CanvasImageSource, 0, 0, THUMB_W, THUMB_H)

    // Opacity is applied in renderSelf() via globalAlpha — not in the pipeline.
    const opRow = this._rows.find(r => r.def.label === 'opacity')
    this._renderOpacity = (opRow?.enabled === true) ? Math.max(0, Math.min(1, opRow.intensity)) : 1.0

    // Build the list of enabled steps for the pipeline (opacity excluded).
    const enabledRows: FilterRow[] = this._rows.filter(r => r.enabled && r.def.label !== 'opacity')
    const steps = enabledRows.map(r => ({ label: r.def.label, intensity: r.intensity }))

    // ── WebGL pipeline (preferred) ───────────────────────────
    if (filterGL.supported && steps.length > 0) {
      const thumbMap = filterGL.apply(src as CanvasImageSource, steps, w, h, THUMB_H)

      // Update per-row thumbnail cache from indexed results.
      for (let i = 0; i < enabledRows.length; i++) {
        const thumb = thumbMap.get(i)
        if (thumb) this._rowPreviews.set(enabledRows[i]!, thumb)
      }

      // Copy GL canvas result to this._result.
      const rctx = this._result.getContext('2d')!
      rctx.clearRect(0, 0, w, h)
      rctx.drawImage(filterGL.canvas, 0, 0)
      return
    }

    // ── CPU fallback (no WebGL or no enabled filters) ────────
    if (!this._workCanvas || this._workCanvas.width !== w || this._workCanvas.height !== h)
      this._workCanvas = new OffscreenCanvas(w, h)

    const wctx = this._workCanvas.getContext('2d')!
    wctx.clearRect(0, 0, w, h)
    wctx.drawImage(src as CanvasImageSource, 0, 0, w, h)

    if (steps.length === 0) {
      const rctx = this._result.getContext('2d')!
      rctx.clearRect(0, 0, w, h)
      rctx.drawImage(this._workCanvas, 0, 0)
      return
    }

    const imageData = wctx.getImageData(0, 0, w, h)
    const d = imageData.data

    for (const row of this._rows) {
      if (!row.enabled || row.def.label === 'opacity') continue
      row.def.apply(d, row.intensity, w, h)
      wctx.putImageData(imageData, 0, 0)
      let prev = this._rowPreviews.get(row)
      if (!prev) { prev = new OffscreenCanvas(THUMB_W, THUMB_H); this._rowPreviews.set(row, prev) }
      const pctx = prev.getContext('2d')!
      pctx.clearRect(0, 0, THUMB_W, THUMB_H)
      pctx.drawImage(this._workCanvas, 0, 0, THUMB_W, THUMB_H)
    }

    const rctx = this._result.getContext('2d')!
    rctx.clearRect(0, 0, w, h)
    rctx.putImageData(imageData, 0, 0)
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    if (this._result === null) return
    ctx.save()
    ctx.globalAlpha = this._renderOpacity
    ctx.drawImage(this._result as CanvasImageSource, 0, 0, Node.canvasWidth, Node.canvasHeight)
    ctx.restore()
  }

  private _pillsPerCol(): number {
    return Math.max(1, Math.floor((Node.viewportHeight - PY0) / (PH + PGAP)))
  }

  // Pills are centred in the space right of the LayerStackWidget, shrinking
  // width (down to PW_MIN) if there isn't room for all columns at PW_MAX —
  // same general approach as MenuLayer._layout().
  private _layout(): { panX: number; pillW: number; ppc: number } {
    const canvasW = Node.viewportWidth
    const left    = contentLeft(canvasW)
    const availW  = Math.max(PW_MIN, canvasW - left - RIGHT_MARGIN)

    const ppc  = this._pillsPerCol()
    const cols = Math.max(1, Math.ceil(this._rows.length / ppc))

    const totalGap = (cols - 1) * COL_GAP
    let pillW = PW_MAX
    if (cols * PW_MAX + totalGap > availW) {
      pillW = Math.max(PW_MIN, (availW - totalGap) / cols)
    }

    const gridW = cols * pillW + totalGap
    const panX  = left + Math.max(0, (availW - gridW) / 2)

    return { panX, pillW, ppc }
  }

  private _pillX(i: number, panX: number, pillW: number, ppc: number): number {
    return panX + Math.floor(i / ppc) * (pillW + COL_GAP)
  }
  private _pillY(i: number, ppc: number): number {
    return PY0 + (i % ppc) * (PH + PGAP)
  }

  override get panelBottom(): number {
    const ppc   = this._pillsPerCol()
    const nRows = Math.min(this._rows.length, ppc)
    return PY0 + nRows * (PH + PGAP) - PGAP + 8
  }

  renderPanel(ctx: Ctx2D): void {
    this._filterSlotBounds.clear()

    const N = this._rows.length
    const { panX, pillW, ppc } = this._layout()
    const srcSlotY = PY0 - SLT_H - PGAP

    ctx.save()

    // ── Source image slot — above column 0 ───────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.40)'
    ctx.beginPath()
    ctx.roundRect(panX, srcSlotY, pillW, SLT_H, 6)
    ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(panX, srcSlotY, STRIPE, SLT_H, [3, 0, 0, 3])
    ctx.fill()
    this._drawSlotRow(ctx, this._sourceSlot, 'image', panX, srcSlotY, pillW, ACCENT, this._srcPreview)
    this._filterSlotBounds.set(this._sourceSlot, { x: panX, y: srcSlotY, width: pillW, height: SLT_H })

    // ── Pills ─────────────────────────────────────────────────
    for (let i = 0; i < N; i++) {
      const row  = this._rows[i]!
      const colX = this._pillX(i, panX, pillW, ppc)
      const py   = this._pillY(i, ppc)

      if (this._dragRow === i) {
        ctx.globalAlpha = 0.25
        this._drawPill(ctx, row, colX, py, pillW, false)
        ctx.globalAlpha = 1
      } else {
        this._drawPill(ctx, row, colX, py, pillW, true)
      }
    }

    // Floating dragged pill + drop target indicator
    if (this._dragRow >= 0 && this._dragRow < N) {
      this._drawPill(ctx, this._rows[this._dragRow]!, this._dragX, this._dragY, pillW, false)
      if (this._dragTarget >= 0 && this._dragTarget !== this._dragRow) {
        const tx = this._pillX(this._dragTarget, panX, pillW, ppc)
        const ty = this._pillY(this._dragTarget, ppc)
        ctx.strokeStyle = ACCENT
        ctx.lineWidth   = 2
        ctx.setLineDash([4, 4])
        ctx.beginPath()
        ctx.roundRect(tx + 2, ty + 2, pillW - 4, PH - 4, 5)
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    const N = this._rows.length
    const { panX, pillW, ppc } = this._layout()
    const numCols  = Math.ceil(N / ppc)
    const nRows    = Math.min(N, ppc)
    const totalW   = numCols * (pillW + COL_GAP) - COL_GAP
    const totalH   = nRows * (PH + PGAP) - PGAP
    const srcSlotY = PY0 - SLT_H - PGAP
    return (point.x >= panX && point.x <= panX + totalW &&
            point.y >= srcSlotY && point.y <= PY0 + totalH) ? this : null
  }

  override hitTestSlot(point: Point): ParameterSlot | null {
    const base = super.hitTestSlot(point)
    if (base !== null) return base
    for (const [slot, b] of this._filterSlotBounds) {
      if (boundingBoxContains(b, point)) return slot
    }
    return null
  }

  handlePointerDown(point: Point): boolean {
    const N = this._rows.length
    const { panX, pillW, ppc } = this._layout()
    for (let i = 0; i < N; i++) {
      const row  = this._rows[i]!
      const colX = this._pillX(i, panX, pillW, ppc)
      const py   = this._pillY(i, ppc)
      if (point.x < colX || point.x > colX + pillW) continue
      if (point.y < py   || point.y > py + PH) continue

      const r1Y = py + ROW_PAD
      const r2Y = r1Y + ROW_H + ROW_GAP
      const r3Y = r2Y + ROW_H + ROW_GAP

      // ── Row 1: drag handle or consume ─────────────────────
      if (point.y < r2Y) {
        if (point.x >= colX + DRAG_OX && point.x < colX + DRAG_OX + BTN_W) {
          this._dragRow     = i
          this._dragOffsetX = point.x - colX
          this._dragOffset  = point.y - py
          this._dragX       = colX
          this._dragY       = py
          this._dragTarget  = i
          this.markDirty()
          return true
        }
        return true  // consume other row-1 clicks
      }

      // ── Row 2: toggle button or enable-slot click ──────────
      if (point.y < r3Y) {
        if (point.x >= colX + DRAG_OX && point.x < colX + DRAG_OX + BTN_W) {
          this._handleToggle(row)
          return true
        }
        return false  // route to InteractionSystem slot click for enableSlot
      }

      // ── Row 3: depends on amountSlot state ────────────────
      if (row.amountSlot.isActive) {
        // Collapse button → suspend binding → back to slider mode
        if (point.x >= colX + DRAG_OX && point.x < colX + DRAG_OX + BTN_W) {
          row.amountSlot.suspend()
          this.markDirty()
          return true
        }
        return false  // slot click (select source, replace binding, context menu)
      } else {
        // Mini square at right → slot click
        const miniL = colX + pillW - RPAD - MINI_SQ
        if (point.x >= miniL) return false

        // Slider area → drag; auto-enable if the filter is currently off
        if (!row.enabled) {
          if (row.enableSlot.state === SlotState.Bound) row.enableSlot.suspend()
          row.enabled = true
        }
        row.sliderDragging = true
        this._setSlider(row, colX, point.x, pillW)
        return true
      }
    }
    return false
  }

  handlePointerMove(point: Point): void {
    const { panX, pillW, ppc } = this._layout()

    // Drag reorder
    if (this._dragRow >= 0) {
      const N = this._rows.length
      this._dragX = point.x - this._dragOffsetX
      this._dragY = point.y - this._dragOffset
      // Find nearest pill by Euclidean distance from ghost centre
      const gx = this._dragX + pillW / 2
      const gy = this._dragY + PH / 2
      let bestIdx = 0, bestDist = Infinity
      for (let i = 0; i < N; i++) {
        const cx = this._pillX(i, panX, pillW, ppc) + pillW / 2
        const cy = this._pillY(i, ppc) + PH / 2
        const d  = (gx - cx) ** 2 + (gy - cy) ** 2
        if (d < bestDist) { bestDist = d; bestIdx = i }
      }
      this._dragTarget = bestIdx
      this.markDirty()
      return
    }

    // Slider drag
    for (let i = 0; i < this._rows.length; i++) {
      const row = this._rows[i]!
      if (row.sliderDragging) {
        this._setSlider(row, this._pillX(i, panX, pillW, ppc), point.x, pillW)
        return
      }
    }
  }

  handlePointerUp(): void {
    // Commit reorder
    if (this._dragRow >= 0) {
      const tgt = this._dragTarget
      const src = this._dragRow
      if (tgt !== src && tgt >= 0) {
        const row = this._rows.splice(src, 1)[0]!
        this._rows.splice(tgt, 0, row)
        this.markDirty()
      }
      this._dragRow    = -1
      this._dragTarget = -1
    }

    // End slider drag
    for (const row of this._rows) row.sliderDragging = false
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _handleToggle(row: FilterRow): void {
    if (row.enableSlot.state === SlotState.Bound) {
      row.enableSlot.suspend()
    } else if (row.enableSlot.state === SlotState.SuspendedBound) {
      row.enableSlot.resume()
    } else {
      row.enabled = !row.enabled
      this.markDirty()
    }
  }

  private _setSlider(row: FilterRow, colX: number, px: number, pillW: number): void {
    const sldX0 = colX + DRAG_OX
    const sldXR = colX + pillW - RPAD - MINI_GAP - MINI_SQ
    const sldW  = sldXR - sldX0
    if (sldW <= 0) return
    row.intensity = Math.max(0, Math.min(1, (px - sldX0) / sldW))
    this.markDirty()
  }

  /** Preview thumbnail overlaid at the top-right of row 1. */
  private _drawThumb(
    ctx: Ctx2D, thumb: OffscreenCanvas | null | undefined, colX: number, rowTopY: number, pillW: number, enabled: boolean,
  ): void {
    const tx = colX + pillW - RPAD - THUMB_W
    const ty = rowTopY + (ROW_H - THUMB_H) / 2
    if (thumb && enabled) {
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(tx, ty, THUMB_W, THUMB_H, 3)
      ctx.clip()
      ctx.drawImage(thumb as CanvasImageSource, tx, ty, THUMB_W, THUMB_H)
      ctx.restore()
      ctx.strokeStyle = 'rgba(255,255,255,0.28)'
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.04)'
      ctx.beginPath()
      ctx.roundRect(tx, ty, THUMB_W, THUMB_H, 3)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    }
    ctx.lineWidth = 1
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.roundRect(tx + 0.5, ty + 0.5, THUMB_W - 1, THUMB_H - 1, 3)
    ctx.stroke()
  }

  private _drawPill(
    ctx: Ctx2D, row: FilterRow, colX: number, py: number, pillW: number,
    registerSlots: boolean,
  ): void {
    const r1Y    = py + ROW_PAD
    const r2Y    = r1Y + ROW_H + ROW_GAP
    const r3Y    = r2Y + ROW_H + ROW_GAP
    const r1MidY = r1Y + ROW_H / 2
    const r3MidY = r3Y + ROW_H / 2
    const enabled = row.enabled

    // ── Full pill background ───────────────────────────────────
    ctx.fillStyle = enabled ? 'rgba(0,0,0,0.50)' : 'rgba(0,0,0,0.28)'
    ctx.beginPath(); ctx.roundRect(colX, py, pillW, PH, 6); ctx.fill()

    // ── Accent stripe ─────────────────────────────────────────
    ctx.fillStyle = enabled ? ACCENT : 'rgba(126,207,126,0.28)'
    ctx.beginPath(); ctx.roundRect(colX, py, STRIPE, PH, [3, 0, 0, 3]); ctx.fill()

    // ── Row 1: Drag handle | Filter name | Thumbnail ──────────
    const dhMidX = colX + DRAG_OX + BTN_W / 2
    ctx.fillStyle = 'rgba(255,255,255,0.22)'
    for (let d = 0; d < 3; d++) {
      const dy = r1MidY - 4 + d * 4
      ctx.fillRect(dhMidX - DRAG_W / 2, dy - 1, DRAG_W, 2)
    }
    ctx.font = 'bold 10px monospace'
    ctx.fillStyle = enabled ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0.7)'
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText(row.def.label, colX + SLT_X, r1MidY)
    this._drawThumb(ctx, this._rowPreviews.get(row), colX, r1Y, pillW, enabled)

    // ── Row 2: Toggle button | Enable slot (no label) ─────────
    this._drawToggle(ctx, colX + DRAG_OX, r2Y + (ROW_H - BTN_W) / 2, BTN_W, row)
    const evX = colX + SLT_X
    const evW = pillW - SLT_X - RPAD
    this._drawCompactSlot(ctx, row.enableSlot, evX, r2Y + 3, evW, ROW_H - 6, EV_COL)
    if (registerSlots) {
      this._filterSlotBounds.set(row.enableSlot, { x: evX, y: r2Y, width: evW, height: ROW_H })
    }

    // ── Row 3: Slider + mini square  -or-  Collapse btn + slot ─
    const amBound  = row.amountSlot.isActive
    const amSusp   = row.amountSlot.state === SlotState.SuspendedBound
    const amCompat = Node.bindDrag.active
                  && Node.bindDrag.source !== null
                  && row.amountSlot.type !== null
                  && Node.bindDrag.source.types.has(row.amountSlot.type)

    if (amBound) {
      // Mini slider as collapse-to-slider control at left column
      const miniSliderCol = row.enabled ? ACCENT : 'rgba(255,255,255,0.22)'
      this._drawMiniSlider(ctx, colX + DRAG_OX, r3Y + (ROW_H - BTN_W) / 2, BTN_W, miniSliderCol)
      // Amount slot expanded to full content width
      const amX = colX + SLT_X
      const amW = pillW - SLT_X - RPAD
      this._drawCompactSlot(ctx, row.amountSlot, amX, r3Y + 3, amW, ROW_H - 6, AM_COL)
      if (registerSlots) {
        this._filterSlotBounds.set(row.amountSlot, { x: colX, y: r3Y, width: pillW, height: ROW_H })
      }
    } else {
      // Compat-drag highlight covers the entire slider + mini-square area
      if (amCompat) {
        const hlX = colX + DRAG_OX;  const hlW = pillW - DRAG_OX - RPAD
        const hlY = r3Y + 2;         const hlH = ROW_H - 4
        ctx.fillStyle = 'rgba(50,200,70,0.12)'
        ctx.beginPath(); ctx.roundRect(hlX, hlY, hlW, hlH, 4); ctx.fill()
        ctx.strokeStyle = 'rgba(50,200,70,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([])
        ctx.beginPath(); ctx.roundRect(hlX + 0.5, hlY + 0.5, hlW - 1, hlH - 1, 4); ctx.stroke()
      }

      // Slider track (greyed when suspended)
      this._drawSlider(ctx, row, colX, r3MidY, pillW, amSusp)

      // Mini slot square at right
      const sqX = colX + pillW - RPAD - MINI_SQ
      const sqY = r3Y + (ROW_H - MINI_SQ) / 2
      if (!amCompat) {
        if (amSusp) {
          ctx.fillStyle = AM_COL + '11'
          ctx.beginPath(); ctx.roundRect(sqX, sqY, MINI_SQ, MINI_SQ, 4); ctx.fill()
          ctx.strokeStyle = 'rgba(255,255,255,0.40)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3])
          ctx.beginPath(); ctx.roundRect(sqX + 0.5, sqY + 0.5, MINI_SQ - 1, MINI_SQ - 1, 4); ctx.stroke()
          ctx.setLineDash([])
          ctx.fillStyle = 'rgba(255,255,255,0.50)'; ctx.font = '11px monospace'
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillText('⏸', sqX + MINI_SQ / 2, r3MidY)
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3])
          ctx.beginPath(); ctx.roundRect(sqX + 0.5, sqY + 0.5, MINI_SQ - 1, MINI_SQ - 1, 4); ctx.stroke()
          ctx.setLineDash([])
        }
      }

      if (registerSlots) {
        this._filterSlotBounds.set(row.amountSlot, { x: colX, y: r3Y, width: pillW, height: ROW_H })
      }
    }

    // Suppress stale textBaseline
    ctx.textBaseline = 'alphabetic'
  }

  private _drawToggle(ctx: Ctx2D, bx: number, by: number, sz: number, row: FilterRow): void {
    const { enabled, enableSlot } = row
    const bound    = enableSlot.isActive
    const susp     = enableSlot.state === SlotState.SuspendedBound

    // Background fill
    ctx.fillStyle = enabled
      ? (bound ? 'rgba(224,224,96,0.22)' : 'rgba(126,207,126,0.22)')
      : 'rgba(255,255,255,0.04)'
    ctx.beginPath()
    ctx.roundRect(bx, by, sz, sz, 4)
    ctx.fill()

    // Border
    if (bound) {
      ctx.strokeStyle = EV_COL
      ctx.lineWidth   = 1.5
      ctx.setLineDash([])
    } else if (susp) {
      ctx.strokeStyle = EV_COL + 'cc'
      ctx.lineWidth   = 1
      ctx.setLineDash([2, 2])
    } else if (enabled) {
      ctx.strokeStyle = ACCENT
      ctx.lineWidth   = 1.5
      ctx.setLineDash([])
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'
      ctx.lineWidth   = 1
      ctx.setLineDash([])
    }
    ctx.beginPath()
    ctx.roundRect(bx + 0.5, by + 0.5, sz - 1, sz - 1, 4)
    ctx.stroke()
    ctx.setLineDash([])

    // Centre dot
    ctx.fillStyle = enabled
      ? (bound ? EV_COL : ACCENT)
      : 'rgba(255,255,255,0.18)'
    ctx.beginPath()
    ctx.arc(bx + sz / 2, by + sz / 2, 5, 0, Math.PI * 2)
    ctx.fill()
  }

  private _drawSlider(ctx: Ctx2D, row: FilterRow, colX: number, midY: number, pillW: number, suspended = false): void {
    const sldXR = colX + pillW - RPAD - MINI_GAP - MINI_SQ
    const sldX0 = colX + DRAG_OX
    const sldW  = sldXR - sldX0
    if (sldW <= 0) return
    const v      = row.intensity
    const thumbR = 5
    const x1     = sldX0 + thumbR
    const x2     = sldXR - thumbR
    const range  = Math.max(0, x2 - x1)
    const thumbX = x1 + v * range

    ctx.lineCap = 'round'

    // Track background
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth   = 3
    ctx.beginPath(); ctx.moveTo(x1, midY); ctx.lineTo(x2, midY); ctx.stroke()

    // Filled portion + thumb (dimmed when binding is suspended)
    const col = suspended           ? 'rgba(255,255,255,0.22)'
              : row.enabled         ? ACCENT
              :                      'rgba(255,255,255,0.22)'
    ctx.strokeStyle = col; ctx.lineWidth = 3
    ctx.beginPath(); ctx.moveTo(x1, midY); ctx.lineTo(thumbX, midY); ctx.stroke()
    ctx.fillStyle = col
    ctx.beginPath(); ctx.arc(thumbX, midY, thumbR, 0, Math.PI * 2); ctx.fill()
  }

  /** Compact slot box used in rows 2 and 3 — no label text. */
  private _drawCompactSlot(
    ctx: Ctx2D, slot: ParameterSlot, x: number, y: number, w: number, h: number, typeCol: string,
  ): void {
    const isCompat = Node.bindDrag.active
                  && Node.bindDrag.source !== null
                  && slot.type !== null
                  && Node.bindDrag.source.types.has(slot.type)

    ctx.font = '10px monospace'; ctx.textBaseline = 'middle'

    if (slot.isActive && !isCompat) {
      const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
      ctx.fillStyle = typeCol + '22'
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.fill()
      ctx.strokeStyle = typeCol + 'cc'; ctx.lineWidth = 1; ctx.setLineDash([])
      ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 4); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.textAlign = 'left'
      ctx.fillText(srcName, x + 6, y + h / 2)
    } else if (isCompat) {
      ctx.fillStyle = 'rgba(50,200,70,0.18)'
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.fill()
      ctx.strokeStyle = 'rgba(50,200,70,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([])
      ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 4); ctx.stroke()
      ctx.fillStyle = 'rgba(100,255,120,0.75)'; ctx.textAlign = 'left'
      ctx.fillText(slot.isActive ? 'replace binding' : 'drop to bind', x + 6, y + h / 2)
    } else if (slot.state === SlotState.SuspendedBound) {
      const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
      ctx.fillStyle = typeCol + '11'
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.40)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 4); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.60)'; ctx.textAlign = 'left'
      ctx.fillText('⏸ ' + srcName, x + 6, y + h / 2)
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 4); ctx.stroke()
      ctx.setLineDash([])
    }
  }

  /** Mini slider used as the collapse-to-slider button in row 3 when amountSlot is bound. */
  private _drawMiniSlider(ctx: Ctx2D, bx: number, by: number, sz: number, col: string): void {
    const midX  = bx + sz / 2
    const midY  = by + sz / 2
    const thumbR = 5
    const x1 = bx + thumbR + 1   // track left  (a few px beyond left thumb edge)
    const x2 = bx + sz - thumbR - 1  // track right (a few px beyond right thumb edge)
    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 3
    ctx.beginPath(); ctx.moveTo(x1, midY); ctx.lineTo(x2, midY); ctx.stroke()
    ctx.strokeStyle = col; ctx.lineWidth = 3
    ctx.beginPath(); ctx.moveTo(x1, midY); ctx.lineTo(midX, midY); ctx.stroke()
    ctx.fillStyle = col
    ctx.beginPath(); ctx.arc(midX, midY, thumbR, 0, Math.PI * 2); ctx.fill()
  }

  private _drawSlotRow(
    ctx: Ctx2D,
    slot: ParameterSlot,
    label: string,
    colX: number,
    y: number,
    pillW: number,
    typeCol: string,
    preview?: OffscreenCanvas | null,
  ): void {
    const hasPreview = preview !== undefined
    const vx = colX + SLT_LW
    const vw = pillW - SLT_LW - 2 - (hasPreview ? THUMB_W + THUMB_GAP : 0)
    const by = y + 3
    const bh = SLT_H - 6

    if (hasPreview) {
      const tx = vx + vw + THUMB_GAP
      const ty = y + (SLT_H - THUMB_H) / 2
      if (preview) {
        ctx.save()
        ctx.beginPath()
        ctx.roundRect(tx, ty, THUMB_W, THUMB_H, 3)
        ctx.clip()
        ctx.drawImage(preview as CanvasImageSource, tx, ty, THUMB_W, THUMB_H)
        ctx.restore()
        ctx.strokeStyle = ACCENT + '55'
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.04)'
        ctx.beginPath()
        ctx.roundRect(tx, ty, THUMB_W, THUMB_H, 3)
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.10)'
      }
      ctx.lineWidth = 1
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.roundRect(tx + 0.5, ty + 0.5, THUMB_W - 1, THUMB_H - 1, 3)
      ctx.stroke()
    }

    const isCompat = Node.bindDrag.active
                  && Node.bindDrag.source !== null
                  && slot.type !== null
                  && Node.bindDrag.source.types.has(slot.type)

    ctx.font         = '10px monospace'
    ctx.textBaseline = 'middle'

    // Label
    ctx.fillStyle = 'rgba(255,255,255,0.62)'
    ctx.textAlign = 'left'
    ctx.fillText(label, colX + 6, y + SLT_H / 2)

    if (slot.isActive && !isCompat) {
      const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
      ctx.fillStyle = typeCol + '22'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = typeCol + 'cc'; ctx.lineWidth = 1; ctx.setLineDash([])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.textAlign = 'left'
      ctx.fillText(srcName, vx + 6, y + SLT_H / 2)
    } else if (isCompat) {
      ctx.fillStyle = 'rgba(50,200,70,0.18)'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = 'rgba(50,200,70,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.fillStyle = 'rgba(100,255,120,0.75)'; ctx.textAlign = 'left'
      ctx.fillText(slot.isActive ? 'replace binding' : 'drop to bind', vx + 6, y + SLT_H / 2)
    } else if (slot.state === SlotState.SuspendedBound) {
      const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
      ctx.fillStyle = typeCol + '11'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.40)'; ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.60)'; ctx.textAlign = 'left'
      ctx.fillText('⏸ ' + srcName, vx + 6, y + SLT_H / 2)
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.textAlign = 'left'
      ctx.fillText('unbound', vx + 6, y + SLT_H / 2)
    }
  }
}
