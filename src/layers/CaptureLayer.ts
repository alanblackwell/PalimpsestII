import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type MaskSource,
  type EventValue, type EventSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ── Constants ─────────────────────────────────────────────────

const ACCENT  = '#7ecf7e'   // Image type colour
const STRIPE  = 4
const BTN     = 22
const BTN_GAP = 4
const BTN_M   = 6

// Edit-capture photo sequence timing (ms). On shutter click, the shutter
// pulses for PULSE_MS while this layer is still selected, then the layer
// below becomes selected (revealing its controls) for SETTLE_MS before the
// photo is taken and this layer is reselected.
const PULSE_MS  = 700
const SETTLE_MS = 500
const PULSE_PERIOD = 800

// Preview window — below and left-aligned with the control pills.
const PREVIEW_GAP = 8
const PREVIEW_H   = 160

// Mask bounding-box detection downsamples to this size (longest side) before
// scanning for alpha — cheap enough to run every frame.
const BBOX_SAMPLE = 128

type BBox = { x: number; y: number; width: number; height: number }

// ── CaptureLayer ──────────────────────────────────────────────
//
// Captures the rendered composite of every layer below it in the stack
// (optionally masked) as a still image or a recorded movie.
//
// - shutterSlot (Event): each rising edge fires the shutter, exactly as a
//   manual click would. Clicking the shutter/record button while the slot
//   is Bound suspends it (permanent override — the button becomes a plain
//   manual control from then on).
// - maskSlot (Mask): when bound, only pixels within the mask are captured.
// - Photo mode: shutter click snapshots the composite into _capturedImage.
// - Movie mode: shutter/record button starts/stops a MediaRecorder fed by
//   a hidden <canvas> mirroring the live composite each frame.
// - getImage() exposes _capturedImage (photo mode) or the live composite
//   (movie mode) for downstream binding.

