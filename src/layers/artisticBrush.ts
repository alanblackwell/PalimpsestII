// ------------------------------------------------------------
// artisticBrush.ts — shared drawing infrastructure
// for non-outline artistic rendering (Cases 0–3).
// ------------------------------------------------------------
//
// All functions are pure / stateless. Callers are responsible
// for save/restore around calls if needed.
//
// Seeded noise: pass a stable integer seed (e.g. from
// hashString(layer.debugName)) so identical parameters always
// produce identical output — required by the dirty/cache model.

// ── Seeded PRNG ───────────────────────────────────────────────

// Mulberry32 — fast, high-quality 32-bit PRNG
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s += 0x6D2B79F5
    let t = Math.imul(s ^ (s >>> 15), s | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0xFFFFFFFF
  }
}

// djb2 string → integer hash
export function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0
  return h
}

// ── 1-D value noise ──────────────────────────────────────────
// Output range [-1, +1], period = 64 lattice pts, cosine interp.

const LATTICE = 64

export function makeNoise1D(seed: number): (t: number) => number {
  const rng   = mulberry32(seed)
  const table = Float32Array.from({ length: LATTICE + 1 }, () => rng() * 2 - 1)
  table[LATTICE] = table[0]!
  return (t: number): number => {
    const ti = (t % LATTICE + LATTICE) % LATTICE
    const i  = ti | 0
    const f  = ti - i
    const c  = 0.5 - 0.5 * Math.cos(f * Math.PI)
    return table[i]! * (1 - c) + table[i + 1]! * c
  }
}

// ── Arc-length parameterised path sampler ─────────────────────

export interface PathSample {
  x:  number
  y:  number
  nx: number  // outward normal x (unit)
  ny: number  // outward normal y (unit)
  t:  number  // arc-length parameter ∈ [0, 1]
}

export function samplePath(
  pts:     ReadonlyArray<{ x: number; y: number }>,
  spacing: number,
  closed:  boolean,
): PathSample[] {
  if (pts.length < 2) return []
  const n    = pts.length
  const segs = closed ? n : n - 1
  const segLengths: number[] = []
  let total = 0
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!
    const d = Math.hypot(b.x - a.x, b.y - a.y)
    segLengths.push(d)
    total += d
  }
  if (total === 0) return []

  let segIdx = 0, segPos = 0
  const numSamples = Math.max(2, Math.ceil(total / spacing))
  const result: PathSample[] = []

  for (let si = 0; si < numSamples; si++) {
    const targetArc = (si / (numSamples - 1)) * total
    while (segIdx < segs - 1 && segPos + segLengths[segIdx]! <= targetArc) {
      segPos += segLengths[segIdx]!
      segIdx++
    }
    const segLen = segLengths[segIdx] ?? 1
    const alpha  = segLen > 0 ? (targetArc - segPos) / segLen : 0
    const a = pts[segIdx]!, b = pts[(segIdx + 1) % n]!
    const x = a.x + (b.x - a.x) * alpha
    const y = a.y + (b.y - a.y) * alpha
    const tx = b.x - a.x, ty = b.y - a.y
    const tl = Math.hypot(tx, ty) || 1
    result.push({ x, y, nx: -ty / tl, ny: tx / tl, t: targetArc / total })
  }
  return result
}

// ── Ribbon polygon builder ────────────────────────────────────

export function fillRibbon(
  ctx:     CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  samples: PathSample[],
  widthAt: (s: PathSample, i: number) => number,
): void {
  if (samples.length < 2) return
  const left:  { x: number; y: number }[] = []
  const right: { x: number; y: number }[] = []
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!, hw = widthAt(s, i) / 2
    left.push({ x: s.x + s.nx * hw, y: s.y + s.ny * hw })
    right.push({ x: s.x - s.nx * hw, y: s.y - s.ny * hw })
  }
  ctx.beginPath()
  ctx.moveTo(left[0]!.x, left[0]!.y)
  for (let i = 1; i < left.length; i++)  ctx.lineTo(left[i]!.x,  left[i]!.y)
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i]!.x, right[i]!.y)
  ctx.closePath()
  ctx.fill()
}

