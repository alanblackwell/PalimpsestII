import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type EventValue, type EventSource,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { collectSnapEdges, snapPointToEdges, drawSnapGuides, EDGE_SNAP_THRESHOLD } from '../interaction/EdgeSnapper.js'
import { drawIcon, type IconName } from '../ui/icons.js'

// ── Constants ─────────────────────────────────────────────────

const ACCENT   = '#7ecf7e'   // Image type colour
const STRIPE   = 4
const BTN      = 24          // load button size
const BTN_M    = 6           // load button margin from pill edge

// Control bar (play/pause + scrub track), drawn across the bottom of the canvas
const BAR_MARGIN  = 16   // margin from canvas edges
const BAR_H       = 36   // control bar height
const PLAY_SZ     = 32   // play/pause button size
const SCRUB_R     = 8    // scrub handle radius
const TRACK_H     = 4    // track line thickness
const TIME_W      = 74   // reserved width for the time readout
const THUMB_W     = 120  // preview thumbnail width
const THUMB_H     = 68   // preview thumbnail height
const THUMB_GAP   = 8    // gap between thumbnail and control bar

// Transform handles
const ROT_ACCENT = '#7ecfcf'   // Direction type colour for rotation handle
const HANDLE_R   = 7    // circle handle radius
const HANDLE_SZ  = 6    // square handle half-size
const HANDLE_HIT = 14   // pointer hit-test radius
const ROT_ARM    = 85   // rotate-handle arm length from centre
const SCALE_OX   = 70   // scale handle image-local x offset from centre
const SCALE_OY   = 70   // scale handle image-local y offset from centre
const MIN_VW     = 40   // minimum display width when scaling
const MIN_VH     = 30   // minimum display height when scaling

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0
  const total = Math.floor(s)
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${mm}:${String(ss).padStart(2, '0')}`
}

// ── Types ─────────────────────────────────────────────────────

type BBox = { x: number; y: number; width: number; height: number }

type DragState =
  | { type: 'move';   startMouse: Point; startCX: number; startCY: number }
  | { type: 'scale';  startDist: number; startW: number; startH: number; center: Point }
  | { type: 'rotate'; startAngle: number; startRot: number; center: Point }

function ptDist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// ── MediaLayer ────────────────────────────────────────────────
//
// Loads a video file from local disk and produces ValueType.Image —
// the same OffscreenCanvas-per-frame capture approach as VideoLayer,
// but reading from a file-backed <video> element (via an object URL)
// instead of a camera MediaStream.
//
// A control bar across the bottom of the canvas (panel-only) provides
// play/pause and a draggable scrub handle. A second hidden <video>
// (_previewVideo) is seeked alongside the main element while scrubbing,
// so a small thumbnail of the frame at that position can be shown above
// the handle without disturbing the main playback element.

export class MediaLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  // Off-screen video element — receives the loaded file
  private _video:     HTMLVideoElement
  private _objectUrl: string | null = null
  private _filename:  string = ''

  // Play state: when true, the video element advances and the
  // capture loop self-perpetuates each frame.
  private _playing = false

  // Last captured frame (result canvas)
  private _result: OffscreenCanvas | null = null

  // Event slot — each event edge toggles play/pause
  readonly enableSlot: ParameterSlot
  private _lastEventTime: EventValue = null

  // Toggle button bounds (set during renderSlots, used for hit-testing)
  private _toggleBounds: BBox | null = null

  // Load button bounds (set during renderPanel, used for hit-testing)
  private _loadBtnB: BBox | null = null

  // Human-readable status shown in the panel
  private _status = 'no video loaded'

  // ── Control bar / scrub state ───────────────────────────────────
  private _duration:    number = 0
  private _currentTime: number = 0
  private _scrubbing = false
  private _wasPlayingBeforeScrub = false
  private _playBtnB:    BBox | null = null
  private _scrubTrackB: BBox | null = null

  // Second hidden video, seeked while scrubbing to produce a thumbnail
  // preview without disturbing the main playback element.
  private _previewVideo:  HTMLVideoElement
  private _previewCanvas: OffscreenCanvas | null = null
  private _previewTime:   number | null = null

  // ── Display transform ─────────────────────────────────────────
  // When _manualTransform is false, these are recomputed each frame to
  // letterbox-fit the video within the visible viewport. Once the user
  // drags any handle, _manualTransform is set and the values are locked.
  private _cx              = 0
  private _cy              = 0
  private _displayW        = 0
  private _displayH        = 0
  private _rotation        = 0
  private _manualTransform = false
  private _drag: DragState | null = null
  private _edgeSnapX: number | null = null
  private _edgeSnapY: number | null = null

  // ── Construction ─────────────────────────────────────────────

  constructor() {
    super()
    this.debugName = 'Media'

    this.enableSlot = new ParameterSlot(ValueType.Event, this, 'play/pause toggle')
    this.slots.push(this.enableSlot)

    // Hidden video element — must live in the DOM for Safari to
    // deliver frames; positioned far off-screen.
    this._video = document.createElement('video')
    this._video.playsInline = true
    this._video.muted       = true
    this._video.loop        = true
    this._video.style.cssText =
      'position:fixed;top:-9999px;left:-9999px;pointer-events:none;opacity:0'
    document.body.appendChild(this._video)

    const onDuration = () => {
      this._duration = this._video.duration || 0
      this.markDirty()
    }
    this._video.addEventListener('loadedmetadata', onDuration)
    this._video.addEventListener('durationchange', onDuration)

    // Preview video — same source, seeked independently while scrubbing.
    this._previewVideo = document.createElement('video')
    this._previewVideo.playsInline = true
    this._previewVideo.muted       = true
    this._previewVideo.style.cssText =
      'position:fixed;top:-9999px;left:-9999px;pointer-events:none;opacity:0'
    document.body.appendChild(this._previewVideo)
    this._previewVideo.addEventListener('seeked', () => this._capturePreviewFrame())

    graph.register(this)
  }

  // ── File loading ───────────────────────────────────────────────

  loadFile(file: File): void {
    if (this._objectUrl !== null) URL.revokeObjectURL(this._objectUrl)
    this._objectUrl = URL.createObjectURL(file)
    this._filename  = file.name
    this._status    = 'loading…'
    this._duration  = 0
    this._currentTime = 0
    this._scrubbing = false
    this._previewCanvas = null
    this._previewTime   = null

    this._video.src = this._objectUrl
    this._video.load()
    this._previewVideo.src = this._objectUrl

    this._playing = true
    void this._video.play().catch(() => {
      this._status = 'play error'
      this.markDirty()
    })
    this.markDirty()
  }

  openFilePicker(): void {
    const input = document.createElement('input')
    input.type   = 'file'
    input.accept = 'video/*'
    input.style.display = 'none'
    document.body.appendChild(input)
    input.onchange = () => {
      const file = input.files?.[0]
      document.body.removeChild(input)
      if (file) this.loadFile(file)
    }
    input.click()
  }

  // ── ImageSource ───────────────────────────────────────────────

  getImage(): ImageValue { return this._result }

  // ── Persistence ───────────────────────────────────────────────
  // Config only — never the loaded video file or captured frames. After
  // load this layer comes back with no source; the filename is shown but
  // the user must re-load that file from disk to resume playback.

  override serializeState(): Record<string, unknown> {
    return {
      filename:        this._filename,
      playing:         this._playing,
      currentTime:     this._currentTime,
      lastEventTime:   this._lastEventTime,
      cx:              this._cx,
      cy:              this._cy,
      displayW:        this._displayW,
      displayH:        this._displayH,
      rotation:        this._rotation,
      manualTransform: this._manualTransform,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.filename === 'string')    this._filename    = state.filename
    if (typeof state.playing === 'boolean')    this._playing     = state.playing
    if (typeof state.currentTime === 'number') this._currentTime = state.currentTime
    if (typeof state.lastEventTime === 'number' || state.lastEventTime === null) {
      this._lastEventTime = state.lastEventTime as EventValue
    }
    if (typeof state.cx === 'number')               this._cx             = state.cx
    if (typeof state.cy === 'number')               this._cy             = state.cy
    if (typeof state.displayW === 'number')         this._displayW       = state.displayW
    if (typeof state.displayH === 'number')         this._displayH       = state.displayH
    if (typeof state.rotation === 'number')         this._rotation       = state.rotation
    if (typeof state.manualTransform === 'boolean') this._manualTransform = state.manualTransform
  }

  // ── Node — evaluate & recompute ───────────────────────────────

  override evaluate(): void {
    if (this.enableSlot.isActive) this.enableSlot.source!.evaluate()
    super.evaluate()
  }

  protected recompute(): void {
    // Consume event slot — each rising edge toggles play/pause.
    if (this.enableSlot.isActive) {
      const t = (this.enableSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastEventTime) {
        this._lastEventTime = t
        this._togglePlay()
      }
    }

    if (!this._scrubbing) {
      this._currentTime = this._video.currentTime
    }

    // Auto-fit the video within the visible viewport (contain/letterbox).
    // Skipped once the user has manually positioned or resized via handles.
    if (!this._manualTransform) this._computeAutoFit()

    // Capture the current frame whenever data is available — covers normal
    // playback, a paused frame, and a frame reached by scrubbing.
    if (this._objectUrl !== null && this._video.readyState >= HTMLVideoElement.HAVE_CURRENT_DATA) {
      const cw = Node.canvasWidth
      const ch = Node.canvasHeight

      if (!this._result || this._result.width !== cw || this._result.height !== ch)
        this._result = new OffscreenCanvas(cw, ch)

      const ctx = this._result.getContext('2d')!
      ctx.clearRect(0, 0, cw, ch)

      if (this._displayW > 0 && this._displayH > 0) {
        ctx.save()
        ctx.translate(this._cx, this._cy)
        ctx.rotate(this._rotation)
        ctx.drawImage(
          this._video,
          -this._displayW / 2, -this._displayH / 2,
          this._displayW, this._displayH,
        )
        ctx.restore()
      }

      this._status = this._playing ? 'playing' : 'paused'
    }

    // While playing and still in the stack (or parked in BackgroundLayer),
    // schedule the next frame via a microtask — forceDirty() is called
    // AFTER evaluate() clears our dirty flag, so the next rAF finds us
    // dirty and captures a fresh frame.
    if (this._playing && this._objectUrl !== null && (!this.outsideStack || this.inBackground)) {
      queueMicrotask(() => {
        if (this._playing && this._objectUrl !== null && (!this.outsideStack || this.inBackground)) {
          this.forceDirty()
        }
      })
    }
  }

  // Letterbox-fit the video within the current visible viewport.
  // Uses viewportWidth/Height (not canvasWidth/Height) so the video fills
  // what the user actually sees, regardless of how large the grow-only
  // canvas has become.
  private _computeAutoFit(): void {
    const vw    = this._video.videoWidth  || 16
    const vh    = this._video.videoHeight || 9
    const sw    = Node.viewportWidth
    const sh    = Node.viewportHeight
    const scale = Math.min(sw / vw, sh / vh)
    this._displayW = vw * scale
    this._displayH = vh * scale
    this._cx = sw / 2
    this._cy = sh / 2
  }

  // ── Rendering ─────────────────────────────────────────────────

  renderSelf(ctx: Ctx2D): void {
    if (this._result === null) return
    ctx.drawImage(
      this._result as CanvasImageSource, 0, 0,
      Node.canvasWidth, Node.canvasHeight,
    )
  }

  renderPanel(ctx: Ctx2D): void {
    // Left strip pill (visible in the layer stack widget)
    this._drawStripPill(ctx, this.bounds)
    // Canvas-space pill with file load + status
    this._drawMediaPill(ctx, this.canvasBounds)
    // Playback control bar across the bottom of the canvas
    this._renderControlBar(ctx)
  }

  override getSnapBounds(): { minX: number; maxX: number; minY: number; maxY: number } | null {
    if (this._displayW <= 0 || this._displayH <= 0) return null
    const halfW = this._displayW / 2, halfH = this._displayH / 2
    const cosA  = Math.cos(this._rotation), sinA = Math.sin(this._rotation)
    const extX  = Math.abs(halfW * cosA) + Math.abs(halfH * sinA)
    const extY  = Math.abs(halfW * sinA) + Math.abs(halfH * cosA)
    return { minX: this._cx - extX, maxX: this._cx + extX, minY: this._cy - extY, maxY: this._cy + extY }
  }

  override renderOverlay(ctx: Ctx2D): void {
    this._renderHandles(ctx)
    drawSnapGuides(ctx, this._edgeSnapX, this._edgeSnapY, Node.canvasWidth, Node.canvasHeight)
  }

  // Slot rows are rendered by the base class; we add the play/pause toggle button.
  override renderSlots(ctx: Ctx2D): void {
    super.renderSlots(ctx)

    const SLOT_H   = 30
    const SLOT_GAP = 4
    const BTN_SZ   = SLOT_H - 6   // 20px

    const idx = this.slots.indexOf(this.enableSlot)
    if (idx < 0) return

    const { x: PANEL_X, width: PANEL_W } = this.canvasBounds
    const y    = this.panelBottom + idx * (SLOT_H + SLOT_GAP)
    const midY = y + SLOT_H / 2
    const btnX = PANEL_X + PANEL_W - BTN_SZ - 3
    const btnY = y + 3

    this._toggleBounds = { x: btnX, y: btnY, width: BTN_SZ, height: BTN_SZ }

    const state       = this.enableSlot.state
    const isActive    = state === SlotState.Bound
    const isSuspended = state === SlotState.SuspendedBound

    ctx.save()

    // Button background
    if (isActive) {
      ctx.fillStyle = ACCENT + '33'
    } else if (isSuspended) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)'
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.08)'
    }
    ctx.beginPath()
    ctx.roundRect(btnX, btnY, BTN_SZ, BTN_SZ, 3)
    ctx.fill()

    // Border
    ctx.strokeStyle = isActive ? ACCENT + '99' : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    if (isSuspended) ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.roundRect(btnX + 0.5, btnY + 0.5, BTN_SZ - 1, BTN_SZ - 1, 3)
    ctx.stroke()
    ctx.setLineDash([])

    // Play/pause icon — shows the action the button performs
    const iconCol = isActive
      ? ACCENT
      : isSuspended ? 'rgba(255,255,255,0.35)'
      : ACCENT
    ctx.fillStyle    = iconCol
    drawIcon(ctx, this._playing ? 'pause' : 'play', btnX + BTN_SZ / 2, midY, BTN_SZ - 8)

    ctx.restore()
  }

  // ── Control bar ───────────────────────────────────────────────

  private _controlBarBounds(): BBox {
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    return { x: BAR_MARGIN, y: h - BAR_H - BAR_MARGIN, width: w - BAR_MARGIN * 2, height: BAR_H }
  }

  private _playBtnBounds(bar: BBox): BBox {
    return { x: bar.x + 4, y: bar.y + (bar.height - PLAY_SZ) / 2, width: PLAY_SZ, height: PLAY_SZ }
  }

  private _scrubTrackBounds(bar: BBox): BBox {
    const playB = this._playBtnBounds(bar)
    const left  = playB.x + playB.width + 12
    const right = bar.x + bar.width - 12 - TIME_W
    return { x: left, y: bar.y, width: Math.max(0, right - left), height: bar.height }
  }

  private _handleX(track: BBox): number {
    const frac = this._duration > 0 ? this._currentTime / this._duration : 0
    return track.x + Math.max(0, Math.min(1, frac)) * track.width
  }

  private _renderControlBar(ctx: Ctx2D): void {
    if (this._objectUrl === null) {
      this._playBtnB    = null
      this._scrubTrackB = null
      return
    }

    const bar = this._controlBarBounds()
    if (bar.width <= 0 || bar.height <= 0) return

    const playB = this._playBtnBounds(bar)
    const track = this._scrubTrackBounds(bar)
    this._playBtnB    = playB
    this._scrubTrackB = track

    const trackY  = track.y + track.height / 2
    const handleX = this._handleX(track)

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(bar.x, bar.y, bar.width, bar.height, bar.height / 2)
    ctx.fill()

    // Play/pause button
    ctx.beginPath()
    ctx.roundRect(playB.x, playB.y, playB.width, playB.height, playB.height / 2)
    ctx.fillStyle = 'rgba(255,255,255,0.10)'
    ctx.fill()
    ctx.fillStyle    = ACCENT
    drawIcon(ctx, this._playing ? 'pause' : 'play', playB.x + playB.width / 2, playB.y + playB.height / 2, 20)

    if (track.width > 0) {
      // Track
      ctx.lineCap = 'round'
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'
      ctx.lineWidth   = TRACK_H
      ctx.beginPath()
      ctx.moveTo(track.x, trackY)
      ctx.lineTo(track.x + track.width, trackY)
      ctx.stroke()

      // Progress fill
      ctx.strokeStyle = ACCENT
      ctx.beginPath()
      ctx.moveTo(track.x, trackY)
      ctx.lineTo(handleX, trackY)
      ctx.stroke()

      // Handle
      ctx.beginPath()
      ctx.arc(handleX, trackY, SCRUB_R, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.lineWidth   = 1.5
      ctx.strokeStyle = ACCENT
      ctx.stroke()
    }

    // Time readout
    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.65)'
    ctx.textAlign    = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      `${fmtTime(this._currentTime)} / ${fmtTime(this._duration)}`,
      bar.x + bar.width - 12, bar.y + bar.height / 2,
    )

    ctx.restore()

    if (this._scrubbing && this._previewCanvas !== null) {
      this._renderThumbnail(ctx, handleX, bar.y)
    }
  }

  private _renderThumbnail(ctx: Ctx2D, handleX: number, barTop: number): void {
    const cw = Node.canvasWidth
    const x = Math.max(4, Math.min(cw - THUMB_W - 4, handleX - THUMB_W / 2))
    const y = barTop - THUMB_GAP - THUMB_H

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.75)'
    ctx.beginPath()
    ctx.roundRect(x - 3, y - 3, THUMB_W + 6, THUMB_H + 6, 6)
    ctx.fill()
    ctx.drawImage(this._previewCanvas as CanvasImageSource, x, y, THUMB_W, THUMB_H)
    ctx.strokeStyle = ACCENT
    ctx.lineWidth   = 1.5
    ctx.strokeRect(x, y, THUMB_W, THUMB_H)
    ctx.restore()
  }

  private _capturePreviewFrame(): void {
    const v = this._previewVideo
    if (v.readyState < HTMLVideoElement.HAVE_CURRENT_DATA) return
    const vw = v.videoWidth, vh = v.videoHeight
    if (!vw || !vh) return

    if (!this._previewCanvas || this._previewCanvas.width !== THUMB_W || this._previewCanvas.height !== THUMB_H) {
      this._previewCanvas = new OffscreenCanvas(THUMB_W, THUMB_H)
    }
    const ctx = this._previewCanvas.getContext('2d')!
    ctx.clearRect(0, 0, THUMB_W, THUMB_H)

    // Contain-scale within the thumbnail box, centred.
    const scale = Math.min(THUMB_W / vw, THUMB_H / vh)
    const dw = vw * scale, dh = vh * scale
    ctx.drawImage(v, (THUMB_W - dw) / 2, (THUMB_H - dh) / 2, dw, dh)

    this.markDirty()
  }

  // ── Scrubbing ────────────────────────────────────────────────

  private _scrubHit(point: Point): boolean {
    if (this._scrubTrackB === null || this._duration <= 0) return false
    const t = this._scrubTrackB
    return point.x >= t.x - SCRUB_R && point.x <= t.x + t.width + SCRUB_R &&
           point.y >= t.y && point.y <= t.y + t.height
  }

  private _beginScrub(point: Point): void {
    this._scrubbing = true
    this._wasPlayingBeforeScrub = this._playing
    if (this._playing) this._video.pause()
    this._seekFromPointer(point)
  }

  private _seekFromPointer(point: Point): void {
    const t = this._scrubTrackB
    if (t === null || this._duration <= 0) return
    const frac = t.width > 0 ? Math.max(0, Math.min(1, (point.x - t.x) / t.width)) : 0
    const time = frac * this._duration

    this._currentTime = time
    this._video.currentTime = time
    this._previewVideo.currentTime = time
    this._previewTime = time
    this.forceDirty()
  }

  // ── Transform handles ─────────────────────────────────────────

  private _handlePos() {
    const cos = Math.cos(this._rotation)
    const sin = Math.sin(this._rotation)
    return {
      move: { x: this._cx, y: this._cy },
      // Fixed offset (SCALE_OX, SCALE_OY) in image-local space, rotated into world space.
      scale: {
        x: this._cx + SCALE_OX * cos - SCALE_OY * sin,
        y: this._cy + SCALE_OX * sin + SCALE_OY * cos,
      },
      // ROT_ARM above centre along the rotation axis.
      rotate: {
        x: this._cx + ROT_ARM * sin,
        y: this._cy - ROT_ARM * cos,
      },
    }
  }

  private _renderHandles(ctx: Ctx2D): void {
    if (this._displayW <= 0) return
    const cx = this._cx
    const cy = this._cy
    const hw = this._displayW / 2
    const hh = this._displayH / 2
    const hp = this._handlePos()

    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.80)'
    ctx.shadowBlur  = 5

    // Video outline (rotated rectangle, dashed)
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(this._rotation)
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'
    ctx.lineWidth   = 1
    ctx.setLineDash([4, 4])
    ctx.strokeRect(-hw, -hh, this._displayW, this._displayH)
    ctx.restore()
    ctx.setLineDash([])

    // Arms: centre → rotate handle, centre → scale handle
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth   = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(cx, cy); ctx.lineTo(hp.rotate.x, hp.rotate.y)
    ctx.moveTo(cx, cy); ctx.lineTo(hp.scale.x,  hp.scale.y)
    ctx.stroke()
    ctx.setLineDash([])

    // Move handle — circle + crosshair at centre
    ctx.beginPath()
    ctx.arc(cx, cy, HANDLE_R, 0, Math.PI * 2)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth   = 1.5
    ctx.stroke()
    const cr = HANDLE_R * 0.6
    ctx.beginPath()
    ctx.moveTo(cx - cr, cy); ctx.lineTo(cx + cr, cy)
    ctx.moveTo(cx, cy - cr); ctx.lineTo(cx, cy + cr)
    ctx.stroke()

    // Scale handle — square at lower-right corner
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(hp.scale.x - HANDLE_SZ, hp.scale.y - HANDLE_SZ, HANDLE_SZ * 2, HANDLE_SZ * 2)
    ctx.strokeStyle = ACCENT
    ctx.lineWidth   = 1.5
    ctx.strokeRect(
      hp.scale.x - HANDLE_SZ + 0.5, hp.scale.y - HANDLE_SZ + 0.5,
      HANDLE_SZ * 2 - 1, HANDLE_SZ * 2 - 1,
    )

    // Rotate handle — circle (teal)
    ctx.beginPath()
    ctx.arc(hp.rotate.x, hp.rotate.y, HANDLE_R, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = ROT_ACCENT
    ctx.lineWidth   = 1.5
    ctx.stroke()

    ctx.restore()
  }

  // ── Interaction ───────────────────────────────────────────────

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    // Capture all events while a handle drag is active.
    if (this._drag !== null) return this
    // Transform handles
    if (this._displayW > 0) {
      const hp = this._handlePos()
      if (ptDist(point, hp.move)   <= HANDLE_HIT) return this
      if (ptDist(point, hp.scale)  <= HANDLE_HIT) return this
      if (ptDist(point, hp.rotate) <= HANDLE_HIT) return this
    }
    // Toggle button (in slot row)
    if (this._toggleBounds !== null && boundingBoxContains(this._toggleBounds, point)) return this
    // Load button
    if (this._loadBtnB !== null && boundingBoxContains(this._loadBtnB, point)) return this
    // Control bar
    if (this._playBtnB !== null && boundingBoxContains(this._playBtnB, point)) return this
    if (this._scrubHit(point)) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    // Transform handles take priority — they're canvas content, not pill UI.
    if (this._displayW > 0) {
      const hp = this._handlePos()

      if (ptDist(point, hp.rotate) <= HANDLE_HIT) {
        this._drag = {
          type:       'rotate',
          center:     { x: this._cx, y: this._cy },
          startAngle: Math.atan2(point.y - this._cy, point.x - this._cx),
          startRot:   this._rotation,
        }
        this._manualTransform = true
        return true
      }

      if (ptDist(point, hp.scale) <= HANDLE_HIT) {
        this._drag = {
          type:      'scale',
          center:    { x: this._cx, y: this._cy },
          startDist: Math.max(1, ptDist(point, { x: this._cx, y: this._cy })),
          startW:    this._displayW,
          startH:    this._displayH,
        }
        this._manualTransform = true
        return true
      }

      if (ptDist(point, hp.move) <= HANDLE_HIT) {
        this._drag = {
          type:       'move',
          startMouse: { ...point },
          startCX:    this._cx,
          startCY:    this._cy,
        }
        this._manualTransform = true
        return true
      }
    }

    if (this._loadBtnB !== null && boundingBoxContains(this._loadBtnB, point)) {
      this.openFilePicker()
      return true
    }
    if (this._toggleBounds !== null && boundingBoxContains(this._toggleBounds, point)) {
      this._handleToggle()
      return true
    }
    if (this._playBtnB !== null && boundingBoxContains(this._playBtnB, point)) {
      this._handleToggle()
      return true
    }
    if (this._scrubHit(point)) {
      this._beginScrub(point)
      return true
    }
    return false
  }

  handlePointerMove(point: Point): void {
    if (this._drag !== null) {
      if (this._drag.type === 'move') {
        const rawCx = this._drag.startCX + point.x - this._drag.startMouse.x
        const rawCy = this._drag.startCY + point.y - this._drag.startMouse.y
        const edges = collectSnapEdges(this, 3)
        if (edges.xs.length > 0 || edges.ys.length > 0) {
          const halfW = this._displayW / 2, halfH = this._displayH / 2
          const cosA  = Math.cos(this._rotation), sinA = Math.sin(this._rotation)
          const extX  = Math.abs(halfW * cosA) + Math.abs(halfH * sinA)
          const extY  = Math.abs(halfW * sinA) + Math.abs(halfH * cosA)
          const snapped = snapPointToEdges({ x: rawCx, y: rawCy }, edges, EDGE_SNAP_THRESHOLD,
            [-extX, 0, extX], [-extY, 0, extY])
          this._cx = snapped.x; this._cy = snapped.y
          this._edgeSnapX = snapped.snapLineX; this._edgeSnapY = snapped.snapLineY
        } else {
          this._cx = rawCx; this._cy = rawCy
          this._edgeSnapX = null; this._edgeSnapY = null
        }
      } else if (this._drag.type === 'scale') {
        const d      = Math.max(1, ptDist(point, this._drag.center))
        const factor = d / this._drag.startDist
        this._displayW = Math.max(MIN_VW, this._drag.startW * factor)
        this._displayH = Math.max(MIN_VH, this._drag.startH * factor)
      } else {
        const angle    = Math.atan2(
          point.y - this._drag.center.y,
          point.x - this._drag.center.x,
        )
        this._rotation = this._drag.startRot + (angle - this._drag.startAngle)
      }
      this.markDirty()
      return
    }
    if (!this._scrubbing) return
    this._seekFromPointer(point)
  }

  handlePointerUp(): void {
    if (this._drag !== null) {
      this._drag = null
      this._edgeSnapX = null
      this._edgeSnapY = null
      return
    }
    if (!this._scrubbing) return
    this._scrubbing  = false
    this._previewTime = null
    if (this._wasPlayingBeforeScrub) {
      void this._video.play().catch(() => {})
    }
    this.markDirty()
  }

  // ── Private helpers ───────────────────────────────────────────

  private _togglePlay(): void {
    this._playing = !this._playing
    if (this._objectUrl === null) return
    if (this._playing) {
      this._status = 'playing'
      void this._video.play().catch(() => {})
    } else {
      this._status = 'paused'
      this._video.pause()
    }
  }

  private _handleToggle(): void {
    if (this.enableSlot.state === SlotState.Bound) {
      this.enableSlot.suspend()
    } else if (this.enableSlot.state === SlotState.SuspendedBound) {
      this.enableSlot.resume()
    } else {
      this._togglePlay()
      this.markDirty()
    }
  }

  // Simple strip pill drawn at the given bounds (left widget area).
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
    ctx.fillText('Media', x + 12, y + height / 2)
    ctx.restore()
  }

  // File-load / status pill drawn in canvas space (right of Stack Widget).
  private _drawMediaPill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return

    const midY = y + height / 2

    ctx.save()

    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, STRIPE, height, [4, 0, 0, 4])
    ctx.fill()

    // [📁] load button — right-aligned
    const loadB: BBox = {
      x:      x + width - BTN_M - BTN,
      y:      y + (height - BTN) / 2,
      width:  BTN,
      height: BTN,
    }
    this._loadBtnB = loadB

    // Filename / status text, clipped between the stripe and the load button
    const textL = x + STRIPE + 8
    const textW = loadB.x - textL - 6
    if (textW > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(textL, y, textW, height)
      ctx.clip()
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'middle'
      if (this._objectUrl === null) {
        ctx.fillStyle = 'rgba(255,255,255,0.30)'
        ctx.font      = '11px monospace'
        ctx.fillText('no video loaded', textL, midY)
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.85)'
        ctx.font      = '11px monospace'
        ctx.fillText(this._filename, textL, midY - 6)
        ctx.fillStyle = 'rgba(255,255,255,0.45)'
        ctx.font      = '10px monospace'
        const vw = this._video.videoWidth
        const vh = this._video.videoHeight
        const dims = vw && vh ? `${vw} × ${vh} · ` : ''
        ctx.fillText(`${dims}${this._status}`, textL, midY + 6)
      }
      ctx.restore()
    }

    this._drawBtn(ctx, loadB, 'folder-open', 'rgba(255,255,255,0.75)')

    ctx.restore()
  }

  private _drawBtn(ctx: Ctx2D, b: BBox, icon: IconName, colour: string): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    ctx.fillStyle = colour
    drawIcon(ctx, icon, b.x + b.width / 2, b.y + b.height / 2, Math.min(b.width, b.height) - 8)
  }
}
