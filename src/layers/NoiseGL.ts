// NoiseGL — WebGL noise-texture generator singleton
//
// One hidden <canvas> + WebGL context, shared across all NoiseLayer
// instances (mirrors FilterGL's pattern: browsers cap WebGL contexts).
//
// Accelerates all four algorithms — 'cracks' (Worley F1−F0), 'warp'
// (domain-warped fBm), 'organic' (warp × Worley cell mask), and 'ripples'
// (multi-drop interference) — each a single fullscreen fragment-shader pass
// rendering directly to `canvas` at whatever resolution is requested.
// NoiseLayer copies the result into its OffscreenCanvas via drawImage(), the
// same hand-off FilterLayer uses for filterGL's result.
//
// 'ripples' derives its per-drop parameters (position, frequency, period,
// phase) purely from the drop index and seed via dropParams() — no array
// uniforms needed — so its drop layout is independent of (but visually
// equivalent in character to) the CPU path's _drops array.
//
// The GPU-side hash uses smaller-magnitude coefficients than the CPU hash
// in NoiseLayer.ts (`fract(sin(n) * 43758.5453123)` with n kept in the low
// thousands rather than the millions) — float32 `sin()` of large arguments
// loses angular precision and produces visible banding on some GPUs. This
// is a different pseudorandom field from the CPU path but the same
// algorithmic family, so each algorithm's character should be consistent
// with its CPU counterpart.

const VERT = /* glsl */`
attribute vec2 aPos;
varying   vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

// Shared helpers + uniforms, prepended to every algorithm's main().
const PRELUDE = /* glsl */`
precision highp float;

uniform float uSeed;
uniform float uT;
uniform float uFreq;
uniform float uDetail;
uniform float uDriftAngle;
uniform float uDriftMag;

varying vec2 vUv;

float hashf(float n) { return fract(sin(n) * 43758.5453123); }

float hash2(vec2 c, float seed) {
  return hashf(c.x * 12.9898 + c.y * 78.233 + seed * 37.719);
}

// Value noise — bilinear interpolation of per-cell hashes, smoothed.
float valueNoise(vec2 p, float seed) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash2(i, seed);
  float b = hash2(i + vec2(1.0, 0.0), seed);
  float c = hash2(i + vec2(0.0, 1.0), seed);
  float d = hash2(i + vec2(1.0, 1.0), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm2(vec2 p, float seed) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 2; i++) { v += a * valueNoise(p, seed); a *= 0.5; p *= 2.0; }
  return v;
}

float fbm4(vec2 p, float seed) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * valueNoise(p, seed); a *= 0.5; p *= 2.0; }
  return v;
}

// Animated Worley feature point for cell c — orbits the cell origin,
// with the orbit squashed/elongated according to driftAngle/driftMag.
vec2 cellPoint(vec2 c, float seed, float t, float driftAngle, float driftMag) {
  float baseX = hash2(c, seed);
  float baseY = hash2(c, seed + 17.3);
  float phase = hash2(c, seed + 91.7) * 6.283185307;
  float spd   = 0.4 + hash2(c, seed + 53.9) * 0.5;

  float ox = cos(t * spd + phase) * 0.32;
  float oy = sin(t * spd + phase) * 0.32;

  float cs = cos(-driftAngle), sn = sin(-driftAngle);
  float rx = ox * cs - oy * sn;
  float ry = ox * sn + oy * cs;
  ry *= (1.0 - driftMag * 0.8);

  float cs2 = cos(driftAngle), sn2 = sin(driftAngle);
  ox = rx * cs2 - ry * sn2;
  oy = rx * sn2 + ry * cs2;

  return c + vec2(baseX, baseY) + vec2(ox, oy);
}

// Nearest (f0) and second-nearest (f1) feature-point distances.
vec2 worley(vec2 p, float seed, float t, float driftAngle, float driftMag) {
  vec2 ip = floor(p);
  float f0 = 1.0e9;
  float f1 = 1.0e9;
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      vec2 cell = ip + vec2(float(ox), float(oy));
      vec2 fp = cellPoint(cell, seed, t, driftAngle, driftMag);
      float d = distance(p, fp);
      if (d < f0) { f1 = f0; f0 = d; }
      else if (d < f1) { f1 = d; }
    }
  }
  return vec2(f0, f1);
}

