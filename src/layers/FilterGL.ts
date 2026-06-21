// FilterGL — WebGL filter pipeline singleton
//
// One hidden <canvas> + WebGL context shared across all FilterLayer instances.
// Source image is uploaded once per apply() call; each enabled filter runs as
// a GLSL fragment shader, ping-ponging between two FBO textures.  A third
// texture (texC) saves the pre-shadow input for the composite pass.
//
// Usage:
//   if (filterGL.supported) {
//     const thumbs = filterGL.apply(source, steps, w, h)
//     ctx.drawImage(filterGL.canvas, 0, 0)   // final result
//   }
//
// Source textures are uploaded with UNPACK_FLIP_Y_WEBGL = true so that all
// textures (source and FBO) share the same GL orientation and can be sampled
// with a simple non-flipping vertex shader.

export interface GLFilterStep {
  label:     string
  intensity: number
}

// ── Vertex shader (shared by all programs) ─────────────────────────────────

const VERT = /* glsl */`
attribute vec2 aPos;
varying   vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

// ── Fragment shaders ────────────────────────────────────────────────────────

const FRAG: Record<string, string> = {

  _pt: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uTex, vUv); }`,

  brightness: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv);
  gl_FragColor = vec4(clamp(c.rgb * (uT * 2.0), 0.0, 1.0), c.a);
}`,

  contrast: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv);
  gl_FragColor = vec4(clamp((uT * 2.0) * (c.rgb - 0.5) + 0.5, 0.0, 1.0), c.a);
}`,

  saturate: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv);
  float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(clamp(mix(vec3(lum), c.rgb, uT * 3.0), 0.0, 1.0), c.a);
}`,

  // CSS hue-rotate matrix — identical coefficients to the CPU path.
  'hue-rotate': /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv);
  float th = uT * 6.28318, co = cos(th), si = sin(th);
  // mat3 is column-major in GLSL
  mat3 m = mat3(
    0.213+co*0.787-si*0.213,  0.213-co*0.213+si*0.143,  0.213-co*0.213-si*0.787,
    0.715-co*0.715-si*0.715,  0.715+co*0.285+si*0.140,  0.715-co*0.715+si*0.715,
    0.072-co*0.072+si*0.928,  0.072-co*0.072-si*0.283,  0.072+co*0.928+si*0.072
  );
  gl_FragColor = vec4(clamp(m * c.rgb, 0.0, 1.0), c.a);
}`,

  grayscale: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv);
  float v = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(mix(c.rgb, vec3(v), uT), c.a);
}`,

  invert: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv);
  gl_FragColor = vec4(mix(c.rgb, 1.0 - c.rgb, uT), c.a);
}`,

  sepia: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv);
  vec3 s = vec3(dot(c.rgb, vec3(0.393,0.769,0.189)),
                dot(c.rgb, vec3(0.349,0.686,0.168)),
                dot(c.rgb, vec3(0.272,0.534,0.131)));
  gl_FragColor = vec4(mix(c.rgb, clamp(s, 0.0, 1.0), uT), c.a);
}`,

  threshold: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv);
  float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(c.rgb, lum < uT ? 0.0 : c.a);
}`,

  solarise: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv);
  gl_FragColor = vec4(mix(c.rgb, 1.0 - c.rgb, step(uT, c.rgb)), c.a);
}`,

  pixelise: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
uniform vec2 uRes;
varying vec2 vUv;
void main() {
  float sz = max(2.0, floor(uT * 64.0 + 0.5));
  vec2 bUv = (floor(vUv * uRes / sz) * sz + sz * 0.5) / uRes;
  gl_FragColor = texture2D(uTex, clamp(bUv, 0.0, 1.0));
}`,

  // Voronoi crystallise — deterministic sin-hash, same as the CPU path.
  mosaic: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