// ── smoothstep ───────────────────────────────────────────────

export function smoothstep(edge0: number, edge1: number, t: number): number {
  const x = Math.max(0, Math.min(1, (t - edge0) / (edge1 - edge0)))
  return x * x * (3 - 2 * x)
}

// ============================================================
// Case 0 — Torn paper edges
// ============================================================

export interface TornPaperParams {
  /** Tear depth as a multiple of strokeSize. Default 1.2. Range 0.1–4.0. */
  amplitude:     number
  /**
   * Noise frequency as a direct ratio to stroke width — larger = finer tears at any stroke size.
   * The value is used directly (not divided by strokeSize). Default 0.02. Range 0.005–0.50.
   */
  frequency:     number
  /** Edge softness in pixels (shadowBlur). 0 = hard edge. Default 0. Range 0.0–8.0. */
  feather:       number
  /**
   * Noise-driven transparency variation along the torn edge.
   * 0 = solid edge; 1 = deep irregular gaps, like thin paper fibres.
   * Default 0.35. Range 0.0–1.0.
   */
  edgeVariation: number
  /**
   * Blends a second noise octave at 4× frequency into the displacement, breaking up periodicity.
   * 0 = smooth/regular; 1 = rough/stochastic. Default 0.40. Range 0.0–1.0.
   */
  stochasticity: number
}

export const TORN_PAPER_DEFAULTS: TornPaperParams = {
  amplitude:     0.68,
  frequency:     0.100,
  feather:       0,
  edgeVariation: 0.12,
  stochasticity: 0.69,
}

export function fillTornPaper(
  ctx:        CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  pts:        ReadonlyArray<{ x: number; y: number }>,
  colour:     string,
  strokeSize: number,
  seed:       number,
  p:          TornPaperParams = TORN_PAPER_DEFAULTS,
  secondPass  = false,
): void {
  const noise     = makeNoise1D(seed)
  const noise2    = makeNoise1D(seed ^ 0xA1B2C3D4)  // higher-freq octave for stochasticity
  const amplitude = strokeSize * p.amplitude
  const freq      = p.frequency
  const spacing   = Math.max(2, strokeSize * 0.4)

  const samples = samplePath(pts, spacing, true)
  if (samples.length < 3) return

  const displaced = samples.map((s, i) => {
    const base = noise(i * freq * LATTICE)
    // Prime ratio (7×) gives long interference period; gate multiplicatively rather than
    // additively so stochasticity controls which zones tear, not just how deep they go.
    const gate = noise2(i * freq * LATTICE * 7)
    const mod  = 1 - p.stochasticity + p.stochasticity * Math.max(0, gate)
    const d    = base * mod * amplitude
    return { x: s.x + s.nx * d, y: s.y + s.ny * d }
  })

  ctx.beginPath()
  ctx.moveTo(displaced[0]!.x, displaced[0]!.y)
  for (let i = 1; i < displaced.length; i++) ctx.lineTo(displaced[i]!.x, displaced[i]!.y)
  ctx.closePath()

  ctx.save()
  ctx.fillStyle = colour
  if (p.feather > 0) {
    ctx.shadowColor = colour
    ctx.shadowBlur  = p.feather
  }
  ctx.fill()
  ctx.restore()

  // Punch irregular transparency into the torn edge using destination-out strokes.
  // Each segment of the displaced boundary is erased at a noise-driven alpha so
  // some edge sections are opaque and others semi-transparent, like torn paper fibres.
  if (p.edgeVariation > 0) {
    const noiseEdge = makeNoise1D(seed ^ 0x33445566)
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.lineWidth   = Math.max(1, amplitude * 0.45)
    ctx.lineCap     = 'round'
    ctx.lineJoin    = 'round'
    ctx.strokeStyle = '#000000'
    for (let i = 0; i < displaced.length - 1; i++) {
      const d = displaced[i]!, e = displaced[(i + 1) % displaced.length]!
      ctx.globalAlpha = (noiseEdge(i / displaced.length * LATTICE) * 0.5 + 0.5) * p.edgeVariation
      ctx.beginPath()
      ctx.moveTo(d.x, d.y)
      ctx.lineTo(e.x, e.y)
      ctx.stroke()
    }
    ctx.restore()
  }

  if (secondPass) {
    ctx.save()
    ctx.strokeStyle = 'rgba(0,0,0,0.22)'
    ctx.lineWidth   = 1.2
    ctx.beginPath()
    ctx.moveTo(displaced[0]!.x, displaced[0]!.y)
    for (let i = 1; i < displaced.length; i++) ctx.lineTo(displaced[i]!.x, displaced[i]!.y)
    ctx.closePath()
    ctx.stroke()
    ctx.restore()
  }
}

