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

// ── Threshold: transparent where brighter than amount ────────────
function _threshold(d: Uint8ClampedArray, t: number): void {
  const thresh = t * 255
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.2126 * d[i]! + 0.7152 * d[i+1]! + 0.0722 * d[i+2]!
    if (lum > thresh) d[i+3] = 0
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
  { label: 'shadow',     defaultT: 0.40, apply: _dropShadow },
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

const PX      = 300           // pill column left edge (= canvasBounds.x)
const PW      = 260           // pill column width
const PY0     = 50            // pill column top (= canvasBounds.y)
const PH_CTRL = 32            // control row height
const SLT_H   = 26            // slot row height (matches Layer.renderSlots)
const SLT_GAP = 3             // padding above / between / below slot rows
const PH      = PH_CTRL + SLT_GAP + SLT_H + SLT_GAP + SLT_H + SLT_GAP  // 93
const PGAP    = 4             // gap between pills

// Left side offsets (relative to PX):
const STRIPE  = 4             // accent stripe width
const DRAG_OX = STRIPE + 4   // drag handle x-offset  (8)
const DRAG_W  = 14            // drag handle width
const TOG_OX  = DRAG_OX + DRAG_W + 4   // toggle button x-offset (26)
const TOG_SZ  = 22            // toggle button square size
const NAME_OX = TOG_OX + TOG_SZ + 4    // name label x-offset    (52)
const NAME_W  = 54            // name label width
const SLD_OX  = NAME_OX + NAME_W + 4   // slider x-offset        (110)

// Right side — positions are relative to each column's left edge
const RPAD    = 8
const SLD_OR  = PW - RPAD                                         // 252 (slider right offset)
const SLD_W   = Math.max(0, SLD_OR - SLD_OX)                      // 142

// Slot row label column width (matches Layer.renderSlots LABEL_W)
const SLT_LW  = 78

// Multi-column layout
const COL_GAP = 16            // horizontal gap between columns

// Intermediate preview thumbnails — shown to the right of each pill's column.
const PREV_W = 54
const PREV_H = PH_CTRL   // thumbnail height = control row only

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

    this.debugName = 'Filter'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // Accessors
  // ----------------------------------------------------------

  get sourceSlot(): ParameterSlot { return this._sourceSlot }

  override autoBindRules() {
    return [{
      slot:    this._sourceSlot,
      accepts: (l: Layer) => l.types.has(ValueType.Image),
    }]
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._result }

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

    // ── Apply filter chain via ImageData pixel operations ────
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

    // Size work canvas and result canvas.
    if (!this._workCanvas || this._workCanvas.width !== w || this._workCanvas.height !== h)
      this._workCanvas = new OffscreenCanvas(w, h)
    if (!this._result || this._result.width !== w || this._result.height !== h)
      this._result = new OffscreenCanvas(w, h)

    // Draw source into work canvas so we can read pixels from it.
    const wctx = this._workCanvas.getContext('2d')!
    wctx.clearRect(0, 0, w, h)
    wctx.drawImage(src as CanvasImageSource, 0, 0, w, h)

    // Capture source thumbnail — sized to match the source slot row height.
    if (!this._srcPreview || this._srcPreview.height !== SLT_H)
      this._srcPreview = new OffscreenCanvas(PREV_W, SLT_H)
    const spctx = this._srcPreview.getContext('2d')!
    spctx.clearRect(0, 0, PREV_W, SLT_H)
    spctx.drawImage(this._workCanvas, 0, 0, PREV_W, SLT_H)

    // Pull the pixels into a mutable ImageData buffer.
    const imageData = wctx.getImageData(0, 0, w, h)
    const d = imageData.data

    // Apply each enabled filter in order, mutating d in-place.
    for (const row of this._rows) {
      if (!row.enabled) continue

      row.def.apply(d, row.intensity, w, h)

      // Write current state back to work canvas and capture thumbnail.
      wctx.putImageData(imageData, 0, 0)
      let prev = this._rowPreviews.get(row)
      if (!prev) { prev = new OffscreenCanvas(PREV_W, PREV_H); this._rowPreviews.set(row, prev) }
      const pctx = prev.getContext('2d')!
      pctx.clearRect(0, 0, PREV_W, PREV_H)
      pctx.drawImage(this._workCanvas, 0, 0, PREV_W, PREV_H)
    }

    // Write final result.
    const rctx = this._result.getContext('2d')!
    rctx.clearRect(0, 0, w, h)
    rctx.putImageData(imageData, 0, 0)
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    if (this._result === null) return
    ctx.drawImage(this._result as CanvasImageSource, 0, 0, Node.canvasWidth, Node.canvasHeight)
  }

  private _pillsPerCol(): number {
    return Math.max(1, Math.floor((Node.canvasHeight - PY0) / (PH + PGAP)))
  }
  private _pillX(i: number): number {
    return PX + Math.floor(i / this._pillsPerCol()) * (PW + COL_GAP)
  }
  private _pillY(i: number): number {
    return PY0 + (i % this._pillsPerCol()) * (PH + PGAP)
  }

  override get panelBottom(): number {
    const ppc   = this._pillsPerCol()
    const nRows = Math.min(this._rows.length, ppc)
    return PY0 + nRows * (PH + PGAP) - PGAP + 8
  }

  renderPanel(ctx: Ctx2D): void {
    this._filterSlotBounds.clear()

    const N        = this._rows.length
    const srcSlotY = PY0 - SLT_H - PGAP

    ctx.save()

    // ── Source image slot — above column 0 ───────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.40)'
    ctx.beginPath()
    ctx.roundRect(PX, srcSlotY, PW, SLT_H, 6)
    ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(PX, srcSlotY, STRIPE, SLT_H, [3, 0, 0, 3])
    ctx.fill()
    this._drawSlotRow(ctx, this._sourceSlot, 'image', PX, srcSlotY, ACCENT)
    this._filterSlotBounds.set(this._sourceSlot, { x: PX, y: srcSlotY, width: PW, height: SLT_H })

    // ── Pills ─────────────────────────────────────────────────
    for (let i = 0; i < N; i++) {
      const row  = this._rows[i]!
      const colX = this._pillX(i)
      const py   = this._pillY(i)

      if (this._dragRow === i) {
        ctx.globalAlpha = 0.25
        this._drawPill(ctx, row, colX, py, false)
        ctx.globalAlpha = 1
      } else {
        this._drawPill(ctx, row, colX, py, true)
      }
    }

    // Floating dragged pill + drop target indicator
    if (this._dragRow >= 0 && this._dragRow < N) {
      this._drawPill(ctx, this._rows[this._dragRow]!, this._dragX, this._dragY, false)
      if (this._dragTarget >= 0 && this._dragTarget !== this._dragRow) {
        const tx = this._pillX(this._dragTarget)
        const ty = this._pillY(this._dragTarget)
        ctx.strokeStyle = ACCENT
        ctx.lineWidth   = 2
        ctx.setLineDash([4, 4])
        ctx.beginPath()
        ctx.roundRect(tx + 2, ty + 2, PW - 4, PH - 4, 5)
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    // ── Preview thumbnails ────────────────────────────────────
    this._drawPreviews(ctx)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    const N        = this._rows.length
    const ppc      = this._pillsPerCol()
    const numCols  = Math.ceil(N / ppc)
    const nRows    = Math.min(N, ppc)
    const totalW   = numCols * (PW + COL_GAP) - COL_GAP
    const totalH   = nRows * (PH + PGAP) - PGAP
    const srcSlotY = PY0 - SLT_H - PGAP
    return (point.x >= PX && point.x <= PX + totalW &&
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
    for (let i = 0; i < N; i++) {
      const row  = this._rows[i]!
      const colX = this._pillX(i)
      const py   = this._pillY(i)
      if (point.x < colX || point.x > colX + PW) continue
      if (point.y < py   || point.y > py   + PH) continue

      // Slot row area — return false so InteractionSystem routes to _onSlotClick
      if (point.y >= py + PH_CTRL) return false

      // Drag handle zone
      const dragX = colX + DRAG_OX
      if (point.x >= dragX && point.x < dragX + DRAG_W) {
        this._dragRow     = i
        this._dragOffsetX = point.x - colX
        this._dragOffset  = point.y - py
        this._dragX       = colX
        this._dragY       = py
        this._dragTarget  = i
        this.markDirty()
        return true
      }

      // Toggle button zone
      const togX = colX + TOG_OX
      if (point.x >= togX && point.x < togX + TOG_SZ) {
        this._handleToggle(row)
        return true
      }

      // Slider zone
      const sldX0 = colX + SLD_OX
      const sldXR = colX + SLD_OR
      if (point.x >= sldX0 && point.x <= sldXR && SLD_W > 0) {
        if (row.amountSlot.isActive) row.amountSlot.suspend()
        row.sliderDragging = true
        this._setSlider(row, colX, point.x)
        return true
      }

      return true  // consume other clicks in control row
    }
    return false
  }

  handlePointerMove(point: Point): void {
    // Drag reorder
    if (this._dragRow >= 0) {
      const N = this._rows.length
      this._dragX = point.x - this._dragOffsetX
      this._dragY = point.y - this._dragOffset
      // Find nearest pill by Euclidean distance from ghost centre
      const gx = this._dragX + PW / 2
      const gy = this._dragY + PH / 2
      let bestIdx = 0, bestDist = Infinity
      for (let i = 0; i < N; i++) {
        const cx = this._pillX(i) + PW / 2
        const cy = this._pillY(i) + PH / 2
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
        this._setSlider(row, this._pillX(i), point.x)
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

  private _setSlider(row: FilterRow, colX: number, px: number): void {
    row.intensity = Math.max(0, Math.min(1, (px - colX - SLD_OX) / SLD_W))
    this.markDirty()
  }

  private _drawPreviews(ctx: Ctx2D): void {
    const N        = this._rows.length
    const srcSlotY = PY0 - SLT_H - PGAP
    const srcPrevX = PX + PW + 10

    // Source thumbnail — aligned with the source slot row.
    if (this._srcPreview) {
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(srcPrevX, srcSlotY, PREV_W, SLT_H, 3)
      ctx.clip()
      ctx.drawImage(this._srcPreview as CanvasImageSource, srcPrevX, srcSlotY, PREV_W, SLT_H)
      ctx.restore()
      ctx.strokeStyle = ACCENT + '55'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.roundRect(srcPrevX + 0.5, srcSlotY + 0.5, PREV_W - 1, SLT_H - 1, 3)
      ctx.stroke()
    }

    // Per-filter intermediate thumbnails — one per enabled row, right of its column.
    for (let i = 0; i < N; i++) {
      const row  = this._rows[i]!
      if (!row.enabled || this._dragRow === i) continue
      const prev = this._rowPreviews.get(row)
      if (!prev) continue

      const colX  = this._pillX(i)
      const py    = this._pillY(i)
      const prevX = colX + PW + 10

      ctx.save()
      ctx.beginPath()
      ctx.roundRect(prevX, py, PREV_W, PREV_H, 3)
      ctx.clip()
      ctx.drawImage(prev as CanvasImageSource, prevX, py, PREV_W, PREV_H)
      ctx.restore()

      ctx.strokeStyle = 'rgba(255,255,255,0.28)'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.roundRect(prevX + 0.5, py + 0.5, PREV_W - 1, PREV_H - 1, 3)
      ctx.stroke()
    }
  }

  private _drawPill(
    ctx: Ctx2D, row: FilterRow, colX: number, py: number,
    registerSlots: boolean,
  ): void {
    const ctrlMidY = py + PH_CTRL / 2
    const enabled  = row.enabled

    // Full pill background (covers control row + slot rows)
    ctx.fillStyle = enabled ? 'rgba(0,0,0,0.50)' : 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(colX, py, PW, PH, 6)
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = enabled ? ACCENT : 'rgba(126,207,126,0.28)'
    ctx.beginPath()
    ctx.roundRect(colX, py, STRIPE, PH, [3, 0, 0, 3])
    ctx.fill()

    // Slot row area inset — slightly darker than control row
    const slotAreaY = py + PH_CTRL
    ctx.fillStyle = 'rgba(0,0,0,0.22)'
    ctx.beginPath()
    ctx.roundRect(colX + STRIPE, slotAreaY, PW - STRIPE, PH - PH_CTRL, [0, 0, 6, 0])
    ctx.fill()

    // Drag handle (three horizontal bars)
    const dhX = colX + DRAG_OX + DRAG_W / 2
    ctx.fillStyle = 'rgba(255,255,255,0.22)'
    for (let d = 0; d < 3; d++) {
      const dy = ctrlMidY - 5 + d * 5
      ctx.fillRect(dhX - 5, dy - 1, 10, 2)
    }

    // Toggle button
    this._drawToggle(ctx, colX + TOG_OX, py + (PH_CTRL - TOG_SZ) / 2, TOG_SZ, row)

    // Filter name
    ctx.font         = '10px monospace'
    ctx.fillStyle    = enabled ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.32)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(row.def.label, colX + NAME_OX, ctrlMidY)

    // Intensity slider
    this._drawSlider(ctx, row, colX, ctrlMidY)

    // Slot rows
    const evY = slotAreaY + SLT_GAP
    const amY = evY + SLT_H + SLT_GAP
    this._drawSlotRow(ctx, row.enableSlot, 'toggle', colX, evY, EV_COL)
    this._drawSlotRow(ctx, row.amountSlot, 'amount', colX, amY, AM_COL)

    // Register slot hit zones
    if (registerSlots) {
      this._filterSlotBounds.set(row.enableSlot, { x: colX, y: evY, width: PW, height: SLT_H })
      this._filterSlotBounds.set(row.amountSlot, { x: colX, y: amY, width: PW, height: SLT_H })
    }
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
      ctx.strokeStyle = EV_COL + '80'
      ctx.lineWidth   = 1
      ctx.setLineDash([2, 2])
    } else if (enabled) {
      ctx.strokeStyle = ACCENT
      ctx.lineWidth   = 1.5
      ctx.setLineDash([])
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
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

  private _drawSlider(ctx: Ctx2D, row: FilterRow, colX: number, midY: number): void {
    if (SLD_W <= 0) return
    const v      = row.intensity
    const thumbR = 5
    const x1     = colX + SLD_OX + thumbR
    const x2     = colX + SLD_OR - thumbR
    const range  = Math.max(0, x2 - x1)
    const thumbX = x1 + v * range

    ctx.lineCap = 'round'

    // Track background
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth   = 3
    ctx.beginPath()
    ctx.moveTo(x1, midY)
    ctx.lineTo(x2, midY)
    ctx.stroke()

    // Filled portion
    const col = row.amountSlot.isActive ? AM_COL
              : row.enabled             ? ACCENT
              :                          'rgba(255,255,255,0.22)'
    ctx.strokeStyle = col
    ctx.lineWidth   = 3
    ctx.beginPath()
    ctx.moveTo(x1, midY)
    ctx.lineTo(thumbX, midY)
    ctx.stroke()

    // Thumb
    ctx.fillStyle = col
    ctx.beginPath()
    ctx.arc(thumbX, midY, thumbR, 0, Math.PI * 2)
    ctx.fill()
  }

  private _drawSlotRow(
    ctx: Ctx2D,
    slot: ParameterSlot,
    label: string,
    colX: number,
    y: number,
    typeCol: string,
  ): void {
    const vx = colX + SLT_LW
    const vw = PW - SLT_LW - 2
    const by = y + 3
    const bh = SLT_H - 6

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