uniform vec2 uRes;
varying vec2 vUv;
float mh(float a, float b) {
  return fract(sin(a * 127.1 + b * 311.7) * 43758.5453);
}
void main() {
  float cs = max(4.0, uT * 80.0 + 4.0);
  vec2 px   = vUv * uRes;
  vec2 cell = floor(px / cs);
  float bd  = 1.0e9;
  vec2  buv = vUv;
  for (int dr = -1; dr <= 1; dr++) {
    for (int dc = -1; dc <= 1; dc++) {
      vec2 nc   = cell + vec2(float(dc), float(dr));
      vec2 seed = (nc + 0.5 + (vec2(mh(nc.x*2.0,nc.y*2.0),
                                     mh(nc.x*2.0+1.0,nc.y*2.0+1.0)) - 0.5) * 0.8) * cs;
      float d = distance(px, seed);
      if (d < bd) { bd = d; buv = seed / uRes; }
    }
  }
  gl_FragColor = texture2D(uTex, clamp(buv, 0.0, 1.0));
}`,

  // Gradient map: neon chrome 4-stop palette, blended by uT.
  'gradient-map': /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv);
  float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 s0 = vec3(0.031, 0.016, 0.078);   // near-black purple
  vec3 s1 = vec3(0.118, 0.314, 0.784);   // electric blue
  vec3 s2 = vec3(0.000, 0.863, 0.941);   // bright cyan
  vec3 s3 = vec3(0.706, 0.941, 1.000);   // ice-blue rolloff
  vec3 mapped = lum < 0.33
    ? mix(s0, s1, lum / 0.33)
    : lum < 0.66
      ? mix(s1, s2, (lum - 0.33) / 0.33)
      : mix(s2, s3, (lum - 0.66) / 0.34);
  gl_FragColor = vec4(mix(c.rgb, mapped, uT), c.a);
}`,

  // False colour: thermal palette blue→green→red, blended by uT.
  'false-colour': /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
varying vec2 vUv;
vec3 hue2rgb(float h) {
  float hi = mod(floor(h / 60.0), 6.0);
  float f  = fract(h / 60.0);
  if (hi < 1.0) return vec3(1.0, f, 0.0);
  if (hi < 2.0) return vec3(1.0 - f, 1.0, 0.0);
  if (hi < 3.0) return vec3(0.0, 1.0, f);
  if (hi < 4.0) return vec3(0.0, 1.0 - f, 1.0);
  return vec3(f, 0.0, 1.0);
}
void main() {
  vec4 c = texture2D(uTex, vUv);
  float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(mix(c.rgb, hue2rgb((1.0 - lum) * 240.0), uT), c.a);
}`,

  // Sobel edge detection — direction-invariant magnitude, source alpha preserved.
  edges: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
uniform vec2 uRes;
varying vec2 vUv;
float lum(vec2 uv) {
  return dot(texture2D(uTex, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
}
void main() {
  vec2 d = 1.0 / uRes;
  float gx = -lum(vUv+vec2(-d.x,-d.y)) - 2.0*lum(vUv+vec2(-d.x,0.0)) - lum(vUv+vec2(-d.x, d.y))
            +  lum(vUv+vec2( d.x,-d.y)) + 2.0*lum(vUv+vec2( d.x,0.0)) + lum(vUv+vec2( d.x, d.y));
  float gy = -lum(vUv+vec2(-d.x,-d.y)) - 2.0*lum(vUv+vec2(0.0,-d.y)) - lum(vUv+vec2( d.x,-d.y))
            +  lum(vUv+vec2(-d.x, d.y)) + 2.0*lum(vUv+vec2(0.0, d.y)) + lum(vUv+vec2( d.x, d.y));
  float mag = clamp(sqrt(gx*gx + gy*gy) * uT * 2.0, 0.0, 1.0);
  gl_FragColor = vec4(vec3(mag), texture2D(uTex, vUv).a);
}`,

  // Separable box-blur — 3 passes of H+V approximate a Gaussian.
  // GLSL ES 1.0 requires constant loop bounds; we run all 41 taps and
  // skip those outside the runtime radius r.
  blur_h: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