// ============================================================
// Case 1 — Thin pencil line
// ============================================================

export interface PencilParams {
  /** Minimum segment opacity — how faint the line gets. Default 0.15. Range 0.0–0.50. */
  minAlpha: number
  /** Maximum segment opacity — how dark the line gets. Default 0.65. Range 0.30–1.0. */
  maxAlpha: number
  /** Perpendicular wobble in pixels. Default 1.5. Range 0.0–6.0. */
  jitter:   number
}

export const PENCIL_DEFAULTS: PencilParams = {
  minAlpha: 0.05,
  maxAlpha: 0.42,
  jitter:   0.0,
}

export function drawPencilLine(
  ctx:        CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  pts:        ReadonlyArray<{ x: number; y: number }>,
  colour:     string,
  strokeSize: number,
  seed:       number,
  p:          PencilParams = PENCIL_DEFAULTS,
  secondPass  = false,
): void {
  if (pts.length < 2) return
  const noise    = makeNoise1D(seed)
  const noise2   = makeNoise1D(seed ^ 0x9E3779B9)
  const rngSpc   = mulberry32(seed ^ 0x4A3B2C1D)  // spacing variation — fixed seed for stable re-render
  const fine     = samplePath(pts, 3, false)       // 3 px fine samples; hop size gives variable spacing
  if (fine.length < 2) return

  ctx.save()
  ctx.lineCap   = 'round'
  ctx.lineJoin  = 'round'
  ctx.lineWidth = Math.max(0.5, strokeSize * 0.6)
  ctx.strokeStyle = colour

  const alphaRange = p.maxAlpha - p.minAlpha

  // Walk with variable hops: 3–7 fine samples ≈ 9–21 px per drawn segment
  let fi = 0
  while (fi < fine.length - 1) {
    const hop = 3 + Math.floor(rngSpc() * 5)
    const s   = fine[fi]!
    const fi2 = Math.min(fi + hop, fine.length - 1)
    const e   = fine[fi2]!
    ctx.globalAlpha = p.minAlpha + alphaRange * (noise(s.t * LATTICE) * 0.5 + 0.5)
    const jitter    = noise2(s.t * LATTICE) * p.jitter
    ctx.beginPath()
    ctx.moveTo(s.x + s.nx * jitter, s.y + s.ny * jitter)
    ctx.lineTo(e.x + e.nx * jitter, e.y + e.ny * jitter)
    ctx.stroke()
    fi = fi2
  }

  if (secondPass) {
    const rngSpc2 = mulberry32(seed ^ 0xF1E2D3C4)
    ctx.lineWidth = Math.max(0.3, strokeSize * 0.3)
    let fi2 = 0
    while (fi2 < fine.length - 1) {
      const hop = 3 + Math.floor(rngSpc2() * 5)
      const s   = fine[fi2]!
      const fi3 = Math.min(fi2 + hop, fine.length - 1)
      const e   = fine[fi3]!
      ctx.globalAlpha = 0.08 + 0.12 * (noise(s.t * LATTICE * 1.7) * 0.5 + 0.5)
      const jitter    = noise2(s.t * LATTICE * 2.1) * p.jitter * 2
      ctx.beginPath()
      ctx.moveTo(s.x + s.nx * jitter, s.y + s.ny * jitter)
      ctx.lineTo(e.x + e.nx * jitter, e.y + e.ny * jitter)
      ctx.stroke()
      fi2 = fi3
    }
  }

  ctx.restore()
}