export class CaptureLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  readonly maskSlot:    ParameterSlot
  readonly shutterSlot: ParameterSlot

  private _lastEventTime: EventValue = null

  private _movieMode = false
  private _status    = 'ready'

  // When true, captures/recordings include the edit-mode UI (panels, slot
  // rows, depth haze/shadow for the selected layer) and the mouse cursor —
  // useful for demonstrating interaction with controls. When false (the
  // default), only the plain rendered composite is captured.
  private _editCapture = false

  // When true, captures/recordings also include the LayerStackWidget,
  // regardless of its on-screen visibility — for both photo and movie modes.
  private _stackCapture = false

  // Live masked composite of layers below — updated continuously while
  // _movieMode is true (so a recording in progress has frames to draw).
  private _result: OffscreenCanvas | null = null

  // Photo-mode snapshot.
  private _capturedImage: OffscreenCanvas | null = null

  // Movie-mode recording state.
  private _recording      = false
  private _liveCanvas:    HTMLCanvasElement | null = null
  private _mediaRecorder:  MediaRecorder | null = null
  private _recordedChunks: Blob[] = []
  private _recordedBlob:   Blob | null = null
  private _recordedMime    = ''
  private _recordingFrameId: number | null = null

  // Mask bounding box used to crop the current/active recording — computed
  // once at the start of a recording so every frame is the same size.
  private _captureBounds: BBox | null = null

  // Hidden <video> element used to play back _recordedBlob in the preview.
  private _previewVideo:   HTMLVideoElement | null = null
  private _previewPlaying  = false
  private _scrubDragging   = false

  // Current frame of the playing preview, exposed via getImage() while
  // _previewPlaying is true — same idea as MediaLayer's playback frame.
  private _previewFrame: OffscreenCanvas | null = null

  // Button bounds — set during renderPanel, used for hit-testing.
  private _editBtnB:    BBox | null = null
  private _stackBtnB:   BBox | null = null
  private _modeBtnB:    BBox | null = null
  private _shutterBtnB: BBox | null = null
  private _saveBtnB:    BBox | null = null
  private _playBtnB:    BBox | null = null
  private _scrubB:      BBox | null = null

  // True while the pulse-and-navigate sequence (edit-capture photo mode) is
  // in progress — drawn as a pulsing ring around the shutter button.
  private _pendingCapture = false
  private _pulseStart     = 0

  constructor() {
    super()
    this.debugName = 'Capture'

    this.maskSlot = new ParameterSlot(ValueType.Mask, this, 'mask')
    this.slots.push(this.maskSlot)

    this.shutterSlot = new ParameterSlot(ValueType.Event, this, 'shutter')
    this.slots.push(this.shutterSlot)

    graph.register(this)
  }

  // ── ImageSource ───────────────────────────────────────────────

  getImage(): ImageValue {
    if (this._movieMode) {
      // While the captured movie is playing back in the preview, expose its
      // current frame — same idea as MediaLayer's live playback frame.
      if (this._previewPlaying && this._previewFrame !== null) return this._previewFrame
      return this._result
    }
    return this._capturedImage
  }

  // ── Persistence ───────────────────────────────────────────────
  // Config only — never the captured image/movie data.

  override serializeState(): Record<string, unknown> {
    return {
      movieMode:     this._movieMode,
      editCapture:   this._editCapture,
      stackCapture:  this._stackCapture,
      lastEventTime: this._lastEventTime,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.movieMode === 'boolean')   this._movieMode   = state.movieMode
    if (typeof state.editCapture === 'boolean') this._editCapture = state.editCapture
    if (typeof state.stackCapture === 'boolean') this._stackCapture = state.stackCapture
    if (typeof state.lastEventTime === 'number' || state.lastEventTime === null) {
      this._lastEventTime = state.lastEventTime as EventValue
    }
    this._status = this._movieMode ? 'movie mode' : 'ready'
  }

  // ── Node — recompute ───────────────────────────────────────────

  protected recompute(): void {
    // Shutter slot — each rising edge fires the shutter, same as a click.
    if (this.shutterSlot.isActive) {
      const t = (this.shutterSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastEventTime) {
        this._lastEventTime = t
        this._fireShutter()
      }
    }

    // While actively recording, frames are driven by an independent
    // requestAnimationFrame loop (see _recordingFrame) so capture keeps
    // running even if the user selects a different layer mid-recording —
    // the normal dataflow evaluate() loop only visits layers between the
    // root and the selected layer, which may exclude this one.
    if (this._movieMode && !this._recording) {
      this._result = this._cropToBounds(this._captureComposite(), this._effectiveBounds())

      // Keep recomputing every frame while in movie mode (and not yet
      // recording), so the live preview composite stays current.
      if (!this.outsideStack || this.inBackground) {
        queueMicrotask(() => {
          if (this._movieMode && !this._recording && (!this.outsideStack || this.inBackground)) {
            this.forceDirty()
          }
        })
      }
    }

    // While the captured movie is playing back in the preview, keep
    // capturing its current frame so getImage() reflects live playback.
    if (this._previewPlaying) {
      this._capturePreviewFrame()
      if (!this.outsideStack || this.inBackground) {
        queueMicrotask(() => {
          if (this._previewPlaying && (!this.outsideStack || this.inBackground)) {
            this.forceDirty()
          }
        })
      }
    }
  }

  // Draw the preview <video>'s current frame into _previewFrame.
  private _capturePreviewFrame(): void {
    const video = this._previewVideo
    if (video === null || video.readyState < HTMLVideoElement.HAVE_CURRENT_DATA) return
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw === 0 || vh === 0) return
    if (this._previewFrame === null || this._previewFrame.width !== vw || this._previewFrame.height !== vh) {
      this._previewFrame = new OffscreenCanvas(vw, vh)
    }
    const ctx = this._previewFrame.getContext('2d')!
    ctx.drawImage(video, 0, 0, vw, vh)
  }

  // Render everything below this layer onto a fresh canvas, masked if
  // maskSlot is bound.
  private _captureComposite(): OffscreenCanvas {
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')!

    if (this._editCapture) {
      this._renderEditComposite(ctx)
    } else {
      this.layerBelow?.renderStack(ctx)
      this._applyMask(ctx, w, h)
    }

    // Stack-widget overlay — drawn after masking, like the edit-mode panel
    // overlay, so it's unaffected by the mask's shape.
    if (this._stackCapture) Node.renderStackWidget?.(ctx)

    return canvas
  }

  // Clip the current canvas contents to maskSlot's mask, if bound.
  private _applyMask(ctx: Ctx2D, w: number, h: number): void {
    if (!this.maskSlot.isActive) return
    const mask = (this.maskSlot.source as MaskSource).getMask()
    if (mask === null) return
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(mask as CanvasImageSource, 0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
  }

  // Bounding box (in full-canvas coordinates) of maskSlot's mask's opaque
  // pixels, or null if no mask is bound or it's empty. Scans a downsampled
  // copy of the mask so this is cheap enough to call every frame.
  private _maskBounds(): BBox | null {
    if (!this.maskSlot.isActive) return null
    const mask = (this.maskSlot.source as MaskSource).getMask()
    if (mask === null) return null

    const w = Node.canvasWidth
    const h = Node.canvasHeight
    const scale = BBOX_SAMPLE / Math.max(w, h)
    const sw = Math.max(1, Math.round(w * scale))
    const sh = Math.max(1, Math.round(h * scale))

    const sample = new OffscreenCanvas(sw, sh)
    const sctx = sample.getContext('2d')!
    sctx.drawImage(mask as CanvasImageSource, 0, 0, sw, sh)
    const { data } = sctx.getImageData(0, 0, sw, sh)

    let minX = sw, minY = sh, maxX = -1, maxY = -1
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (data[(y * sw + x) * 4 + 3]! > 0) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < minX || maxY < minY) return null

    // Scale back up to full-canvas coordinates, padding by one sample pixel
    // on each side to absorb downsampling error.
    const sx = w / sw
    const sy = h / sh
    const x0 = Math.max(0, Math.floor((minX - 1) * sx))
    const y0 = Math.max(0, Math.floor((minY - 1) * sy))
    const x1 = Math.min(w, Math.ceil((maxX + 2) * sx))
    const y1 = Math.min(h, Math.ceil((maxY + 2) * sy))
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  }

  // Crop `src` to `bbox` (in src's coordinate space), or return it unchanged
  // if bbox is null.
  private _cropToBounds(src: OffscreenCanvas, bbox: BBox | null): OffscreenCanvas {
    if (bbox === null) return src
    const out = new OffscreenCanvas(Math.max(1, bbox.width), Math.max(1, bbox.height))
    const ctx = out.getContext('2d')!
    ctx.drawImage(src as CanvasImageSource, -bbox.x, -bbox.y)
    return out
  }

  // Edit-mode composite: same depth-shadow/haze treatment as the
  // Evaluator's edit-mode loop, plus the selected layer's panel/slot rows
  // and the mouse cursor — so interaction with controls is visible in the
  // capture.
  private _renderEditComposite(ctx: Ctx2D): void {
    const w = Node.canvasWidth
    const h = Node.canvasHeight

    const layers: Layer[] = []
    for (let l: Layer | null = this.layerBelow; l !== null; l = l.layerBelow) layers.unshift(l)

    const current = Node.currentLayer
    const currentIdx = layers.findIndex(l => l === current)

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]!
      layer.evaluate()
      if (layer.isHiddenHelper) continue

      ctx.save()
      if (i === currentIdx) {
        ctx.shadowColor   = 'rgba(0,0,0,0.60)'
        ctx.shadowBlur    = 18
        ctx.shadowOffsetY = 6
      }
      layer.renderSelf(ctx)
      ctx.restore()

      if (currentIdx >= 0 && i < currentIdx) {
        ctx.save()
        ctx.fillStyle = 'rgba(255,255,255,0.25)'
        ctx.fillRect(0, 0, w, h)
        ctx.restore()
      }
    }

    // Mask only the scene rendered above — not the overlay controls/cursor
    // below, which should remain visible regardless of the mask's shape.
    this._applyMask(ctx, w, h)

    // Render the selected layer's panel/slot controls, whatever layer that
    // is — e.g. this CaptureLayer itself (its record/save panel is only
    // reachable while selected) or any other layer the user selects
    // mid-recording to demonstrate its controls.
    if (current instanceof Layer) {
      current.renderPanel(ctx)
      current.renderSlots(ctx)
    }

    this._drawCursor(ctx)
  }

  // Simple arrow-pointer cursor at Node.pointerCanvas, so interaction with
  // controls is visible in edit captures.
  private _drawCursor(ctx: Ctx2D): void {
    const p = Node.pointerCanvas
    if (p === null) return

    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(0, 16)
    ctx.lineTo(4, 12.5)
    ctx.lineTo(6.5, 18.5)
    ctx.lineTo(9, 17.5)
    ctx.lineTo(6.5, 11.5)
    ctx.lineTo(11.5, 11.5)
    ctx.closePath()
    ctx.fillStyle   = '#ffffff'
    ctx.strokeStyle = 'rgba(0,0,0,0.65)'
    ctx.lineWidth   = 1.5
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  private _drawToLiveCanvas(src: OffscreenCanvas): void {
    if (this._liveCanvas === null) return
    if (this._liveCanvas.width !== src.width || this._liveCanvas.height !== src.height) {
      this._liveCanvas.width  = src.width
      this._liveCanvas.height = src.height
    }
    const ctx = this._liveCanvas.getContext('2d')
    if (ctx === null) return
    ctx.clearRect(0, 0, this._liveCanvas.width, this._liveCanvas.height)
    ctx.drawImage(src as CanvasImageSource, 0, 0)
  }

  // ── Shutter ───────────────────────────────────────────────────

  private _fireShutter(): void {
    if (this._movieMode) {
      if (this._recording) this._stopRecording()
      else this._startRecording()
    } else if (this._editCapture) {
      this._capturePhotoWithEditPrompt()
    } else {
      this._capturePhoto()
    }
  }

  // Edit-capture photo mode: this layer must be selected for its shutter
  // button to be clickable, but the layer below's controls only render
  // while THAT layer is selected. Pulse the shutter to prompt the user,
  // then briefly select the layer below (revealing its controls in both the
  // live view and the capture), take the photo, and restore the selection.
  private _capturePhotoWithEditPrompt(): void {
    if (this._pendingCapture) return
    const target = this.layerBelow
    if (target === null) {
      this._capturePhoto()
      return
    }

    this._pendingCapture = true
    this._pulseStart = performance.now()
    this._status = 'hold still…'
    this.markDirty()

    setTimeout(() => {
      Node.selectLayer?.(target)
      setTimeout(() => {
        this._capturePhoto()
        this._pendingCapture = false
        Node.selectLayer?.(this)
      }, SETTLE_MS)
    }, PULSE_MS)
  }

  // Permanent-override pattern: a manual click suspends a Bound shutter
  // slot (handing control to the button) and always fires regardless.
  private _handleShutterClick(): void {
    if (this.shutterSlot.state === SlotState.Bound) this.shutterSlot.suspend()
    this._fireShutter()
  }

  private _capturePhoto(): void {
    this._capturedImage = this._cropToBounds(this._captureComposite(), this._effectiveBounds())
    this._status = 'captured'
    this.markDirty()
  }

  // ── Movie mode ────────────────────────────────────────────────

  private _toggleEditCapture(): void {
    this._editCapture = !this._editCapture
    this.markDirty()
  }

  private _toggleStackCapture(): void {
    this._stackCapture = !this._stackCapture
    this.markDirty()
  }

  private _toggleMovieMode(): void {
    if (this._recording) this._stopRecording()
    this._movieMode = !this._movieMode
    if (this._movieMode) {
      this._status = 'movie mode'
    } else {
      this._result = null
      this._status = this._capturedImage !== null ? 'captured' : 'ready'
    }
    this.markDirty()
  }

  private _pickMimeType(): string | null {
    if (typeof MediaRecorder === 'undefined') return null
    const candidates = [
      'video/mp4;codecs=h264',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm',
    ]
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c
    }
    return null
  }

  private _startRecording(): void {
    const mimeType = this._pickMimeType()
    if (mimeType === null) {
      this._status = 'recording not supported'
      this.markDirty()
      return
    }

    if (this._liveCanvas === null) {
      this._liveCanvas = document.createElement('canvas')
      this._liveCanvas.style.cssText =
        'position:fixed;top:-9999px;left:-9999px;pointer-events:none;opacity:0'
      document.body.appendChild(this._liveCanvas)
    }

    // Fix the crop for the duration of this recording so every frame is the
    // same size.
    this._captureBounds = this._effectiveBounds()

    this._result = this._cropToBounds(this._captureComposite(), this._captureBounds)
    this._drawToLiveCanvas(this._result)

    this._recordedMime   = mimeType
    this._recordedChunks = []
    this._recordedBlob   = null

    const stream   = this._liveCanvas.captureStream(30)
    const recorder = new MediaRecorder(stream, { mimeType })
    recorder.ondataavailable = e => {
      if (e.data.size > 0) this._recordedChunks.push(e.data)
    }
    recorder.onstop = () => {
      this._recordedBlob = new Blob(this._recordedChunks, { type: this._recordedMime })
      this._setupPreviewVideo(this._recordedBlob)
      this._status = 'movie captured'
      this.markDirty()
    }
    recorder.start()

    this._mediaRecorder = recorder
    this._recording = true
    this._status = 'recording…'
    this.markDirty()
    this._recordingFrameId = requestAnimationFrame(() => this._recordingFrame())
  }

  private _stopRecording(): void {
    this._mediaRecorder?.stop()
    this._mediaRecorder = null
    this._recording = false
    if (this._recordingFrameId !== null) {
      cancelAnimationFrame(this._recordingFrameId)
      this._recordingFrameId = null
    }
  }

  // Drives movie-frame capture independently of the dataflow evaluate()
  // loop, which only visits layers between the root and the currently
  // selected layer — that range may exclude this layer once the user
  // selects something else to demonstrate its controls mid-recording.
  // Node.currentLayer and Node.pointerCanvas are static fields kept
  // current regardless, so the captured composite still reflects whatever
  // is selected and where the pointer is.
  private _recordingFrame(): void {
    if (!this._recording) return
    this._result = this._cropToBounds(this._captureComposite(), this._captureBounds)
    this._drawToLiveCanvas(this._result)
    this.markDirty()
    this._recordingFrameId = requestAnimationFrame(() => this._recordingFrame())
  }

  // ── Capture bounds ────────────────────────────────────────────

  // Default crop: the visible viewport, not the grow-only content canvas.
  // Mask bounds override this when maskSlot is active.
  private _viewportBounds(): BBox {
    return { x: 0, y: 0, width: Node.viewportWidth, height: Node.viewportHeight }
  }

  private _effectiveBounds(): BBox {
    return this._maskBounds() ?? this._viewportBounds()
  }

  // ── Save ──────────────────────────────────────────────────────

  private _makeFilename(ext: string): string {
    const d   = new Date()
    const pad = (n: number, len = 2) => String(n).padStart(len, '0')
    const ts  = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
                `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    return `Palimpsest_${ts}.${ext}`
  }

  private _save(): void {
    if (this._movieMode) {
      if (this._recordedBlob === null) return
      const ext = this._recordedMime.includes('mp4') ? 'mp4' : 'webm'
      void this._shareOrDownload(this._recordedBlob, this._makeFilename(ext))
    } else {
      if (this._capturedImage === null) return
      void this._capturedImage.convertToBlob({ type: 'image/png' })
        .then(blob => this._shareOrDownload(blob, this._makeFilename('png')))
    }
  }

  // Try the Web Share API first (routes to OS share sheet / photo gallery on
  // Android and iOS). Fall back to <a download> when unavailable or refused.
  private async _shareOrDownload(blob: Blob, filename: string): Promise<void> {
    if (typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
      const file = new File([blob], filename, { type: blob.type })
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: filename })
          return
        } catch {
          // User cancelled or share failed — fall through to download.
        }
      }
    }
    this._downloadBlob(blob, filename)
  }

  private _downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // ── Preview ───────────────────────────────────────────────────

  private _setupPreviewVideo(blob: Blob): void {
    if (this._previewVideo === null) {
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.addEventListener('ended', () => {
        this._previewPlaying = false
        this.markDirty()
      })
      this._previewVideo = video
    } else {
      URL.revokeObjectURL(this._previewVideo.src)
    }
    this._previewVideo.src = URL.createObjectURL(blob)
    this._previewPlaying = false
  }

  private _togglePreviewPlayback(): void {
    const video = this._previewVideo
    if (video === null) return
    if (this._previewPlaying) {
      video.pause()
      this._previewPlaying = false
    } else {
      if (video.ended || video.currentTime >= video.duration) video.currentTime = 0
      void video.play()
      this._previewPlaying = true
    }
    this.markDirty()
  }

  private _seekPreview(point: Point): void {
    const video = this._previewVideo
    const b = this._scrubB
    if (video === null || b === null || !(video.duration > 0)) return
    const frac = Math.min(1, Math.max(0, (point.x - b.x) / b.width))
    video.currentTime = frac * video.duration
    this.markDirty()
  }

  // ── Rendering ─────────────────────────────────────────────────
  // Pass-through: layers below have already been drawn onto ctx by
  // renderStack before renderSelf is called, so this layer draws nothing.

  // Push slot rows down to make room for the preview pill below the
  // control pills.
  override get panelBottom(): number {
    return 50 + this.bounds.height + PREVIEW_GAP + PREVIEW_H + PREVIEW_GAP
  }

  renderPanel(ctx: Ctx2D): void {
    const h = this.bounds.height
    const { x: PANEL_X, width: PANEL_W } = this.canvasBounds
    this._drawStripPill(ctx, this.bounds)
    this._drawCapturePill(ctx, { x: PANEL_X, y: 50, width: PANEL_W, height: h })
    this._drawPreviewPill(ctx, { x: PANEL_X, y: 50 + h + PREVIEW_GAP, width: PANEL_W, height: PREVIEW_H })
  }

  private _drawStripPill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, STRIPE, height, [4, 0, 0, 4])
    ctx.fill()

    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Capture', x + 12, y + height / 2)
    ctx.restore()
  }

  private _drawCapturePill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, STRIPE, height, [4, 0, 0, 4])
    ctx.fill()

    const saveB:    BBox = { x: x + width - BTN_M - BTN, y: y + (height - BTN) / 2, width: BTN, height: BTN }
    const shutterB: BBox = { x: saveB.x - BTN_GAP - BTN, y: saveB.y, width: BTN, height: BTN }
    const modeB:    BBox = { x: shutterB.x - BTN_GAP - BTN, y: saveB.y, width: BTN, height: BTN }
    const editB:    BBox = { x: modeB.x - BTN_GAP - BTN, y: saveB.y, width: BTN, height: BTN }
    const stackB:   BBox = { x: editB.x - BTN_GAP - BTN, y: saveB.y, width: BTN, height: BTN }
    this._saveBtnB    = saveB
    this._shutterBtnB = shutterB
    this._modeBtnB    = modeB
    this._editBtnB    = editB
    this._stackBtnB   = stackB

    // Status text, clipped between the stripe and the stack-capture button.
    const textL = x + STRIPE + 8
    const textW = stackB.x - textL - 6
    if (textW > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(textL, y, textW, height)
      ctx.clip()
      ctx.fillStyle    = 'rgba(255,255,255,0.75)'
      ctx.font         = '11px monospace'
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(this._status, textL, y + height / 2)
      ctx.restore()
    }

    // Edit/display capture toggle — cursor dragging a handle.
    this._drawEditIcon(ctx, editB, this._editCapture)

    // Stack-widget capture toggle — small stack of overlapping rectangles.
    this._drawStackIcon(ctx, stackB, this._stackCapture)

    // Mode toggle — photo / movie.
    this._drawBtn(ctx, modeB, this._movieMode ? '🎥' : '📷', ACCENT)

    // Shutter / record button.
    if (this._movieMode) {
      this._drawRecordIcon(ctx, shutterB, this._recording)
    } else {
      this._drawShutterIcon(ctx, shutterB)
    }

    // Pulsing ring prompting the user to look at the layer below.
    if (this._pendingCapture) {
      const t  = ((performance.now() - this._pulseStart) % PULSE_PERIOD) / PULSE_PERIOD
      const cx = shutterB.x + shutterB.width / 2
      const cy = shutterB.y + shutterB.height / 2
      const r  = shutterB.width / 2 + t * 14
      ctx.save()
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.85})`
      ctx.lineWidth   = 2
      ctx.stroke()
      ctx.restore()
    }

    // Save — dimmed until there's something to save.
    const hasResult = this._movieMode ? this._recordedBlob !== null : this._capturedImage !== null
    this._drawBtn(ctx, saveB, '💾', hasResult ? ACCENT : 'rgba(255,255,255,0.20)')

    ctx.restore()
  }

  // Framed preview of the captured image/movie, below and left-aligned with
  // the control pills. Movies get play/pause + a scrub slider.
  private _drawPreviewPill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, STRIPE, height, [4, 0, 0, 4])
    ctx.fill()

    const PAD = 6
    const showControls = this._movieMode && this._recordedBlob !== null
    const controlsH = 24
    const imgArea: BBox = {
      x: x + STRIPE + PAD,
      y: y + PAD,
      width: width - STRIPE - PAD * 2,
      height: height - PAD * 2 - (showControls ? controlsH + PAD : 0),
    }

    const src = this._movieMode
      ? (this._previewVideo !== null && this._recordedBlob !== null ? this._previewVideo : null)
      : this._capturedImage

    let sw = 0, sh = 0
    if (src instanceof HTMLVideoElement) {
      sw = src.videoWidth
      sh = src.videoHeight
    } else if (src !== null) {
      sw = src.width
      sh = src.height
    }

    if (src !== null && sw > 0 && sh > 0 && imgArea.width > 0 && imgArea.height > 0) {
      const scale = Math.min(imgArea.width / sw, imgArea.height / sh)
      const dw = sw * scale
      const dh = sh * scale
      const dx = imgArea.x + (imgArea.width - dw) / 2
      const dy = imgArea.y + (imgArea.height - dh) / 2
      ctx.drawImage(src, dx, dy, dw, dh)
    } else if (imgArea.width > 0 && imgArea.height > 0) {
      ctx.fillStyle    = 'rgba(255,255,255,0.35)'
      ctx.font         = '11px monospace'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('no capture', x + width / 2, imgArea.y + imgArea.height / 2)
    }

    if (showControls) {
      this._drawPreviewControls(ctx, {
        x: x + STRIPE + PAD,
        y: y + height - controlsH - PAD,
        width: width - STRIPE - PAD * 2,
        height: controlsH,
      })
    } else {
      this._playBtnB = null
      this._scrubB   = null
    }

    ctx.restore()
  }

  // Play/pause button + scrub slider for reviewing a captured movie.
  private _drawPreviewControls(ctx: Ctx2D, b: BBox): void {
    const playB: BBox = { x: b.x, y: b.y, width: b.height, height: b.height }
    this._playBtnB = playB
    this._drawBtn(ctx, playB, this._previewPlaying ? '⏸' : '▶', ACCENT)

    const scrubB: BBox = { x: playB.x + playB.width + 6, y: b.y, width: b.width - playB.width - 6, height: b.height }
    this._scrubB = scrubB

    const video = this._previewVideo
    const frac = (video !== null && video.duration > 0) ? video.currentTime / video.duration : 0

    const trackY = scrubB.y + scrubB.height / 2 - 2
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    ctx.fillRect(scrubB.x, trackY, scrubB.width, 4)

    ctx.fillStyle = ACCENT
    ctx.fillRect(scrubB.x, trackY, scrubB.width * frac, 4)

    ctx.beginPath()
    ctx.arc(scrubB.x + scrubB.width * frac, trackY + 2, 5, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
  }

  private _drawBtnBg(ctx: Ctx2D, b: BBox): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
  }

  // Cursor-arrow dragging a small handle — edit/display capture toggle.
  private _drawEditIcon(ctx: Ctx2D, b: BBox, active: boolean): void {
    this._drawBtnBg(ctx, b)
    const colour = active ? ACCENT : 'rgba(255,255,255,0.55)'

    ctx.save()
    ctx.translate(b.x + b.width * 0.30, b.y + b.height * 0.22)
    ctx.scale(0.5, 0.5)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(0, 16)
    ctx.lineTo(4, 12.5)
    ctx.lineTo(6.5, 18.5)
    ctx.lineTo(9, 17.5)
    ctx.lineTo(6.5, 11.5)
    ctx.lineTo(11.5, 11.5)
    ctx.closePath()
    ctx.fillStyle = colour
    ctx.fill()
    ctx.restore()

    // Handle being dragged.
    const hs = b.width * 0.28
    const hx = b.x + b.width  - hs - 3
    const hy = b.y + b.height - hs - 3
    ctx.fillStyle = colour
    ctx.fillRect(hx, hy, hs, hs)
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'
    ctx.lineWidth = 1
    ctx.strokeRect(hx, hy, hs, hs)
  }

  // Small stack of overlapping rectangles — stack-widget capture toggle.
  private _drawStackIcon(ctx: Ctx2D, b: BBox, active: boolean): void {
    this._drawBtnBg(ctx, b)
    const colour = active ? ACCENT : 'rgba(255,255,255,0.55)'

    const rw   = b.width  * 0.5
    const rh   = b.height * 0.38
    const step = b.width  * 0.14

    ctx.save()
    ctx.strokeStyle = colour
    ctx.lineWidth   = 1.4
    for (let i = 2; i >= 0; i--) {
      const rx = b.x + b.width  * 0.18 + step * i
      const ry = b.y + b.height * 0.18 + step * i
      ctx.beginPath()
      ctx.roundRect(rx, ry, rw, rh, 1.5)
      if (i === 0) {
        ctx.fillStyle   = colour
        ctx.globalAlpha = 0.25
        ctx.fill()
        ctx.globalAlpha = 1
      }
      ctx.stroke()
    }
    ctx.restore()
  }

  // Conventional still-shutter button — a slightly dished (concave) white disc.
  private _drawShutterIcon(ctx: Ctx2D, b: BBox): void {
    this._drawBtnBg(ctx, b)
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    const r  = Math.min(b.width, b.height) / 2 - 3

    const grad = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r)
    grad.addColorStop(0,   'rgba(208,208,208,1)')
    grad.addColorStop(0.7, 'rgba(255,255,255,1)')
    grad.addColorStop(1,   'rgba(232,232,232,1)')

    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = grad
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'
    ctx.stroke()
  }

  // Conventional movie record/stop button — white disc with a red dot
  // (record) or a black square (stop).
  private _drawRecordIcon(ctx: Ctx2D, b: BBox, recording: boolean): void {
    this._drawBtnBg(ctx, b)
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    const r  = Math.min(b.width, b.height) / 2 - 3

    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'
    ctx.stroke()

    if (recording) {
      const s = r * 0.9
      ctx.fillStyle = '#1a1a1a'
      ctx.fillRect(cx - s / 2, cy - s / 2, s, s)
    } else {
      ctx.beginPath()
      ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2)
      ctx.fillStyle = '#e8453c'
      ctx.fill()
    }
  }

  private _drawBtn(ctx: Ctx2D, b: BBox, label: string, colour: string): void {
    this._drawBtnBg(ctx, b)
    ctx.font         = '13px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }

  // ── Interaction ───────────────────────────────────────────────

  protected override hitTestSelf(point: Point): this | null {
    if (this._editBtnB    !== null && boundingBoxContains(this._editBtnB, point))    return this
    if (this._stackBtnB   !== null && boundingBoxContains(this._stackBtnB, point))   return this
    if (this._modeBtnB    !== null && boundingBoxContains(this._modeBtnB, point))    return this
    if (this._shutterBtnB !== null && boundingBoxContains(this._shutterBtnB, point)) return this
    if (this._saveBtnB    !== null && boundingBoxContains(this._saveBtnB, point))    return this
    if (this._playBtnB    !== null && boundingBoxContains(this._playBtnB, point))    return this
    if (this._scrubB      !== null && boundingBoxContains(this._scrubB, point))      return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    if (this._editBtnB !== null && boundingBoxContains(this._editBtnB, point)) {
      this._toggleEditCapture()
      return true
    }
    if (this._stackBtnB !== null && boundingBoxContains(this._stackBtnB, point)) {
      this._toggleStackCapture()
      return true
    }
    if (this._modeBtnB !== null && boundingBoxContains(this._modeBtnB, point)) {
      this._toggleMovieMode()
      return true
    }
    if (this._shutterBtnB !== null && boundingBoxContains(this._shutterBtnB, point)) {
      this._handleShutterClick()
      return true
    }
    if (this._saveBtnB !== null && boundingBoxContains(this._saveBtnB, point)) {
      this._save()
      return true
    }
    if (this._playBtnB !== null && boundingBoxContains(this._playBtnB, point)) {
      this._togglePreviewPlayback()
      return true
    }
    if (this._scrubB !== null && boundingBoxContains(this._scrubB, point)) {
      this._scrubDragging = true
      if (this._previewPlaying) {
        this._previewVideo?.pause()
        this._previewPlaying = false
      }
      this._seekPreview(point)
      return true
    }
    return false
  }

  handlePointerMove(point: Point): void {
    if (this._scrubDragging) this._seekPreview(point)
  }

  handlePointerUp(): void {
    this._scrubDragging = false
  }
}