uniform vec2 uRes;
varying vec2 vUv;
void main() {
  float r = floor(uT * 20.0 + 0.5);
  float dx = 1.0 / uRes.x;
  vec4 sum = vec4(0.0);
  float n = 0.0;
  for (int i = -20; i <= 20; i++) {
    if (float(i) < -r || float(i) > r) continue;
    sum += texture2D(uTex, vUv + vec2(float(i) * dx, 0.0));
    n += 1.0;
  }
  gl_FragColor = n > 0.0 ? sum / n : texture2D(uTex, vUv);
}`,

  blur_v: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
uniform vec2 uRes;
varying vec2 vUv;
void main() {
  float r = floor(uT * 20.0 + 0.5);
  float dy = 1.0 / uRes.y;
  vec4 sum = vec4(0.0);
  float n = 0.0;
  for (int i = -20; i <= 20; i++) {
    if (float(i) < -r || float(i) > r) continue;
    sum += texture2D(uTex, vUv + vec2(0.0, float(i) * dy));
    n += 1.0;
  }
  gl_FragColor = n > 0.0 ? sum / n : texture2D(uTex, vUv);
}`,

  // Drop-shadow pass 1: offset the UV and extract alpha into a black layer.
  // With UNPACK_FLIP_Y=true: x−offset/y+offset in UV maps to down-right
  // in canvas-2D space, matching the CPU implementation.
  shadow_setup: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform float uT;
uniform vec2 uRes;
varying vec2 vUv;
void main() {
  float off = floor(uT * 24.0 + 0.5);
  vec2 uv = vec2(vUv.x - off / uRes.x, vUv.y + off / uRes.y);
  float a  = texture2D(uTex, uv).a;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`,

  // Drop-shadow pass 2: composite blurred shadow behind the original.
  // uTex = saved original, uShadow = blurred shadow texture.
  shadow_comp: /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform sampler2D uShadow;
varying vec2 vUv;
void main() {
  vec4  orig  = texture2D(uTex, vUv);
  float shdA  = texture2D(uShadow, vUv).a * 0.75;
  float outA  = orig.a + shdA * (1.0 - orig.a);
  vec3  rgb   = outA < 0.001 ? vec3(0.0) : orig.rgb * (orig.a / outA);
  gl_FragColor = vec4(rgb, outA);
}`,
}

// ── FilterGL class ──────────────────────────────────────────────────────────

class FilterGL {
  readonly supported: boolean

  private _canvas: HTMLCanvasElement
  private _gl:     WebGLRenderingContext | null = null

  // Transfer canvas: used to draw OffscreenCanvas → HTMLCanvasElement before
  // uploading to WebGL (WebGL 1 texImage2D does not accept OffscreenCanvas on
  // all Safari versions).
  private _xfer:    HTMLCanvasElement
  private _xferCtx: CanvasRenderingContext2D

  // Ping-pong textures A (0) and B (1), plus C (2) for shadow save.
  private _texs: [WebGLTexture, WebGLTexture, WebGLTexture] | null = null
  private _fbos: [WebGLFramebuffer, WebGLFramebuffer, WebGLFramebuffer] | null = null
  // Separate texture for the source upload (never used as an FBO target).
  private _srcTex: WebGLTexture | null = null

  private _vbo:  WebGLBuffer | null = null
  private _cur   = 0   // index of the texture that holds the current result
  private _w     = 0
  private _h     = 0

  private _progs = new Map<string, WebGLProgram | null>()

  constructor() {
    this._canvas = document.createElement('canvas')
    this._canvas.style.cssText =
      'position:fixed;top:-9999px;left:-9999px;pointer-events:none;opacity:0'
    document.body.appendChild(this._canvas)

    this._xfer    = document.createElement('canvas')
    this._xferCtx = this._xfer.getContext('2d')!

    const gl = this._canvas.getContext('webgl', { preserveDrawingBuffer: true })
    this.supported = gl !== null
    if (gl) { this._gl = gl; this._setup(gl) }
  }