// ============================================================
// Case 2 — Medium ink nib pen
// ============================================================

export interface NibPenParams {
  /** Angle (degrees) at which the nib is widest. Default 45. Range 0–180. */
  nibAngle:     number
  /**
   * Minimum width as a fraction of strokeSize (when stroke is parallel to nib).
   * Default 0.40. Range 0.0–0.90.
   */
  minWidthRatio: number
  /** Width variation from noise — higher = more uneven. Default 0.25. Range 0.0–0.60. */
  widthVariation: number
  /** Bleed frequency — 0 = none, 1 = heavy. Default 0.50. Range 0.0–2.0. */
  bleedDensity: number
  /** Splatter event frequency — 0 = none, 1 = moderate. Default 0.50. Range 0.0–2.0. */
  splatDensity: number
  /** Splatter dot radius as a multiple of the base size. Default 1.0. Range 0.1–3.0. */
  splatterSize: number
  /** Edge softness in pixels (shadowBlur). 0 = hard edge. Default 1.5. Range 0.0–8.0. */
  feather: number
  /**
   * How far bleed-line centres diverge from the stroke centreline, as a fraction of half-width.
   * 0 = all on centreline; 1 = reaches stroke edge; >1 = extends outside stroke. Default 1.0. Range 0.0–2.0.
   */
  bleedSpread: number
  /** Variation in fibre bleed line length (0 = all same, 1 = wide spread). Default 0.6. Range 0.0–1.0. */
  bleedLengthVar: number
  /** Variation in fibre bleed line width (0 = all same, 1 = wide spread). Default 0.5. Range 0.0–1.0. */
  bleedWidthVar: number
  /** Half-angle range for fibre bleed orientation in degrees (0 = perpendicular only). Default 30. Range 0–90. */
  bleedAngle: number
}

export const NIB_PEN_DEFAULTS: NibPenParams = {
  nibAngle:       107,
  minWidthRatio:  0.15,
  widthVariation: 0.26,
  bleedDensity:   1.91,
  splatDensity:   0.70,
  bleedSpread:    1.04,
  splatterSize:   0.93,
  feather:        1.4,
  bleedLengthVar: 0.21,
  bleedWidthVar:  1.62,
  bleedAngle:     51,
}

