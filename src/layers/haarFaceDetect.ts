// Face detection — two approaches:
//
// 1. YCbCr skin-tone detection (Tsekeridou & Pitas 1998) — simple, fast,
//    high recall. Skin pixels fall in a consistent Cb/Cr band regardless of
//    lighting. Returns approximate face centre/radius from the skin-pixel
//    centroid. ~3 % of frame must be skin-coloured.
//
// 2. Viola-Jones HAAR cascade (tracking.js, BSD) — more precise but slower
//    and misses faces that don't fill the frame well.

import { FACE_CASCADE } from './faceCascade.js'

export interface FaceRect {
  x: number; y: number; width: number; height: number
}

// Returned by detectSkin — image-pixel coordinates of the skin region.
export interface SkinResult {
  cx: number; cy: number   // centroid of skin pixels
  radius: number           // estimated face radius (sqrt(area/π))
}

/**
 * YCbCr skin-tone detector.
 * Returns the centroid and estimated radius of the skin region if enough
 * skin pixels are found, otherwise null.
 *
 * @param rgba   Uint8ClampedArray from getImageData (RGBA)
 * @param width  Image width
 * @param height Image height
 * @param minFraction  Minimum fraction of frame that must be skin (default 0.03)
 */
export function detectSkin(
  rgba:        Uint8ClampedArray,
  width:       number,
  height:      number,
  minFraction  = 0.03,
): SkinResult | null {
  let count = 0, sumX = 0, sumY = 0
  const total = width * height

  for (let i = 0; i < total; i++) {
    const r = rgba[4 * i]     as number
    const g = rgba[4 * i + 1] as number
    const b = rgba[4 * i + 2] as number
    // BT.601 Cb/Cr (Y not needed for the range check, but guard dark pixels)
    const Y  =  0.299 * r + 0.587 * g + 0.114 * b
    if (Y < 40) continue   // too dark to be reliable skin
    const Cb = 128 - 0.169 * r - 0.331 * g + 0.500 * b
    const Cr = 128 + 0.500 * r - 0.419 * g - 0.081 * b
    if (Cb >= 77 && Cb <= 127 && Cr >= 133 && Cr <= 173) {
      count++
      sumX += i % width
      sumY += (i / width) | 0
    }
  }

  if (count < total * minFraction) return null

  return {
    cx:     sumX / count,
    cy:     sumY / count,
    radius: Math.sqrt(count / Math.PI),
  }
}

/**
 * Detect frontal faces in a grayscale image.
 * Returns bounding rectangles in image-pixel coordinates.
 */
export function detectFaces(
  gray:   Uint8Array,
  width:  number,
  height: number,
): FaceRect[] {
  const integral    = new Int32Array(width * height)
  const integralSq  = new Int32Array(width * height)
  _buildIntegral(gray, width, height, integral, integralSq)

  const data      = FACE_CASCADE
  const minW      = data[0] as number   // 20
  const minH      = data[1] as number   // 20
  const rects: FaceRect[] = []

  const INITIAL_SCALE = 1.0
  const SCALE_FACTOR  = 1.2
  const STEP_FACTOR   = 0.1   // step = scale * minW * STEP_FACTOR

  for (let scale = INITIAL_SCALE; ; scale *= SCALE_FACTOR) {
    const bw = Math.floor(scale * minW)
    const bh = Math.floor(scale * minH)
    if (bw > width || bh > height) break

    const step = Math.max(2, Math.floor(bw * STEP_FACTOR))

    for (let y = 0; y + bh < height; y += step) {
      for (let x = 0; x + bw < width; x += step) {
        if (_evalCascade(data, integral, integralSq, x, y, width, bw, bh, scale)) {
          rects.push({ x, y, width: bw, height: bh })
        }
      }
    }
  }

  return _mergeRects(rects)
}

/** Convert RGBA pixel array to grayscale. */
export function rgbaToGray(rgba: Uint8ClampedArray, n: number): Uint8Array {
  const g = new Uint8Array(n)
  for (let i = 0; i < n; i++)
    g[i] = (77 * (rgba[4*i] as number) + 150 * (rgba[4*i+1] as number) + 29 * (rgba[4*i+2] as number)) >> 8
  return g
}