  // ── Initialisation ────────────────────────────────────────────

  private _setup(gl: WebGLRenderingContext): void {
    // Fullscreen triangle-strip quad: (−1,−1) (1,−1) (−1,1) (1,1)
    this._vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo)
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW)

    const mkTex = (): WebGLTexture => {
      const t = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      return t
    }

    const [tA, tB, tC] = [mkTex(), mkTex(), mkTex()]
    this._srcTex = mkTex()
    this._texs   = [tA, tB, tC]

    const mkFbo = (tex: WebGLTexture): WebGLFramebuffer => {
      const fbo = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      return fbo
    }
    this._fbos = [mkFbo(tA), mkFbo(tB), mkFbo(tC)]
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  private _resize(gl: WebGLRenderingContext, w: number, h: number): void {
    if (this._w === w && this._h === h) return
    this._w = w; this._h = h
    this._canvas.width  = w
    this._canvas.height = h
    for (const t of [...this._texs!, this._srcTex!]) {
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    }
  }

  // ── Shader compilation ────────────────────────────────────────

  private _prog(gl: WebGLRenderingContext, key: string): WebGLProgram | null {
    if (this._progs.has(key)) return this._progs.get(key)!
    const fsrc = FRAG[key]
    if (!fsrc) { this._progs.set(key, null); return null }
    const vs = this._shader(gl, gl.VERTEX_SHADER,   VERT)
    const fs = this._shader(gl, gl.FRAGMENT_SHADER, fsrc)
    if (!vs || !fs) { this._progs.set(key, null); return null }
    const p = gl.createProgram()!
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('FilterGL link error [' + key + ']:', gl.getProgramInfoLog(p))
      this._progs.set(key, null); return null
    }
    this._progs.set(key, p)
    return p
  }

  private _shader(
    gl: WebGLRenderingContext, type: number, src: string,
  ): WebGLShader | null {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src); gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('FilterGL shader error:', gl.getShaderInfoLog(s))
      return null
    }
    return s
  }

  // ── Render pass ───────────────────────────────────────────────

  // Run shader `key`, reading from tex0 (TEXTURE0) and optionally tex1
  // (TEXTURE1, bound to uniform `uShadow`), writing to toFbo (null = canvas).
  private _run(
    gl:    WebGLRenderingContext,
    key:   string,
    tex0:  WebGLTexture,
    toFbo: WebGLFramebuffer | null,
    t:     number,
    tex1?: WebGLTexture,
  ): boolean {
    const prog = this._prog(gl, key)
    if (!prog) return false

    gl.useProgram(prog)
    gl.bindFramebuffer(gl.FRAMEBUFFER, toFbo)
    gl.viewport(0, 0, this._w, this._h)

    // Bind quad VBO
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo)
    const aPos = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    // Primary texture
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex0)
    const uTex = gl.getUniformLocation(prog, 'uTex')
    if (uTex !== null) gl.uniform1i(uTex, 0)

    // Uniforms
    const uT   = gl.getUniformLocation(prog, 'uT')
    const uRes = gl.getUniformLocation(prog, 'uRes')
    if (uT   !== null) gl.uniform1f(uT,  t)
    if (uRes !== null) gl.uniform2f(uRes, this._w, this._h)

    // Optional second texture (shadow composite)
    if (tex1 !== undefined) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, tex1)
      const uShd = gl.getUniformLocation(prog, 'uShadow')
      if (uShd !== null) gl.uniform1i(uShd, 1)
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    return true
  }

  // ── Ping-pong helpers ─────────────────────────────────────────

  private get _curTex(): WebGLTexture    { return this._texs![this._cur]! }
  private get _curFbo(): WebGLFramebuffer { return this._fbos![this._cur]! }
  private get _altTex(): WebGLTexture    { return this._texs![this._cur ^ 1]! }
  private get _altFbo(): WebGLFramebuffer { return this._fbos![this._cur ^ 1]! }
  private _swap(): void { this._cur ^= 1 }

  // Blit current result to the GL canvas (default framebuffer).
  private _blit(gl: WebGLRenderingContext): void {
    this._run(gl, '_pt', this._curTex, null, 0)
  }

  // ── Public API ────────────────────────────────────────────────

  get canvas(): HTMLCanvasElement { return this._canvas }

  // Apply `steps` (the enabled filter rows) to `source`.
  // Returns a Map from step-index → thumbnail OffscreenCanvas (54 × PREV_H px).
  apply(
    source: CanvasImageSource,
    steps:  GLFilterStep[],
    w: number, h: number,
    prevH: number,
  ): Map<number, OffscreenCanvas> {
    const thumbs = new Map<number, OffscreenCanvas>()
    const gl = this._gl
    if (!gl || !this._texs || !this._fbos) return thumbs

    this._resize(gl, w, h)

    // Draw source onto transfer canvas so texSubImage2D receives an
    // HTMLCanvasElement (WebGL 1 on older Safari won't accept OffscreenCanvas).
    if (this._xfer.width !== w || this._xfer.height !== h) {
      this._xfer.width = w; this._xfer.height = h
    }
    this._xferCtx.clearRect(0, 0, w, h)
    this._xferCtx.drawImage(source as CanvasImageSource, 0, 0, w, h)

    // Upload source — FLIP_Y so GL texture is "upright" (t=0 = bottom of image).
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
    gl.bindTexture(gl.TEXTURE_2D, this._srcTex!)
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this._xfer)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)

    // Seed ping-pong with source.
    this._cur = 0
    this._run(gl, '_pt', this._srcTex!, this._curFbo, 0)

    for (let si = 0; si < steps.length; si++) {
      const { label, intensity: t } = steps[si]!

      if (label === 'blur') {
        // 3-pass separable box blur: H → V, repeated three times.
        for (let p = 0; p < 3; p++) {
          this._run(gl, 'blur_h', this._curTex, this._altFbo, t); this._swap()
          this._run(gl, 'blur_v', this._curTex, this._altFbo, t); this._swap()
        }

      } else if (label === 'shadow') {
        // Save pre-shadow input to texC (index 2).
        this._run(gl, '_pt', this._curTex, this._fbos![2]!, 0)

        // Extract offset alpha into a black layer.
        this._run(gl, 'shadow_setup', this._curTex, this._altFbo, t); this._swap()

        // Blur the shadow alpha (radius = t*16, passed as t*0.8 → t*0.8*20=t*16).
        const bt = t * 0.8
        for (let p = 0; p < 3; p++) {
          this._run(gl, 'blur_h', this._curTex, this._altFbo, bt); this._swap()
          this._run(gl, 'blur_v', this._curTex, this._altFbo, bt); this._swap()
        }

        // Composite: original (texC) + blurred shadow (curTex) → altFbo.
        const shadowTex = this._curTex
        this._run(
          gl, 'shadow_comp',
          this._texs![2]!, this._altFbo, 0,
          shadowTex,
        )
        this._swap()

      } else {
        // Single-pass filters.
        this._run(gl, label, this._curTex, this._altFbo, t)
        this._swap()
      }

      // Capture thumbnail by blitting current result to the GL canvas, then
      // drawImage-ing it to a small OffscreenCanvas.
      this._blit(gl)
      const thumb = new OffscreenCanvas(54, prevH)
      const tc = thumb.getContext('2d') as OffscreenCanvasRenderingContext2D
      tc.drawImage(this._canvas, 0, 0, 54, prevH)
      thumbs.set(si, thumb)
    }

    // Leave the final result on the GL canvas.
    this._blit(gl)
    return thumbs
  }
}

export const filterGL = new FilterGL()