export function drawNibPen(
  ctx:        CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  pts:        ReadonlyArray<{ x: number; y: number }>,
  colour:     string,
  strokeSize: number,
  seed:       number,
  p:          NibPenParams = NIB_PEN_DEFAULTS,
  secondPass  = false,
): void {
  if (pts.length < 2) return
  const sz        = Math.max(0.5, strokeSize - 3)  // compensate for visual width added by nib variation
  const noise     = makeNoise1D(seed)
  const nibRad    = p.nibAngle * (Math.PI / 180)
  const samples   = samplePath(pts, 4, false)
  if (samples.length < 2) return

  const angles = samples.map((s, i) => {
    const next = samples[i + 1] ?? samples[i]!
    return Math.atan2(next.y - s.y, next.x - s.x)
  })

  ctx.save()
  ctx.fillStyle  = colour
  if (p.feather > 0) {
    ctx.shadowColor = colour
    ctx.shadowBlur  = p.feather
  }
  fillRibbon(ctx, samples, (s, i) => {
    const sinA = Math.sin(angles[i]! - nibRad)
    const nib  = p.minWidthRatio + (1 - p.minWidthRatio) * sinA * sinA
    const noisy = sz * nib * (1 + p.widthVariation * noise(i * 0.9 / samples.length * LATTICE))
    return Math.max(0.5, noisy)
  })
  ctx.restore()

  // ── Fibre bleeds: short lines centred at a random cross-stroke position ──
  // Centre point is distributed uniformly from one side of the stroke to the other.
  // Line extends len/2 in each direction from the centre.
  // Always rendered when bleedDensity > 0; not gated on secondPass.
  if (p.bleedDensity > 0) {
    const rngFibre   = mulberry32(seed ^ 0xC3D4E5F6)
    const halfStep   = Math.max(2, Math.ceil(1 / (p.bleedDensity * 0.12 + 0.02)))
    const angleRange = p.bleedAngle * (Math.PI / 180)
    const baseLen    = sz * 2.0   // must be > hw (sz*0.5) so centred lines extend past the stroke edge
    const baseWidth  = 0.7
    ctx.save()
    ctx.lineCap     = 'round'
    ctx.strokeStyle = colour
    for (let i = 0; i < samples.length; i += halfStep) {
      if (rngFibre() > 0.55) continue
      const s    = samples[i]!
      const tang = angles[i]!
      // Centre: uniform from -hw to +hw across the stroke
      const hw     = sz * 0.5
      const offset = (rngFibre() * 2 - 1) * hw * p.bleedSpread
      const cx     = s.x + s.nx * offset
      const cy     = s.y + s.ny * offset
      // Angle: perpendicular ± bleedAngle
      const perpAngle = tang + Math.PI / 2 + (rngFibre() * 2 - 1) * angleRange
      // Length and width with parameterised variation
      const len   = Math.max(1, baseLen   + (rngFibre() * 2 - 1) * p.bleedLengthVar * 30)
      const lw    = Math.max(0.2, baseWidth * (1 + (rngFibre() * 2 - 1) * p.bleedWidthVar))
      const half  = len / 2
      ctx.globalAlpha = 0.15 + rngFibre() * 0.35
      ctx.lineWidth   = lw
      ctx.beginPath()
      ctx.moveTo(cx - Math.cos(perpAngle) * half, cy - Math.sin(perpAngle) * half)
      ctx.lineTo(cx + Math.cos(perpAngle) * half, cy + Math.sin(perpAngle) * half)
      ctx.stroke()
    }
    ctx.restore()
  }

  // ── Far splatters: fans of dots scattered 1.5–5.5× strokeSize away ──
  // Controlled by splatDensity independently of fibre bleeds.
  if (p.splatDensity > 0) {
    const rngSplat     = mulberry32(seed ^ 0x7A2B3C4D)
    const numSplatters = Math.max(2, Math.round(samples.length * 0.045 * p.splatDensity))
    ctx.save()
    ctx.fillStyle = colour
    for (let k = 0; k < numSplatters; k++) {
      const si     = Math.floor(rngSplat() * samples.length)
      const anchor = samples[si]!
      const tang   = angles[si]!
      // One larger anchor drop per event, then 4–8 satellite dots
      const anchorR = Math.max(1.5, sz * (0.12 + rngSplat() * 0.18)) * p.splatterSize
      const anchorDir = tang + (rngSplat() - 0.5) * (Math.PI * 2 / 3)
      const anchorDist = sz * (1.2 + rngSplat() * 2.5)
      ctx.globalAlpha = 0.35 + rngSplat() * 0.35
      ctx.beginPath()
      ctx.arc(
        anchor.x + Math.cos(anchorDir) * anchorDist,
        anchor.y + Math.sin(anchorDir) * anchorDist,
        anchorR, 0, Math.PI * 2,
      )
      ctx.fill()
      // Satellite dots in a forward-biased fan (±60° around tangent)
      const numDots = 4 + Math.floor(rngSplat() * 5)
      for (let d = 0; d < numDots; d++) {
        const dir  = tang + (rngSplat() - 0.5) * (Math.PI * 2 / 3)
        const dist = sz * (1.5 + rngSplat() * 4)
        const dotR = Math.max(0.8, sz * (0.04 + rngSplat() * 0.12)) * p.splatterSize
        ctx.globalAlpha = 0.15 + rngSplat() * 0.45
        ctx.beginPath()
        ctx.arc(
          anchor.x + Math.cos(dir) * dist,
          anchor.y + Math.sin(dir) * dist,
          dotR, 0, Math.PI * 2,
        )
        ctx.fill()
      }
    }
    ctx.restore()
  }

  if (secondPass) {
    ctx.save()

    // ── Edge bleeds: small ellipses and gradient blots close to the stroke ──
    const rng    = mulberry32(seed ^ 0xDEADBEEF)
    const smallP = 0.08 * p.bleedDensity
    const largeP = smallP + 0.012 * p.bleedDensity
    for (let i = 1; i < samples.length - 1; i++) {
      const s = samples[i]!
      const r = rng()
      if (r < smallP) {
        const br = sz * (0.3 + rng() * 0.2)
        const bx = s.x + s.nx * (sz * 0.5 + rng() * 2 - 1)
        const by = s.y + s.ny * (sz * 0.5 + rng() * 2 - 1)
        ctx.globalAlpha = 0.45 + rng() * 0.2
        ctx.fillStyle   = colour
        ctx.beginPath()
        ctx.ellipse(bx, by, br * (0.8 + rng() * 0.4), br, angles[i]!, 0, Math.PI * 2)
        ctx.fill()
      } else if (r < largeP) {
        const br   = sz * (0.7 + rng() * 0.3)
        const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, br)
        grad.addColorStop(0, colour)
        grad.addColorStop(1, 'transparent')
        ctx.globalAlpha = 0.38
        ctx.fillStyle   = grad
        ctx.beginPath()
        ctx.arc(s.x, s.y, br, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    ctx.restore()
  }
}

// ============================================================
// Case 3 — Thick brush calligraphy
// ============================================================

export interface BrushParams {
  /** Angle (degrees) of the flat brush axis — strokes perpendicular to this are widest. Default 0. Range 0–180. */
  brushAngle: number
  /**
   * Minimum width as a fraction of strokeSize (when brush moves parallel to its axis).
   * Default 0.30. Range 0.0–0.80.
   */
  minWidthRatio: number
  /**
   * Fraction of stroke length over which each end tapers to a point.
   * Default 0.12. Range 0.0–0.35.
   */
  taperLength: number
  /** Amplitude of outer-edge noise in pixels. Default 1.5. Range 0.0–6.0. */
  edgeRoughness: number
  /** Edge softness in pixels (shadowBlur). 0 = hard edge. Default 2.5. Range 0.0–10.0. */
  feather: number
}

export const BRUSH_DEFAULTS: BrushParams = {
  brushAngle:    0,
  minWidthRatio: 0.30,
  taperLength:   0.12,
  edgeRoughness: 1.5,
  feather:       2.5,
}

export function drawCalligraphyBrush(
  ctx:        CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  pts:        ReadonlyArray<{ x: number; y: number }>,
  colour:     string,
  strokeSize: number,
  seed:       number,
  p:          BrushParams = BRUSH_DEFAULTS,
  secondPass  = false,
): void {
  if (pts.length < 2) return
  const sz         = Math.max(0.5, strokeSize - 6)  // compensate for visual width added by brush/taper
  const noiseEdge  = makeNoise1D(seed)
  const brushRad   = p.brushAngle * (Math.PI / 180)
  const taperEnd   = 1 - p.taperLength

  const samples = samplePath(pts, 3, false)
  if (samples.length < 2) return

  const angles = samples.map((s, i) => {
    const next = samples[i + 1] ?? samples[i]!
    return Math.atan2(next.y - s.y, next.x - s.x)
  })

  ctx.save()
  ctx.globalAlpha = 0.92
  ctx.fillStyle   = colour
  if (p.feather > 0) {
    ctx.shadowColor = colour
    ctx.shadowBlur  = p.feather
  }

  fillRibbon(ctx, samples, (s, i) => {
    const dir   = Math.abs(Math.sin(angles[i]! - brushRad))
    const dirW  = p.minWidthRatio + (1 - p.minWidthRatio) * dir
    const taper = smoothstep(0, p.taperLength, s.t) * smoothstep(1, taperEnd, s.t)
    const edgeN = noiseEdge(i * 1.1 / samples.length * LATTICE) * p.edgeRoughness
    return Math.max(0, sz * dirW * taper + edgeN)
  })

  if (secondPass) {
    ctx.globalAlpha = 0.25
    ctx.lineWidth   = 0.6
    ctx.lineCap     = 'round'
    const rng       = mulberry32(seed ^ 0xCAFEBABE)
    const endRegion = Math.floor(samples.length * 0.20)

    for (const [start, dir] of [[0, 1], [samples.length - 1, -1]] as [number, number][]) {
      for (let b = 0; b < 4; b++) {
        const spread = (rng() * 2 - 1) * sz * 0.6
        const length = sz * (0.5 + rng() * 0.5)
        ctx.globalAlpha = 0.15 + rng() * 0.18
        ctx.strokeStyle = colour
        const s0 = samples[start]!
        const s1 = samples[Math.max(0, Math.min(samples.length - 1, start + dir * endRegion))]!
        ctx.beginPath()
        ctx.moveTo(s0.x + s0.nx * spread, s0.y + s0.ny * spread)
        ctx.lineTo(
          s0.x + (s1.x - s0.x) * 0.6 + s0.nx * (spread + (rng() - 0.5) * length),
          s0.y + (s1.y - s0.y) * 0.6 + s0.ny * (spread + (rng() - 0.5) * length),
        )
        ctx.stroke()
      }
    }
  }

  ctx.restore()
}

// ============================================================
// Case 4 — Lichtenstein cartoon brush stroke
//
// Appearance: parallel bristle stripes (alternating paint colour and
// dark ink bands) with a hard black outline. The stripes all taper
// together at both ends. No halftone dots on the stroke — those live
// in the background in Lichtenstein's paintings.
// ============================================================

export interface LichtensteinParams {
  /** Number of coloured mark bands across the stroke (transparent gaps between them). Default 4. Range 1-10. */
  stripeCount:    number
  /**
   * Width of each coloured mark band relative to the transparent gap beside it.
   * 0.45 = marks are narrower than gaps; 1.0 = equal; 2.0 = marks are twice as wide. Default 0.45.
   */
  darkWidthRatio: number
  /** Fraction of stroke length over which individual marks taper to zero at the trailing end. Default 0.30. */
  taperLength:    number
  /**
   * Width in pixels of an additional stroke traced along the outermost mark edges.
   * Uses the same colour as the marks. 0 = none. Default 2.5.
   */
  outlineWidth:   number
  /**
   * Amplitude of the shared lateral wave that moves the whole bundle together.
   * 0 = rigid parallel lines; 0.5 = bundle shifts ±1 gap-width. Default 0.30.
   */
  weave:          number
  /** Frequency of the bundle wave in cycles per stroke length. Default 2.5. */
  weaveFreq:      number
}

export const LICHTENSTEIN_DEFAULTS: LichtensteinParams = {
  stripeCount:    6,
  darkWidthRatio: 0.89,
  taperLength:    0.05,
  outlineWidth:   0.0,
  weave:          0.39,
  weaveFreq:      0.5,
}

export function drawLichtensteinStroke(
  ctx:        CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  pts:        ReadonlyArray<{ x: number; y: number }>,
  colour:     string,
  strokeSize: number,
  seed:       number,
  p:          LichtensteinParams = LICHTENSTEIN_DEFAULTS,
  secondPass  = false,
): void {
  if (pts.length < 2) return

  const samples = samplePath(pts, 4, false)
  if (samples.length < 2) return

  const sc      = Math.max(1, Math.round(p.stripeCount))
  const lightW  = strokeSize / (sc + (sc + 1) * p.darkWidthRatio)
  const darkW   = lightW * p.darkWidthRatio
  const hw      = strokeSize / 2

  // Dark stripe half-width: full until taperStart, narrows to zero by t=1.
  const taperStart = Math.max(0.01, 1 - p.taperLength)
  const darkHW = (t: number): number => (darkW / 2) * smoothstep(1, taperStart, t)

  // Weaving: one shared noise moves the whole bundle laterally (primary motion);
  // small per-stripe noise adds individual drift that can cause occasional crossings.
  const globalNoise    = makeNoise1D(seed ^ 0xB0055EED)
  const perStripeNoise = Array.from({ length: sc + 1 }, (_, k) =>
    makeNoise1D((seed + k * 31337 + 1337) >>> 0)
  )
  const globalAmp = lightW * 2 * p.weave  // whole-bundle shift (≈ stripe spacing at weave=0.5)
  const indivAmp  = lightW * 0.35          // per-stripe drift (enough for occasional crossings)

  // Precompute the centre of each dark stripe at every sample point.
  // stPos[k][i] = normal-axis offset of dark stripe k at sample i.
  const stPos: Float64Array[] = Array.from({ length: sc + 1 }, (_, k) => {
    const nominal = -hw + darkW / 2 + k * (lightW + darkW)
    const sNoise  = perStripeNoise[k]!
    const arr     = new Float64Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      const t = samples[i]!.t
      arr[i]  = nominal
        + globalNoise(t * p.weaveFreq * LATTICE) * globalAmp
        + sNoise(t * p.weaveFreq * 1.7 * LATTICE) * indivAmp
    }
    return arr
  })

  // Outer boundary of the stroke: the edges of the outermost dark stripes.
  // This is what the user sees as the "edge" — no separate rigid outline shape.
  const outerL = new Float64Array(samples.length)
  const outerR = new Float64Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const h   = darkHW(samples[i]!.t)
    outerL[i] = stPos[0]![i]! - h
    outerR[i] = stPos[sc]![i]! + h
  }

  const traceOuter = (): void => {
    ctx.beginPath()
    ctx.moveTo(samples[0]!.x + samples[0]!.nx * outerL[0]!, samples[0]!.y + samples[0]!.ny * outerL[0]!)
    for (let i = 1; i < samples.length; i++) {
      const s = samples[i]!
      ctx.lineTo(s.x + s.nx * outerL[i]!, s.y + s.ny * outerL[i]!)
    }
    for (let i = samples.length - 1; i >= 0; i--) {
      const s = samples[i]!
      ctx.lineTo(s.x + s.nx * outerR[i]!, s.y + s.ny * outerR[i]!)
    }
    ctx.closePath()
  }

  // Fill one mark band in the stroke colour, tapering toward the trailing end.
  const drawDarkStrip = (k: number): void => {
    ctx.fillStyle = colour
    ctx.beginPath()
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!, c = stPos[k]![i]!, h = darkHW(s.t)
      if (i === 0) ctx.moveTo(s.x + s.nx * (c + h), s.y + s.ny * (c + h))
      else         ctx.lineTo(s.x + s.nx * (c + h), s.y + s.ny * (c + h))
    }
    for (let i = samples.length - 1; i >= 0; i--) {
      const s = samples[i]!, c = stPos[k]![i]!, h = darkHW(s.t)
      ctx.lineTo(s.x + s.nx * (c - h), s.y + s.ny * (c - h))
    }
    ctx.closePath()
    ctx.fill()
  }

  ctx.save()

  // secondPass: light wash of the stroke colour filling the whole boundary —
  // shows the overall stroke form without obscuring the transparent gaps.
  if (secondPass) {
    ctx.save()
    ctx.globalAlpha = 0.25
    ctx.fillStyle   = colour
    traceOuter()
    ctx.fill()
    ctx.restore()
  }

  // 1. Coloured mark bands — the stroke colour, weaving and tapering.
  //    Between them and beyond the outermost marks: transparent (background shows through).
  for (let k = 0; k <= sc; k++) drawDarkStrip(k)

  // 2. Optional outline stroked along the outermost mark edges, in the same colour.
  if (p.outlineWidth > 0) {
    ctx.strokeStyle = colour
    ctx.lineWidth   = p.outlineWidth
    ctx.lineCap     = 'round'
    ctx.lineJoin    = 'round'
    traceOuter()
    ctx.stroke()
  }

  ctx.restore()
}