// Domain-warped fBm: a slowly-evolving warp field offsets the sampling
// coordinates, producing organic, non-directional drift.
float warpValue(vec2 p, float t, float seed, float driftAngle, float driftMag, float detail) {
  vec2 wp1 = vec2(p.x * 0.6 + t * 0.5, p.y * 0.6 - t * 0.3);
  vec2 wp2 = vec2(p.x * 0.6 - t * 0.3, p.y * 0.6 + t * 0.5);
  float wx = fbm2(wp1, seed + 11.0);
  float wy = fbm2(wp2, seed + 53.0);

  float qx = wx - 0.5;
  float qy = wy - 0.5;
  float cs = cos(driftAngle), sn = sin(driftAngle);
  float rqx = qx * cs - qy * sn;
  float rqy = qx * sn + qy * cs;

  float strength = detail * 4.0 * (0.4 + 0.6 * driftMag);
  return fbm4(p + vec2(rqx, rqy) * strength, seed);
}

// warp, modulated by a Worley cell mask.
float organicValue(vec2 p, float t, float seed, float driftAngle, float driftMag, float detail) {
  float w  = warpValue(p, t, seed, driftAngle, driftMag, detail);
  vec2  fw = worley(p, seed, t, driftAngle, driftMag);
  float cell = min(1.0, fw.x * 1.4);
  return w * (0.25 + 0.75 * cell);
}

// Per-drop parameters for 'ripples' — derived purely from the drop index i
// and seed, so no array uniforms are needed.
struct Drop {
  float cx;
  float cy;
  float spd;
  float freq;
  float period;
  float phase0;
};

Drop dropParams(float i, float seed) {
  Drop d;
  d.cx     = hash2(vec2(i, 0.0), seed);
  d.cy     = hash2(vec2(i, 1.0), seed);
  d.spd    = 0.5  + hash2(vec2(i, 2.0), seed) * 1.0;
  d.freq   = 16.0 + hash2(vec2(i, 3.0), seed) * 18.0;
  d.period = 2.5  + hash2(vec2(i, 4.0), seed) * 4.0;
  d.phase0 = hash2(vec2(i, 5.0), seed) * 10.0;
  return d;
}

// Interference of up to MAX_DROPS independent expanding rings (raindrops),
// each with its own period/phase so new ripples appear continuously.
float ripplesValue(vec2 p, float t, float seed, float driftAngle, float driftMag, float detail) {
  float n  = max(3.0, floor(detail * 12.0 + 0.5));
  float cs = cos(-driftAngle), sn = sin(-driftAngle);
  float sum = 0.0;
  for (int i = 0; i < 12; i++) {
    if (float(i) >= n) continue;
    Drop d = dropParams(float(i), seed);
    // Drop centres are normalised to [0,1); scale by uFreq so drops cover
    // the full sampled domain [0, uFreq) instead of clustering in one corner.
    float dx = p.x - d.cx * uFreq;
    float dy = p.y - d.cy * uFreq;
    float rx = dx * cs - dy * sn;
    float ry = dx * sn + dy * cs;
    ry *= (1.0 + driftMag * 1.5);
    float dist = length(vec2(rx, ry));

    float phase  = t * 4.0 + d.phase0;
    float localT = fract(phase / d.period);
    float ringR  = localT * 0.9;
    float diff   = (dist - ringR) * 9.0;
    float env    = exp(-(diff * diff)) * (1.0 - localT);
    sum += sin(dist * d.freq - phase * d.spd * 6.0) * env;
  }
  // Each drop's contribution is a localised ring (env is mostly 0), so at
  // most a couple of drops are "active" at any given pixel — dividing by n
  // would crush a single ring's full ±1 swing down to ±1/n, leaving the
  // whole field near-uniform grey. Sum directly; the caller clamps to [0,1],
  // so overlapping rings just clip rather than overflow.
  return sum * 0.5 + 0.5;
}
`

const MAIN: Record<string, string> = {
  cracks: /* glsl */`