// ── private ───────────────────────────────────────────────────────────────────

function _buildIntegral(
  gray: Uint8Array, w: number, h: number,
  ii: Int32Array, iiSq: Int32Array,
): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      const p   = gray[idx] as number
      const up  = y > 0 ? ii[(y-1)*w + x]  as number : 0
      const lf  = x > 0 ? ii[y*w + (x-1)]  as number : 0
      const ul  = y > 0 && x > 0 ? ii[(y-1)*w + (x-1)] as number : 0
      ii[idx]   = p + up + lf - ul

      const upSq = y > 0 ? iiSq[(y-1)*w + x]  as number : 0
      const lfSq = x > 0 ? iiSq[y*w + (x-1)]  as number : 0
      const ulSq = y > 0 && x > 0 ? iiSq[(y-1)*w + (x-1)] as number : 0
      iiSq[idx]  = p * p + upSq + lfSq - ulSq
    }
  }
}

function _rectSum(ii: Int32Array, w: number, x: number, y: number, rw: number, rh: number): number {
  const w1 = y * w + x
  const w2 = w1 + rw
  const w3 = w1 + rh * w
  const w4 = w3 + rw
  return (ii[w1] as number) - (ii[w2] as number) - (ii[w3] as number) + (ii[w4] as number)
}

function _evalCascade(
  data: Float64Array,
  ii: Int32Array, iiSq: Int32Array,
  bx: number, by: number, imW: number,
  bw: number, bh: number, scale: number,
): boolean {
  const invArea = 1.0 / (bw * bh)

  // Mean and std-dev of the block for normalisation
  const mean = _rectSum(ii,   imW, bx, by, bw, bh) * invArea
  const sq   = _rectSum(iiSq, imW, bx, by, bw, bh) * invArea
  const vari = sq - mean * mean
  const std  = vari > 0 ? Math.sqrt(vari) : 1

  let w = 2  // cursor into data array (skip minW, minH)
  const len = data.length

  while (w < len) {
    const stageThr  = data[w++] as number
    let   nNodes    = data[w++] as number
    let   stageSum  = 0

    while (nNodes-- > 0) {
      const tilted    = data[w++] as number   // always 0 for frontal face
      let   nRects    = data[w++] as number
      let   rectSum   = 0

      while (nRects-- > 0) {
        const rx  = (bx + (data[w++] as number) * scale + 0.5) | 0
        const ry  = (by + (data[w++] as number) * scale + 0.5) | 0
        const rw  = (     (data[w++] as number) * scale + 0.5) | 0
        const rh  = (     (data[w++] as number) * scale + 0.5) | 0
        const rwt = data[w++] as number
        if (!tilted) {
          // Guard against out-of-bounds (can occur at image edges)
          if (rx >= 0 && ry >= 0 && rx + rw <= imW && ry + rh <= (ii.length / imW | 0)) {
            rectSum += _rectSum(ii, imW, rx, ry, rw, rh) * rwt
          }
        }
      }

      const nodeThr = data[w++] as number
      const left    = data[w++] as number
      const right   = data[w++] as number
      stageSum += rectSum * invArea < nodeThr * std ? left : right
    }

    if (stageSum < stageThr) return false
  }
  return true
}

function _mergeRects(rects: FaceRect[]): FaceRect[] {
  if (rects.length === 0) return []
  const used = new Uint8Array(rects.length)
  const out: FaceRect[] = []

  for (let i = 0; i < rects.length; i++) {
    if (used[i]) continue
    const ri = rects[i]!
    let x = ri.x, y = ri.y, w = ri.width, h = ri.height, n = 1

    for (let j = i + 1; j < rects.length; j++) {
      if (used[j]) continue
      const b = rects[j]!
      const ox = Math.min(x + w, b.x + b.width)  - Math.max(x, b.x)
      const oy = Math.min(y + h, b.y + b.height) - Math.max(y, b.y)
      if (ox > 0 && oy > 0 && ox * oy > 0.3 * Math.min(w * h, b.width * b.height)) {
        x += b.x; y += b.y; w += b.width; h += b.height
        n++; used[j] = 1
      }
    }
    out.push({ x: x/n|0, y: y/n|0, width: w/n|0, height: h/n|0 })
  }
  return out
}
