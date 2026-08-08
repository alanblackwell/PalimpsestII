// WarpGL — WebGL inverse-distance-weighted image warp
//
// One hidden <canvas> + WebGL context shared across all WarpLayer instances,
// same weight/lifetime as FilterGL's shared pipeline. Unlike FilterGL this
// only needs a single shader pass (no ping-pong FBOs) — the IDW sum and the
// inverse-mapped sample both happen per-fragment in one draw call, and GL's
// native LINEAR filtering + CLAMP_TO_EDGE wrapping do the bilinear resample
// and edge-clamp that the CPU path (WarpLayer._applyWarp) does by hand.
//
// Usage:
//   if (warpGL.supported) {
//     warpGL.apply(source, pairs, w, h, minDistSq)
//     ctx.drawImage(warpGL.canvas, 0, 0)   // result
//   }
//
// Source texture is uploaded with UNPACK_FLIP_Y_WEBGL = true, same
// convention as FilterGL, so vUv * uRes lines up with ordinary canvas pixel
// space (y = 0 at top) — the same assumption FilterGL's mosaic/pixelise/edges
// shaders already make of vUv * uRes.

import type { Point } from '../core/types.js'

export interface WarpPair { init: Point; curr: Point }

// Hard cap on control pairs passed to the shader. Pairs are plain uniforms
// (not a data texture), so the count has to fit comfortably inside the
// uniform-vector budget. 64 vec4 (256 floats) is well within what every
// WebGL1-capable GPU supports in practice, and covers WarpLayer's worst
// case today (5 handles + 16 shape samples + 32 boundary anchors = 53) with
// headroom. Pairs beyond the cap are silently dropped by apply().
export const WARP_MAX_PAIRS = 64

const VERT = /* glsl */`
attribute vec2 aPos;
varying   vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAG = /* glsl */`
precision mediump float;
uniform sampler2D uTex;
uniform vec2  uRes;
uniform int   uCount;
uniform vec4  uPairs[${WARP_MAX_PAIRS}];
uniform float uMinDistSq;
varying vec2  vUv;
void main() {
  vec2 px = vUv * uRes;
  float sumW = 0.0;
  vec2  sumD = vec2(0.0);
  for (int i = 0; i < ${WARP_MAX_PAIRS}; i++) {
    if (i >= uCount) break;
    vec4 p = uPairs[i];
    vec2 e = px - p.xy;
    float w = 1.0 / max(uMinDistSq, dot(e, e));
    sumW += w;
    sumD += w * p.zw;
  }
  vec2 suv = (px - sumD / sumW) / uRes;
  gl_FragColor = texture2D(uTex, suv);
}`

class WarpGL {
  readonly supported: boolean

  private _canvas: HTMLCanvasElement
  private _gl:     WebGLRenderingContext | null = null

  // Transfer canvas: draws OffscreenCanvas/ImageBitmap sources onto an
  // HTMLCanvasElement before texSubImage2D, matching FilterGL's workaround
  // for WebGL1 texImage2D not accepting OffscreenCanvas on all Safari versions.
  private _xfer:    HTMLCanvasElement
  private _xferCtx: CanvasRenderingContext2D

  private _srcTex: WebGLTexture | null = null
  private _vbo:    WebGLBuffer  | null = null
  private _prog:   WebGLProgram | null = null

  private _w = 0
  private _h = 0

  private _pairBuf = new Float32Array(WARP_MAX_PAIRS * 4)

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

  private _setup(gl: WebGLRenderingContext): void {
    this._vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo)
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    this._srcTex = tex

    const vs = this._shader(gl, gl.VERTEX_SHADER,   VERT)
    const fs = this._shader(gl, gl.FRAGMENT_SHADER, FRAG)
    if (!vs || !fs) return
    const p = gl.createProgram()!
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('WarpGL link error:', gl.getProgramInfoLog(p))
      return
    }
    this._prog = p
  }

  private _shader(
    gl: WebGLRenderingContext, type: number, src: string,
  ): WebGLShader | null {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src); gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('WarpGL shader error:', gl.getShaderInfoLog(s))
      return null
    }
    return s
  }

  private _resize(gl: WebGLRenderingContext, w: number, h: number): void {
    if (this._w === w && this._h === h) return
    this._w = w; this._h = h
    this._canvas.width  = w
    this._canvas.height = h
    gl.bindTexture(gl.TEXTURE_2D, this._srcTex!)
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  }

  get canvas(): HTMLCanvasElement { return this._canvas }

  // Renders the warped result to `this.canvas`. `pairs` beyond
  // WARP_MAX_PAIRS are dropped — WarpLayer's own worst-case pair count
  // (53) stays under the cap today, so this is a defensive bound, not a
  // routine truncation.
  apply(
    source: CanvasImageSource,
    pairs: WarpPair[],
    w: number, h: number,
    minDistSq: number,
  ): void {
    const gl = this._gl
    if (!gl || !this._prog || !this._srcTex) return

    this._resize(gl, w, h)

    if (this._xfer.width !== w || this._xfer.height !== h) {
      this._xfer.width = w; this._xfer.height = h
    }
    this._xferCtx.clearRect(0, 0, w, h)
    this._xferCtx.drawImage(source, 0, 0, w, h)

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
    gl.bindTexture(gl.TEXTURE_2D, this._srcTex)
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this._xfer)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)

    const n = Math.min(pairs.length, WARP_MAX_PAIRS)
    for (let i = 0; i < n; i++) {
      const { init, curr } = pairs[i]!
      const o = i * 4
      this._pairBuf[o]     = init.x
      this._pairBuf[o + 1] = init.y
      this._pairBuf[o + 2] = curr.x - init.x
      this._pairBuf[o + 3] = curr.y - init.y
    }

    gl.useProgram(this._prog)
    gl.viewport(0, 0, w, h)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo)
    const aPos = gl.getAttribLocation(this._prog, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this._srcTex)
    gl.uniform1i(gl.getUniformLocation(this._prog, 'uTex'), 0)
    gl.uniform2f(gl.getUniformLocation(this._prog, 'uRes'), w, h)
    gl.uniform1i(gl.getUniformLocation(this._prog, 'uCount'), n)
    gl.uniform1f(gl.getUniformLocation(this._prog, 'uMinDistSq'), minDistSq)
    gl.uniform4fv(gl.getUniformLocation(this._prog, 'uPairs'), this._pairBuf)

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
}

export const warpGL = new WarpGL()