void main() {
  vec2 p = vUv * uFreq;
  vec2 fw = worley(p, uSeed, uT, uDriftAngle, uDriftMag);
  float width = 0.02 + (1.0 - uDetail) * 0.3;
  float val = 1.0 - smoothstep(0.0, width, fw.y - fw.x);
  gl_FragColor = vec4(vec3(val), 1.0);
}`,

  warp: /* glsl */`
void main() {
  vec2 p = vUv * uFreq;
  float v = warpValue(p, uT, uSeed, uDriftAngle, uDriftMag, uDetail);
  gl_FragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
}`,

  organic: /* glsl */`
void main() {
  vec2 p = vUv * uFreq;
  float v = organicValue(p, uT, uSeed, uDriftAngle, uDriftMag, uDetail);
  gl_FragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
}`,

  ripples: /* glsl */`
void main() {
  vec2 p = vUv * uFreq;
  float v = ripplesValue(p, uT, uSeed, uDriftAngle, uDriftMag, uDetail);
  gl_FragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
}`,
}

export type GLNoiseId = 'cracks' | 'warp' | 'organic' | 'ripples'

export interface NoiseParams {
  seed:       number
  t:          number
  freq:       number
  detail:     number
  driftAngle: number
  driftMag:   number
}

class NoiseGL {
  readonly supported: boolean

  private _canvas: HTMLCanvasElement
  private _gl:     WebGLRenderingContext | null = null

  private _vbo:   WebGLBuffer | null = null
  private _progs = new Map<GLNoiseId, WebGLProgram | null>()

  private _w = 0
  private _h = 0

  constructor() {
    this._canvas = document.createElement('canvas')
    this._canvas.style.cssText =
      'position:fixed;top:-9999px;left:-9999px;pointer-events:none;opacity:0'
    document.body.appendChild(this._canvas)

    const gl = this._canvas.getContext('webgl', { preserveDrawingBuffer: true })
    this.supported = gl !== null
    if (gl) { this._gl = gl; this._setup(gl) }
  }

  private _setup(gl: WebGLRenderingContext): void {
    this._vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo)
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW)
  }

  private _prog(gl: WebGLRenderingContext, type: GLNoiseId): WebGLProgram | null {
    if (this._progs.has(type)) return this._progs.get(type)!
    const main = MAIN[type]
    if (!main) { this._progs.set(type, null); return null }
    const p = this._link(gl, VERT, PRELUDE + main)
    this._progs.set(type, p)
    return p
  }

  private _link(gl: WebGLRenderingContext, vsrc: string, fsrc: string): WebGLProgram | null {
    const vs = this._shader(gl, gl.VERTEX_SHADER, vsrc)
    const fs = this._shader(gl, gl.FRAGMENT_SHADER, fsrc)
    if (!vs || !fs) return null
    const p = gl.createProgram()!
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('NoiseGL link error:', gl.getProgramInfoLog(p))
      return null
    }
    return p
  }

  private _shader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src); gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('NoiseGL shader error:', gl.getShaderInfoLog(s))
      return null
    }
    return s
  }

  get canvas(): HTMLCanvasElement { return this._canvas }

  /** Render the given noise field at `size`×`size` into `canvas`. */
  render(type: GLNoiseId, size: number, params: NoiseParams): boolean {
    const gl = this._gl
    if (!gl || !this._vbo) return false
    const prog = this._prog(gl, type)
    if (!prog) return false

    if (this._w !== size || this._h !== size) {
      this._canvas.width  = size
      this._canvas.height = size
      this._w = size
      this._h = size
    }

    gl.viewport(0, 0, size, size)
    gl.useProgram(prog)

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo)
    const aPos = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    gl.uniform1f(gl.getUniformLocation(prog, 'uSeed'),       params.seed)
    gl.uniform1f(gl.getUniformLocation(prog, 'uT'),          params.t)
    gl.uniform1f(gl.getUniformLocation(prog, 'uFreq'),       params.freq)
    gl.uniform1f(gl.getUniformLocation(prog, 'uDetail'),     params.detail)
    gl.uniform1f(gl.getUniformLocation(prog, 'uDriftAngle'), params.driftAngle)
    gl.uniform1f(gl.getUniformLocation(prog, 'uDriftMag'),   params.driftMag)

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    return true
  }
}

export const noiseGL = new NoiseGL()
