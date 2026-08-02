import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import { SliderSlot }    from '../ui/SliderSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type EventValue, type EventSource,
  type Amount, type AmountSource,
  type Direction,
  type Ctx2D, type Point,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'
import { detectFaces, detectSkin, rgbaToGray, type SkinResult } from './haarFaceDetect.js'
import { collectSnapEdges, snapPointToEdges, drawSnapGuides, EDGE_SNAP_THRESHOLD } from '../interaction/EdgeSnapper.js'
import { drawIcon, type IconName } from '../ui/icons.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'

// ── Constants ─────────────────────────────────────────────────

const ACCENT     = '#7ecf7e'   // Image type colour
const ROT_ACCENT = '#7ecfcf'   // Direction type colour for rotation handle
const AM_COL     = '#4a8fe8'   // Amount type accent
const STRIPE     = 4

// Small selector buttons — desktop's lower pill has none of these (the big
// row above covers camera/screen/file); mobile's lower pill uses this size
// for its two secondary screen/file buttons.
const SRC_W   = 28   // each button width (square)
const SRC_GAP = 3    // gap between buttons
const SRC_L   = STRIPE + 6   // left margin of first button within pill

// Large source-selector buttons — desktop: one row of 3 (camera/screen/
// file); mobile: one per detected camera, wrapping into extra rows.
const LG_SZ     = 72   // square size of a big button
const LG_GAP    = 6    // gap between big buttons
const LG_MARGIN = 10   // margin inside the pill around the big-button grid
const LOWER_H   = 36   // height of the secondary-controls pill below
const ROW_GAP   = 8    // gap between the big-button pill and the lower pill

// Camera navigation buttons (desktop only — mobile selects cameras directly
// via their own big buttons)
const NAV_SZ  = 20
const NAV_M   = 4    // margin inside the right section

// Mirror / fit-fill buttons in source pill
const MIR_W   = 32
const MIR_GAP = 4

// File controls
const BTN   = 22     // load button size
const BTN_M = 6      // load button margin from right edge

// File playback control bar
const BAR_MARGIN = 16
const BAR_H      = 36
const PLAY_SZ    = 32
const SCRUB_R    = 8
const TRACK_H    = 4
const TIME_W     = 74
const THUMB_W    = 120
const THUMB_H    = 68
const THUMB_GAP  = 8

// Transform handles
const HANDLE_R   = 7
const HANDLE_SZ  = 6
const HANDLE_HIT = 14
const ROT_ARM    = 85
const SCALE_OX   = 70
const SCALE_OY   = 70
const MIN_VW     = 40
const MIN_VH     = 30

// ── Types ─────────────────────────────────────────────────────

type SourceType = 'none' | 'camera' | 'screen' | 'file'

type BBox = { x: number; y: number; width: number; height: number }

type DragState =
  | { type: 'move';   startMouse: Point; startCX: number; startCY: number }
  | { type: 'scale';  startDist: number; startW: number; startH: number; center: Point }
  | { type: 'rotate'; startAngle: number; startRot: number; center: Point }

function ptDist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s) % 60).padStart(2, '0')}`
}

// ── VideoLayer ────────────────────────────────────────────────
//
// Unified video-source layer. The user chooses a source via three
// buttons: camera (🎥), screen share (⊞), or file (📁). No camera
// permission is requested until the user explicitly selects camera.
//
// Old VideoLayer saves (no sourceType field, has deviceIdx) are
// migrated by auto-starting the camera. Old MediaLayer saves (has
// filename field) are migrated as file source.

export class VideoLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  // ── Source state ──────────────────────────────────────────────
  private _sourceType: SourceType = 'none'

  // Camera / screen share
  private _devices:   MediaDeviceInfo[] = []
  private _deviceIdx: number = 0
  private _stream:    MediaStream | null = null
  private _frozen     = false

  // File playback
  private _objectUrl:  string | null = null
  private _filename    = ''
  private _playing     = false
  private _duration    = 0
  private _currentTime = 0
  private _scrubbing   = false
  private _wasPlayingBeforeScrub = false
  private _previewVideo:  HTMLVideoElement
  private _previewCanvas: OffscreenCanvas | null = null
  private _previewTime:   number | null = null

  // Shared video element and composited result
  private _video:   HTMLVideoElement
  private _result:  OffscreenCanvas | null = null
  private _status   = ''

  // Enable slot — rising edge toggles freeze (stream) or play/pause (file)
  readonly enableSlot:  ParameterSlot
  readonly opacitySlot: ParameterSlot
  private _lastEventTime: EventValue = null

  // Opacity — computed each recompute from slot; _manualOpacity when unbound
  private _opacity = 1.0
  private _manualOpacity = 1.0
  private readonly _opacityWidget: SliderSlot

  // ── Display transform ─────────────────────────────────────────
  private _cx              = 0
  private _cy              = 0
  private _displayW        = 0
  private _displayH        = 0
  private _rotation        = 0
  private _manualTransform = false
  private _fillMode        = false   // false = letterbox (contain), true = fill (cover)
  private _drag: DragState | null = null

  // Edge snap guide lines
  private _edgeSnapX: number | null = null
  private _edgeSnapY: number | null = null

  // ── Stall detection (camera suspended without track ending) ──────
  private _prevVideoTime    = -1   // last video.currentTime we observed
  private _frozenFrameCount = 0    // consecutive recomputes with no new frame
  private _streamHadFrames  = false // true once we've seen at least one advancing frame
  private _cameraStalled    = false // shown as overlay in renderSelf

  // ── Mirror mode ───────────────────────────────────────────────
  private _mirrored    = false
  private _mirrorBtnB: BBox | null = null

  // ── Face-detect overlay ───────────────────────────────────────
  private _faceDetectState: 'idle' | 'scanning' | 'found' | 'not-found' = 'idle'
  private _faceDetectMsg   = ''
  private _faceDetectTimer: ReturnType<typeof setTimeout> | null = null
  // Detected faces in canvas-display coordinates, set after a successful detect.
  private _canvasFaces: Array<{ cx: number; cy: number; radius: number }> = []

  // ── UI hit-test bounds (set during render, read during interaction) ──
  private _toggleBounds:      BBox | null = null
  private _camBtnB:           BBox | null = null
  private _camDeviceBtnB:     BBox[] = []   // mobile: one cell per camera
  private _screenBtnB:        BBox | null = null
  private _fileBtnB:          BBox | null = null
  private _fitBtnB:           BBox | null = null
  private _prevBtnB:          BBox | null = null
  private _nextBtnB:          BBox | null = null
  private _loadBtnB:          BBox | null = null
  private _playBtnB:          BBox | null = null
  private _scrubTrackB:       BBox | null = null
  private _stallRestartBounds: BBox | null = null

  // ── Track button ──────────────────────────────────────────────
  private _trackBtnB:    BBox | null = null
  private _addTrackDone  = false
  private _onAddTrack: (() => void) | null = null

  setOnAddTrack(fn: () => void): void { this._onAddTrack = fn }

  // ── Construction ─────────────────────────────────────────────

  constructor() {
    super()
    this.debugName = 'Video'

    this.enableSlot  = new ParameterSlot(ValueType.Event,  this, 'enable toggle')
    this.opacitySlot = new ParameterSlot(ValueType.Amount, this, 'opacity')
    this.slots.push(this.enableSlot, this.opacitySlot)

    this._opacityWidget = new SliderSlot(
      this.opacitySlot, 'opacity', AM_COL,
      () => this._manualOpacity,
      (v) => {
        if (this.opacitySlot.state === SlotState.Bound) BindingLayer.findForSlot(this.opacitySlot)?.toggle()
        this._manualOpacity = v
        this.markDirty()
      },
      () => this.markDirty(),
    )

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
    this._video.addEventListener('durationchange',  onDuration)

    this._previewVideo = document.createElement('video')
    this._previewVideo.playsInline = true
    this._previewVideo.muted       = true
    this._previewVideo.style.cssText =
      'position:fixed;top:-9999px;left:-9999px;pointer-events:none;opacity:0'
    document.body.appendChild(this._previewVideo)
    this._previewVideo.addEventListener('seeked', () => this._capturePreviewFrame())

    graph.register(this)

    // Populate the device list up front (no permission prompt) so mobile can
    // render one big button per camera before the user has picked a source.
    void this._refreshDeviceList()

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      if (this._sourceType !== 'camera') return
      if (this.outsideStack && !this.inBackground) return
      // Always restart: on mobile suspension the tracks stay 'live' but
      // stop delivering frames, so a track-state check isn't reliable.
      if (this._devices.length > 0) void this._startCameraStream()
      else void this._startCamera()
    })
  }

  // ── ImageSource ───────────────────────────────────────────────

  getImage(): ImageValue { return this._result }

  get opacityWidget(): SliderSlot { return this._opacityWidget }

  override getSnapBounds() {
    if (this._displayW <= 0 || this._displayH <= 0) return null
    const halfW = this._displayW / 2, halfH = this._displayH / 2
    const cosA  = Math.cos(this._rotation), sinA = Math.sin(this._rotation)
    const extX  = Math.abs(halfW * cosA) + Math.abs(halfH * sinA)
    const extY  = Math.abs(halfW * sinA) + Math.abs(halfH * cosA)
    return { minX: this._cx - extX, maxX: this._cx + extX, minY: this._cy - extY, maxY: this._cy + extY }
  }

  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | null {
    if (slot === this.opacitySlot) return this._manualOpacity
    return null
  }

  // ── File loading (public — called from drag-and-drop in main.ts) ──

  loadFile(file: File): void {
    this._stopCurrentSource()
    this._sourceType = 'file'

    if (this._objectUrl !== null) URL.revokeObjectURL(this._objectUrl)
    this._objectUrl   = URL.createObjectURL(file)
    this._filename    = file.name
    this._status      = 'loading…'
    this._duration    = 0
    this._currentTime = 0
    this._scrubbing   = false
    this._previewCanvas = null
    this._previewTime   = null

    this._video.srcObject = null
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

  // ── Persistence ───────────────────────────────────────────────

  override serializeState(): Record<string, unknown> {
    return {
      addTrackDone:    this._addTrackDone,
      manualOpacity:   this._manualOpacity,
      sourceType:      this._sourceType,
      deviceIdx:       this._deviceIdx,
      frozen:          this._frozen,
      lastEventTime:   this._lastEventTime,
      filename:        this._filename,
      playing:         this._playing,
      currentTime:     this._currentTime,
      cx:              this._cx,
      cy:              this._cy,
      displayW:        this._displayW,
      displayH:        this._displayH,
      rotation:        this._rotation,
      manualTransform: this._manualTransform,
      fillMode:        this._fillMode,
      mirrored:        this._mirrored,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    // Infer sourceType from old VideoLayer / MediaLayer saves.
    if (typeof state.sourceType === 'string') {
      this._sourceType = state.sourceType as SourceType
    } else if (typeof state.filename === 'string') {
      // Old MediaLayer save — treat as file source (file needs to be re-loaded).
      this._sourceType = state.filename ? 'file' : 'none'
    } else {
      // Old VideoLayer save — restart camera for continuity.
      this._sourceType = 'camera'
      void this._startCamera()
    }

    if (typeof state.deviceIdx === 'number')   this._deviceIdx    = state.deviceIdx
    if (typeof state.frozen === 'boolean')     this._frozen       = state.frozen
    if (typeof state.lastEventTime === 'number' || state.lastEventTime === null) {
      this._lastEventTime = state.lastEventTime as EventValue
    }
    if (typeof state.filename === 'string')    this._filename     = state.filename
    if (typeof state.playing === 'boolean')    this._playing      = state.playing
    if (typeof state.currentTime === 'number') this._currentTime  = state.currentTime
    if (typeof state.cx === 'number')               this._cx             = state.cx
    if (typeof state.cy === 'number')               this._cy             = state.cy
    if (typeof state.displayW === 'number')         this._displayW       = state.displayW
    if (typeof state.displayH === 'number')         this._displayH       = state.displayH
    if (typeof state.rotation === 'number')         this._rotation       = state.rotation
    if (typeof state.manualTransform === 'boolean') this._manualTransform = state.manualTransform
    if (typeof state.fillMode === 'boolean')        this._fillMode        = state.fillMode
    if (typeof state.mirrored === 'boolean')        this._mirrored        = state.mirrored
    if (typeof state.addTrackDone === 'boolean')    this._addTrackDone    = state.addTrackDone
    if (typeof state.manualOpacity === 'number')    this._manualOpacity   = state.manualOpacity

    // Restart the camera stream after restoring deviceIdx so the correct
    // device is selected. Screen and file sources can't be auto-restarted.
    if (this._sourceType === 'camera') void this._startCamera()
  }

  // ── Node — evaluate & recompute ───────────────────────────────

  override evaluate(): void {
    if (this.enableSlot.isActive) this.enableSlot.source!.evaluate()
    super.evaluate()
  }

  protected recompute(): void {
    this._opacity = this.opacitySlot.isActive
      ? (this.opacitySlot.source as AmountSource).getAmount() as Amount
      : this._manualOpacity

    // Rising edge on enable slot toggles freeze (stream) or play/pause (file).
    if (this.enableSlot.isActive) {
      const t = (this.enableSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastEventTime) {
        this._lastEventTime = t
        if (this._sourceType === 'file') this._togglePlay()
        else this._frozen = !this._frozen
      }
    }

    if (this._sourceType === 'file' && !this._scrubbing)
      this._currentTime = this._video.currentTime

    if (!this._manualTransform && this._sourceType !== 'none') {
      if (this._fillMode) this._computeFill()
      else this._computeAutoFit()
    }

    // Capture a frame when data is available.
    const isStream = (this._sourceType === 'camera' || this._sourceType === 'screen')
                     && this._stream !== null && !this._frozen
    const isFile   = this._sourceType === 'file' && this._objectUrl !== null

    if ((isStream || isFile) &&
        this._video.readyState >= 2 /* HAVE_CURRENT_DATA */) {
      const cw = Node.canvasWidth
      const ch = Node.canvasHeight
      if (!this._result || this._result.width !== cw || this._result.height !== ch)
        this._result = new OffscreenCanvas(cw, ch)

      const ctx = this._result.getContext('2d')!
      ctx.clearRect(0, 0, cw, ch)
      if (this._displayW > 0 && this._displayH > 0) {
        ctx.save()
        ctx.globalAlpha = Math.max(0, Math.min(1, this._opacity))
        ctx.translate(this._cx, this._cy)
        ctx.rotate(this._rotation)
        if (this._mirrored) ctx.scale(-1, 1)
        ctx.drawImage(this._video,
          -this._displayW / 2, -this._displayH / 2, this._displayW, this._displayH)
        ctx.restore()
      }

      if (isFile) this._status = this._playing ? 'playing' : 'paused'
    }

    // Stall detection: track whether video.currentTime is advancing.
    // A camera stream that has been suspended keeps its tracks 'live' but
    // stops delivering new frames. After ~30 consecutive recomputes (~0.5 s)
    // with no change in currentTime, flag the stream as stalled.
    if (isStream && this._video.readyState >= 2) {
      const ct = this._video.currentTime
      if (ct !== this._prevVideoTime) {
        this._prevVideoTime    = ct
        this._frozenFrameCount = 0
        this._streamHadFrames  = true
      } else if (this._streamHadFrames) {
        this._frozenFrameCount++
      }
    } else if (!isStream) {
      this._frozenFrameCount = 0
      this._streamHadFrames  = false
    }
    this._cameraStalled = isStream && this._streamHadFrames && this._frozenFrameCount > 30

    // Self-perpetuating frame loop.
    const liveStream = isStream
    const liveFile   = this._playing && this._objectUrl !== null
    if ((liveStream || liveFile) && (!this.outsideStack || this.inBackground)) {
      queueMicrotask(() => {
        const still = (this._stream !== null && !this._frozen) ||
                      (this._playing && this._objectUrl !== null)
        if (still && (!this.outsideStack || this.inBackground)) this.forceDirty()
      })
    }
  }

  // ── Camera source ─────────────────────────────────────────────

  // Silent enumeration — never prompts for permission. Pre-permission this
  // typically yields correct device *count* but blank labels/deviceIds in
  // most browsers; labels/ids fill in once permission has been granted, so
  // this is also called again after a stream starts successfully.
  private async _refreshDeviceList(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const all  = await navigator.mediaDevices.enumerateDevices()
      const cams = all.filter(d => d.kind === 'videoinput')
      if (cams.length === 0) return
      const curId = this._devices[this._deviceIdx]?.deviceId
      this._devices = cams
      if (curId) {
        const idx = cams.findIndex(d => d.deviceId === curId)
        if (idx >= 0) this._deviceIdx = idx
      }
      this.markDirty()
    } catch { /* enumeration unavailable — keep existing device list */ }
  }

  // Mobile: tapping a specific camera's big button selects and starts that
  // device directly, rather than stepping through prev/next.
  private async _selectCameraDevice(idx: number): Promise<void> {
    this._stopCurrentSource()
    this._sourceType = 'camera'
    this._deviceIdx  = idx
    if (this._devices.length === 0 || !this._devices[idx]) {
      await this._startCamera()
      return
    }
    await this._startCameraStream()
  }

  private async _startCamera(): Promise<void> {
    this._stopCurrentSource()
    this._sourceType = 'camera'

    if (this._devices.length === 0) {
      this._status = 'initialising…'
      this.markDirty()
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        probe.getTracks().forEach(t => t.stop())
        const all = await navigator.mediaDevices.enumerateDevices()
        this._devices = all.filter(d => d.kind === 'videoinput')
      } catch {
        this._status = 'permission denied'
        this.markDirty()
        return
      }
      if (this._devices.length === 0) {
        this._status = 'no camera found'
        this.markDirty()
        return
      }
    }

    await this._startCameraStream()
  }

  private async _startCameraStream(): Promise<void> {
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop())
      this._stream = null
    }
    this._video.srcObject = null
    this._prevVideoTime    = -1
    this._frozenFrameCount = 0
    this._streamHadFrames  = false
    this._cameraStalled    = false

    const device = this._devices[this._deviceIdx]
    if (!device) return

    this._status = 'starting…'
    this.markDirty()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: device.deviceId ? { deviceId: { exact: device.deviceId } } : true,
        audio: false,
      })
      this._stream = stream
      this._video.srcObject = stream
      await this._video.play()
      this._status = 'live'
      this.markDirty()
      void this._autoDetectMirror()
      void this._refreshDeviceList()
    } catch {
      this._status = 'camera error'
      this.markDirty()
    }
  }

  // Runs once after each camera stream starts. Shows a cartoon-face overlay
  // while searching, turning green (mirror on) or red (not found).
  //
  // Strategy:
  //   1. MediaStreamTrack.getSettings().facingMode — reliable on mobile
  //      ('user' = front, 'environment' = rear), usually absent on desktop.
  //   2. HAAR Viola-Jones detector — cascade data embedded in faceCascade.ts,
  //      no network required, works in every browser.
  private async _autoDetectMirror(): Promise<void> {
    this._canvasFaces = []
    this._setFaceDetectState('scanning', 'scanning…')

    // ── Step 1: facingMode from the MediaStreamTrack ──────────────
    const track      = this._stream?.getVideoTracks()[0]
    const facingMode = track?.getSettings().facingMode
    if (facingMode === 'user') {
      this._mirrored = true
      this._setFaceDetectState('found', 'front camera — mirror on', 2500)
      return
    }
    if (facingMode === 'environment') {
      this._mirrored = false
      this._setFaceDetectState('not-found', 'rear camera — mirror off', 2500)
      return
    }

    // ── Step 2: capture a frame ───────────────────────────────────
    // Wait up to 3 s for the first video frame.
    for (let i = 0; i < 30; i++) {
      if (this._video.readyState >= 2 && this._video.videoWidth > 0) break
      await new Promise(r => setTimeout(r, 100))
    }
    if (this._sourceType !== 'camera' || this._video.readyState < 2) {
      this._setFaceDetectState('idle', ''); return
    }

    const vw = this._video.videoWidth
    const vh = this._video.videoHeight
    if (!vw || !vh) { this._setFaceDetectState('idle', ''); return }

    // Downscale to at most 320×240 for speed.
    const detScale = Math.min(1, 320 / vw, 240 / vh)
    const detW     = Math.round(vw * detScale)
    const detH     = Math.round(vh * detScale)
    const canvas   = new OffscreenCanvas(detW, detH)
    const fctx     = canvas.getContext('2d')!
    fctx.drawImage(this._video, 0, 0, detW, detH)
    const rgba = fctx.getImageData(0, 0, detW, detH).data

    if (this._sourceType !== 'camera') { this._setFaceDetectState('idle', ''); return }

    // ── Step 2a: skin-tone detection (fast, high recall) ─────────
    // Counts pixels in the Cb/Cr skin band (Tsekeridou & Pitas 1998).
    // Works at any face size; false positives (wood, fabric) are acceptable.
    let skinResult: SkinResult | null = detectSkin(rgba, detW, detH)

    // ── Step 2b: HAAR cascade fallback ────────────────────────────
    // If skin detection finds nothing, try the Viola-Jones cascade.
    // It's more precise but requires the face to fill a larger portion of frame.
    let haarFound = false
    if (!skinResult) {
      const gray  = rgbaToGray(rgba, detW * detH)
      const faces = detectFaces(gray, detW, detH)
      haarFound   = faces.length > 0
      if (haarFound) {
        const dW  = this._displayW > 0 ? this._displayW : Node.viewportWidth
        const dH  = this._displayH > 0 ? this._displayH : Node.viewportHeight
        const ox  = this._displayW > 0 ? this._cx : Node.viewportWidth  / 2
        const oy  = this._displayH > 0 ? this._cy : Node.viewportHeight / 2
        this._mirrored = true
        this._canvasFaces = faces.map(f => ({
          cx:     ox + ((f.x + f.width  / 2) / detW - 0.5) * dW,
          cy:     oy + ((f.y + f.height / 2) / detH - 0.5) * dH,
          radius: (f.width / detW) * dW * 0.5,
        }))
      }
    }

    const found = skinResult !== null || haarFound
    this._mirrored = found

    if (skinResult !== null) {
      // Map skin centroid from detection image → canvas display coordinates.
      const dW  = this._displayW > 0 ? this._displayW : Node.viewportWidth
      const dH  = this._displayH > 0 ? this._displayH : Node.viewportHeight
      const ox  = this._displayW > 0 ? this._cx : Node.viewportWidth  / 2
      const oy  = this._displayH > 0 ? this._cy : Node.viewportHeight / 2
      const mir = -1  // mirror is now on
      this._canvasFaces = [{
        cx:     ox + (skinResult.cx / detW - 0.5) * dW * mir,
        cy:     oy + (skinResult.cy / detH - 0.5) * dH,
        radius: skinResult.radius / detW * dW,
      }]
    }

    this._setFaceDetectState(
      found ? 'found' : 'not-found',
      found ? 'face found — mirror on' : 'no face — mirror off',
      2500,
    )
  }

  private _setFaceDetectState(
    state: 'idle' | 'scanning' | 'found' | 'not-found',
    msg: string,
    clearAfterMs?: number,
  ): void {
    if (this._faceDetectTimer !== null) { clearTimeout(this._faceDetectTimer); this._faceDetectTimer = null }
    this._faceDetectState = state
    this._faceDetectMsg   = msg
    this.markDirty()
    if (clearAfterMs !== undefined) {
      this._faceDetectTimer = setTimeout(() => {
        this._faceDetectState = 'idle'
        this._faceDetectTimer = null
        this.markDirty()
      }, clearAfterMs)
    }
  }

  private _renderFaceDetectOverlay(ctx: Ctx2D): void {
    const cw    = Node.canvasWidth
    const ch    = Node.canvasHeight
    const state = this._faceDetectState

    // When a face was found, draw the cartoon at the detected position.
    // Otherwise centre it on the canvas.
    const face0  = this._canvasFaces[0]
    const hasPos = state === 'found' && face0 !== undefined
    const cx  = hasPos ? face0!.cx     : cw / 2
    const cy  = hasPos ? face0!.cy     : ch / 2
    const R   = Math.min(cw, ch) * 0.04
    const lw  = Math.max(2, R * 0.055)

    const colour = state === 'found'     ? '#55ee77'
                 : state === 'not-found' ? '#ee5555'
                 : '#e8e8e8'

    ctx.save()

    // Dark backdrop disc
    ctx.fillStyle = 'rgba(0,0,0,0.12)'
    ctx.beginPath()
    ctx.arc(cx, cy, R * 1.35, 0, Math.PI * 2)
    ctx.fill()

    ctx.strokeStyle = colour
    ctx.fillStyle   = colour
    ctx.lineWidth   = lw
    ctx.lineCap     = 'round'
    ctx.globalAlpha = 0.25

    // Head circle
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.stroke()

    // Eyes
    const eyeR = R * 0.10
    const eyeY = cy - R * 0.20
    ctx.beginPath(); ctx.arc(cx - R * 0.30, eyeY, eyeR, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(cx + R * 0.30, eyeY, eyeR, 0, Math.PI * 2); ctx.fill()

    // Mouth
    const mouthR = R * 0.36
    if (state === 'found') {
      ctx.beginPath()
      ctx.arc(cx, cy + R * 0.12, mouthR, 0.15 * Math.PI, 0.85 * Math.PI)
      ctx.stroke()
    } else if (state === 'not-found') {
      ctx.beginPath()
      ctx.arc(cx, cy + R * 0.55, mouthR, 1.15 * Math.PI, 1.85 * Math.PI)
      ctx.stroke()
    } else {
      // Scanning — neutral mouth + animated horizontal scan line
      ctx.beginPath()
      ctx.moveTo(cx - mouthR, cy + R * 0.38)
      ctx.lineTo(cx + mouthR, cy + R * 0.38)
      ctx.stroke()

      const t     = (Date.now() % 1400) / 1400
      const scanY = cy - R + t * R * 2
      const halfW = Math.sqrt(Math.max(0, R * R - (scanY - cy) ** 2))
      if (halfW > 2) {
        ctx.globalAlpha = 0.25
        ctx.lineWidth   = lw * 0.6
        ctx.setLineDash([Math.max(3, R * 0.08), Math.max(3, R * 0.08)])
        ctx.beginPath()
        ctx.moveTo(cx - halfW, scanY); ctx.lineTo(cx + halfW, scanY)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.lineWidth   = lw
        ctx.globalAlpha = 0.25
      }
    }

    // Label below the face
    ctx.globalAlpha  = 0.25
    ctx.font         = `${Math.max(11, Math.round(R * 0.21))}px monospace`
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(this._faceDetectMsg, cx, cy + R * 1.62)

    ctx.restore()
  }

  // ── Screen share source ───────────────────────────────────────

  private async _startScreenShare(): Promise<void> {
    this._stopCurrentSource()
    this._sourceType = 'screen'
    this._status = 'requesting…'
    this.markDirty()

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    } catch {
      this._sourceType = 'none'
      this._status = ''
      this.markDirty()
      return
    }

    this._stream = stream
    this._status = 'screen share'
    this._video.srcObject = stream

    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      this._stream = null
      this._video.srcObject = null
      this._sourceType = 'none'
      this._status = ''
      this.markDirty()
    })

    await this._video.play().catch(() => {})
    this.markDirty()
  }

  // ── File source ───────────────────────────────────────────────

  private _selectFileSource(): void {
    this._stopCurrentSource()
    this._sourceType = 'file'
    this.markDirty()
    if (this._objectUrl === null) {
      this._openFilePicker()
    } else {
      // Reattach the previously-loaded file (stream srcObject was cleared above).
      if (this._playing) void this._video.play().catch(() => {})
    }
  }

  private _openFilePicker(): void {
    const input = document.createElement('input')
    input.type   = 'file'
    input.accept = 'video/*'
    input.style.display = 'none'
    document.body.appendChild(input)
    input.onchange = () => {
      document.body.removeChild(input)
      const file = input.files?.[0]
      if (file) this.loadFile(file)
    }
    input.click()
  }

  // ── Shared helpers ─────────────────────────────────────────────

  private _stopCurrentSource(): void {
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop())
      this._stream = null
    }
    if (this._playing && this._objectUrl !== null) this._video.pause()
    this._video.srcObject = null
  }

  private _computeAutoFit(): void {
    const vw    = this._video.videoWidth  || 16
    const vh    = this._video.videoHeight || 9
    const sw    = Node.viewportWidth
    const sh    = Node.viewportHeight
    const scale = Math.min(sw / vw, sh / vh)   // contain / letterbox
    this._displayW = vw * scale
    this._displayH = vh * scale
    this._cx = sw / 2
    this._cy = sh / 2
  }

  private _computeFill(): void {
    const vw    = this._video.videoWidth  || 16
    const vh    = this._video.videoHeight || 9
    const sw    = Node.viewportWidth
    const sh    = Node.viewportHeight
    const scale = Math.max(sw / vw, sh / vh)   // cover / fill
    this._displayW = vw * scale
    this._displayH = vh * scale
    this._cx = sw / 2
    this._cy = sh / 2
  }

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
    } else if (this._sourceType === 'file') {
      this._togglePlay()
      this.markDirty()
    } else {
      this._frozen = !this._frozen
      this.markDirty()
    }
  }

  // ── Rendering ─────────────────────────────────────────────────

  renderSelf(ctx: Ctx2D): void {
    if (this._result !== null)
      ctx.drawImage(this._result as CanvasImageSource, 0, 0, Node.canvasWidth, Node.canvasHeight)
    if (this._cameraStalled) this._renderStalledOverlay(ctx)
    if (this._faceDetectState !== 'idle') this._renderFaceDetectOverlay(ctx)
  }

  private _renderStalledOverlay(ctx: Ctx2D): void {
    const cw = Node.canvasWidth
    const ch = Node.canvasHeight
    const cx = cw / 2
    const cy = ch / 2

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.50)'
    ctx.fillRect(0, 0, cw, ch)

    ctx.font         = '22px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('camera paused', cx, cy - 30)

    const btnW = 160, btnH = 38
    const btnX = cx - btnW / 2
    const btnY = cy + 10
    this._stallRestartBounds = { x: btnX, y: btnY, width: btnW, height: btnH }

    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    ctx.beginPath()
    ctx.roundRect(btnX, btnY, btnW, btnH, 8)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.roundRect(btnX + 0.5, btnY + 0.5, btnW - 1, btnH - 1, 8)
    ctx.stroke()

    const icY = btnY + btnH / 2
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    drawIcon(ctx, 'arrows-counter-clockwise', cx - 48, icY, 14)
    ctx.font         = '13px monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('restart camera', cx + 6, icY)

    ctx.restore()
  }

  // ── Big source-button grid layout ───────────────────────────────
  //
  // Desktop: always 3 buttons (camera/screen/file) in one row. Mobile: one
  // button per detected camera (min 1), wrapping into extra rows as needed.
  // Screen-share and file selection move into the smaller lower pill on
  // mobile, since they're less common sources there.

  private _bigButtonCount(): number {
    return Node.isMobileDevice ? Math.max(1, this._devices.length) : 3
  }

  private _bigGridRows(n: number, pillW: number): number {
    const availCols = Math.max(1, Math.floor((pillW - 2 * LG_MARGIN + LG_GAP) / (LG_SZ + LG_GAP)))
    const cols = Math.min(availCols, n)
    return Math.ceil(n / cols)
  }

  private _bigGridCells(n: number, pillX: number, pillW: number, top: number): BBox[] {
    const availCols = Math.max(1, Math.floor((pillW - 2 * LG_MARGIN + LG_GAP) / (LG_SZ + LG_GAP)))
    const cols = Math.min(availCols, n)
    const cells: BBox[] = []
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols), c = i % cols
      cells.push({
        x: pillX + LG_MARGIN + c * (LG_SZ + LG_GAP),
        y: top  + r * (LG_SZ + LG_GAP),
        width: LG_SZ, height: LG_SZ,
      })
    }
    return cells
  }

  private _sourcePillHeight(): number {
    const rows = this._bigGridRows(this._bigButtonCount(), panelWidth(Node.canvasWidth))
    const bigH = LG_MARGIN * 2 + rows * LG_SZ + (rows - 1) * LG_GAP
    return bigH + ROW_GAP + LOWER_H
  }

  override get canvasBounds() {
    return { ...super.canvasBounds, height: this._sourcePillHeight() }
  }

  override get panelBottom(): number {
    return 50 + this._sourcePillHeight() + 8
  }

  // Short label for a mobile camera-grid button: real label (trimmed) once
  // known, otherwise a numbered placeholder pre-permission.
  private _camLabel(i: number): string {
    if (this._devices.length === 0) return 'Camera'
    const label = this._devices[i]?.label
    if (!label) return `Cam ${i + 1}`
    const trimmed = label.replace(/\s*\(.*?\)\s*/g, '').trim()
    return trimmed.length > 9 ? trimmed.slice(0, 8) + '…' : trimmed
  }

  private _drawBigBtn(ctx: Ctx2D, b: BBox, icon: IconName, label: string, active: boolean): void {
    ctx.save()
    ctx.fillStyle = active ? ACCENT + '40' : 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 6)
    ctx.fill()
    if (active) {
      ctx.strokeStyle = ACCENT
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.roundRect(b.x + 0.75, b.y + 0.75, b.width - 1.5, b.height - 1.5, 6)
      ctx.stroke()
    }
    ctx.fillStyle = active ? '#ffffff' : 'rgba(255,255,255,0.65)'
    drawIcon(ctx, icon, b.x + b.width / 2, b.y + b.height * 0.40, Math.round(b.width * 0.40))
    ctx.font         = `${Math.max(9, Math.round(b.width * 0.13))}px monospace`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = active ? '#ffffff' : 'rgba(255,255,255,0.55)'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height - Math.max(10, b.height * 0.16))
    ctx.restore()
  }

  renderPanel(ctx: Ctx2D): void {
    this._drawStripPill(ctx, this.bounds)
    this._drawSourcePill(ctx, this.canvasBounds)
    if (this._sourceType === 'file') this._renderControlBar(ctx)
  }

  override renderOverlay(ctx: Ctx2D): void {
    if (this._sourceType !== 'none') this._renderHandles(ctx)
    drawSnapGuides(ctx, this._edgeSnapX, this._edgeSnapY, Node.canvasWidth, Node.canvasHeight)
    if (!this._addTrackDone && this._sourceType !== 'none') this._renderTrackBtn(ctx)
  }

  private _renderTrackBtn(ctx: Ctx2D): void {
    const left = contentLeft(Node.canvasWidth)
    const TRK_W = 56, TRK_H = 30, TRK_GAP = 14
    const x = left + Math.max(0, (Node.viewportWidth - left - TRK_W) / 2)
    const y = Node.viewportHeight - TRK_H - TRK_GAP
    this._trackBtnB = { x, y, width: TRK_W, height: TRK_H }

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath(); ctx.roundRect(x, y, TRK_W, TRK_H, 5); ctx.fill()
    ctx.fillStyle = '#cf7ecfcc'   // Point accent
    ctx.beginPath(); ctx.roundRect(x, y, 3, TRK_H, [5, 0, 0, 5]); ctx.fill()
    ctx.save()
    ctx.beginPath(); ctx.rect(x, y, TRK_W, TRK_H); ctx.clip()
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = '11px monospace'
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText('Track', x + 10, y + TRK_H / 2)
    ctx.restore(); ctx.restore()
  }

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const standard = this.slots.filter(s => s !== this.opacitySlot)
    this.renderSlotGroup(ctx, standard, this.panelBottom)

    // Toggle button drawn over the enableSlot row (index 0 in standard group)
    const SLOT_H   = 30
    const SLOT_GAP = 4
    const BTN_SZ   = SLOT_H - 6

    const { x: PANEL_X, width: PANEL_W } = this.canvasBounds
    const y    = this.panelBottom   // enableSlot is at index 0
    const midY = y + SLOT_H / 2
    const btnX = PANEL_X + PANEL_W - BTN_SZ - 3
    const btnY = y + 3

    this._toggleBounds = { x: btnX, y: btnY, width: BTN_SZ, height: BTN_SZ }

    const state       = this.enableSlot.state
    const isActive    = state === SlotState.Bound
    const isSuspended = state === SlotState.SuspendedBound

    ctx.save()
    ctx.fillStyle = isActive ? ACCENT + '33'
                  : isSuspended ? 'rgba(255,255,255,0.10)'
                  : 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(btnX, btnY, BTN_SZ, BTN_SZ, 3)
    ctx.fill()

    ctx.strokeStyle = isActive ? ACCENT + '99' : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    if (isSuspended) ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.roundRect(btnX + 0.5, btnY + 0.5, BTN_SZ - 1, BTN_SZ - 1, 3)
    ctx.stroke()
    ctx.setLineDash([])

    const paused = (this._sourceType === 'file' && !this._playing) ||
                   ((this._sourceType === 'camera' || this._sourceType === 'screen') && this._frozen)
    ctx.fillStyle    = isActive ? ACCENT : isSuspended ? 'rgba(255,255,255,0.35)' : ACCENT
    drawIcon(ctx, paused ? 'pause' : 'record', btnX + BTN_SZ / 2, midY, BTN_SZ - 8)
    ctx.restore()

    // Opacity SliderSlot pill — below the standard slot group
    const ob = this._opacityPillBounds()
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(ob.x, ob.y, ob.width, ob.height, 6)
    ctx.fill()
    ctx.restore()
    this._slotBounds.set(this.opacitySlot, ob)
    this._opacityWidget.render(ctx, ob)
  }

  private _opacityPillBounds() {
    const cb = this.canvasBounds
    const standard = this.slots.filter(s => s !== this.opacitySlot)
    const standardH = standard.length * (30 + 4) - 4
    return { x: cb.x, y: this.panelBottom + standardH + 8, width: cb.width, height: 30 }
  }

  // ── Transform handles ─────────────────────────────────────────

  private _handlePos() {
    const cos = Math.cos(this._rotation), sin = Math.sin(this._rotation)
    return {
      move:   { x: this._cx, y: this._cy },
      scale:  { x: this._cx + SCALE_OX * cos - SCALE_OY * sin,
                y: this._cy + SCALE_OX * sin + SCALE_OY * cos },
      rotate: { x: this._cx + ROT_ARM * sin,
                y: this._cy - ROT_ARM * cos },
    }
  }

  private _renderHandles(ctx: Ctx2D): void {
    if (this._displayW <= 0) return
    const cx = this._cx, cy = this._cy
    const hw = this._displayW / 2, hh = this._displayH / 2
    const hp = this._handlePos()

    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.80)'
    ctx.shadowBlur  = 5

    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(this._rotation)
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'
    ctx.lineWidth   = 1
    ctx.setLineDash([4, 4])
    ctx.strokeRect(-hw, -hh, this._displayW, this._displayH)
    ctx.restore()
    ctx.setLineDash([])

    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth   = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(cx, cy); ctx.lineTo(hp.rotate.x, hp.rotate.y)
    ctx.moveTo(cx, cy); ctx.lineTo(hp.scale.x,  hp.scale.y)
    ctx.stroke()
    ctx.setLineDash([])

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

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(hp.scale.x - HANDLE_SZ, hp.scale.y - HANDLE_SZ, HANDLE_SZ * 2, HANDLE_SZ * 2)
    ctx.strokeStyle = ACCENT
    ctx.lineWidth   = 1.5
    ctx.strokeRect(hp.scale.x - HANDLE_SZ + 0.5, hp.scale.y - HANDLE_SZ + 0.5,
                   HANDLE_SZ * 2 - 1, HANDLE_SZ * 2 - 1)

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
    if (this._drag !== null) return this
    if (this._stallRestartBounds !== null && boundingBoxContains(this._stallRestartBounds, point)) return this
    if (this._camBtnB     !== null && boundingBoxContains(this._camBtnB,     point)) return this
    for (const bb of this._camDeviceBtnB) if (boundingBoxContains(bb, point)) return this
    if (this._screenBtnB  !== null && boundingBoxContains(this._screenBtnB,  point)) return this
    if (this._fileBtnB    !== null && boundingBoxContains(this._fileBtnB,    point)) return this
    if (this._prevBtnB    !== null && boundingBoxContains(this._prevBtnB,    point)) return this
    if (this._nextBtnB    !== null && boundingBoxContains(this._nextBtnB,    point)) return this
    if (this._loadBtnB    !== null && boundingBoxContains(this._loadBtnB,    point)) return this
    if (this._fitBtnB     !== null && boundingBoxContains(this._fitBtnB,     point)) return this
    if (this._mirrorBtnB  !== null && boundingBoxContains(this._mirrorBtnB,  point)) return this
    if (this._playBtnB    !== null && boundingBoxContains(this._playBtnB,    point)) return this
    if (this._trackBtnB   !== null && boundingBoxContains(this._trackBtnB,   point)) return this
    if (this._scrubHit(point)) return this
    if (this._toggleBounds !== null && boundingBoxContains(this._toggleBounds, point)) return this
    if (this._displayW > 0) {
      const hp = this._handlePos()
      if (ptDist(point, hp.move)   <= HANDLE_HIT) return this
      if (ptDist(point, hp.scale)  <= HANDLE_HIT) return this
      if (ptDist(point, hp.rotate) <= HANDLE_HIT) return this
    }
    if (this._opacityWidget.hitZone(point, this._opacityPillBounds()) !== null) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    // Stall-restart button (visible in renderSelf overlay, works in any mode)
    if (this._stallRestartBounds !== null && boundingBoxContains(this._stallRestartBounds, point)) {
      if (this._devices.length > 0) void this._startCameraStream()
      else void this._startCamera()
      return true
    }
    // Source selector
    if (this._camBtnB !== null && boundingBoxContains(this._camBtnB, point)) {
      if (this._sourceType !== 'camera') void this._startCamera()
      return true
    }
    for (let i = 0; i < this._camDeviceBtnB.length; i++) {
      if (boundingBoxContains(this._camDeviceBtnB[i]!, point)) {
        void this._selectCameraDevice(i)
        return true
      }
    }
    if (this._screenBtnB !== null && boundingBoxContains(this._screenBtnB, point)) {
      if (this._sourceType === 'screen') {
        this._stopCurrentSource()
        this._sourceType = 'none'
        this._status = ''
        this.markDirty()
      } else {
        void this._startScreenShare()
      }
      return true
    }
    if (this._fileBtnB !== null && boundingBoxContains(this._fileBtnB, point)) {
      if (this._sourceType === 'file') {
        this._openFilePicker()  // already on file — load a new file
      } else {
        this._selectFileSource()
      }
      return true
    }
    // Camera nav
    if (this._prevBtnB !== null && boundingBoxContains(this._prevBtnB, point)) {
      if (this._devices.length > 1) {
        this._deviceIdx = (this._deviceIdx + this._devices.length - 1) % this._devices.length
        void this._startCameraStream()
      }
      return true
    }
    if (this._nextBtnB !== null && boundingBoxContains(this._nextBtnB, point)) {
      if (this._devices.length > 1) {
        this._deviceIdx = (this._deviceIdx + 1) % this._devices.length
        void this._startCameraStream()
      }
      return true
    }
    // Mirror toggle
    if (this._mirrorBtnB !== null && boundingBoxContains(this._mirrorBtnB, point)) {
      this._mirrored = !this._mirrored
      this.markDirty()
      return true
    }
    // Fit/fill toggle — clears manualTransform and resets view pan/zoom
    if (this._fitBtnB !== null && boundingBoxContains(this._fitBtnB, point)) {
      this._fillMode        = !this._fillMode
      this._manualTransform = false
      this._rotation        = 0
      Node.resetViewTransform?.()
      this.markDirty()
      return true
    }
    // File controls
    if (this._loadBtnB !== null && boundingBoxContains(this._loadBtnB, point)) {
      this._openFilePicker()
      return true
    }
    if (this._playBtnB !== null && boundingBoxContains(this._playBtnB, point)) {
      this._handleToggle()
      return true
    }
    if (this._scrubHit(point)) { this._beginScrub(point); return true }
    // Toggle slot button
    if (this._toggleBounds !== null && boundingBoxContains(this._toggleBounds, point)) {
      this._handleToggle()
      return true
    }
    if (this._trackBtnB !== null && boundingBoxContains(this._trackBtnB, point)) {
      this._onAddTrack?.()
      this._addTrackDone = true
      return true
    }
    // Transform handles
    if (this._displayW > 0) {
      const hp = this._handlePos()
      if (ptDist(point, hp.rotate) <= HANDLE_HIT) {
        this._drag = { type: 'rotate', center: { x: this._cx, y: this._cy },
                       startAngle: Math.atan2(point.y - this._cy, point.x - this._cx),
                       startRot: this._rotation }
        this._manualTransform = true; return true
      }
      if (ptDist(point, hp.scale) <= HANDLE_HIT) {
        this._drag = { type: 'scale', center: { x: this._cx, y: this._cy },
                       startDist: Math.max(1, ptDist(point, { x: this._cx, y: this._cy })),
                       startW: this._displayW, startH: this._displayH }
        this._manualTransform = true; return true
      }
      if (ptDist(point, hp.move) <= HANDLE_HIT) {
        this._drag = { type: 'move', startMouse: { ...point },
                       startCX: this._cx, startCY: this._cy }
        this._manualTransform = true; return true
      }
    }
    if (this._opacityWidget.hitZone(point, this._opacityPillBounds()) !== null) {
      return this._opacityWidget.handlePointerDown(point, this._opacityPillBounds())
    }
    return false
  }

  handlePointerMove(point: Point): void {
    if (this._opacityWidget.isDragging) {
      this._opacityWidget.handlePointerMove(point, this._opacityPillBounds())
      return
    }
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
        const f = Math.max(1, ptDist(point, this._drag.center)) / this._drag.startDist
        this._displayW = Math.max(MIN_VW, this._drag.startW * f)
        this._displayH = Math.max(MIN_VH, this._drag.startH * f)
      } else {
        this._rotation = this._drag.startRot +
          Math.atan2(point.y - this._drag.center.y, point.x - this._drag.center.x) -
          this._drag.startAngle
      }
      this.markDirty(); return
    }
    if (this._scrubbing) this._seekFromPointer(point)
  }

  handlePointerUp(): void {
    this._opacityWidget.handlePointerUp()
    if (this._drag !== null) {
      this._drag = null
      this._edgeSnapX = null
      this._edgeSnapY = null
      return
    }
    if (!this._scrubbing) return
    this._scrubbing  = false
    this._previewTime = null
    if (this._wasPlayingBeforeScrub) void this._video.play().catch(() => {})
    this.markDirty()
  }

  // ── Scrub ─────────────────────────────────────────────────────

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

  private _capturePreviewFrame(): void {
    const v = this._previewVideo
    if (v.readyState < 2 /* HAVE_CURRENT_DATA */) return
    const vw = v.videoWidth, vh = v.videoHeight
    if (!vw || !vh) return
    if (!this._previewCanvas || this._previewCanvas.width !== THUMB_W ||
        this._previewCanvas.height !== THUMB_H)
      this._previewCanvas = new OffscreenCanvas(THUMB_W, THUMB_H)
    const ctx = this._previewCanvas.getContext('2d')!
    ctx.clearRect(0, 0, THUMB_W, THUMB_H)
    const scale = Math.min(THUMB_W / vw, THUMB_H / vh)
    const dw = vw * scale, dh = vh * scale
    ctx.drawImage(v, (THUMB_W - dw) / 2, (THUMB_H - dh) / 2, dw, dh)
    this.markDirty()
  }

  // ── Drawing ───────────────────────────────────────────────────

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
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.font = '11px monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Video', x + 12, y + height / 2)

    // Opacity slot indicator
    const midY  = y + height / 2
    const active = this.opacitySlot.isActive
    ctx.font      = '9px monospace'
    ctx.textAlign = 'right'
    ctx.fillStyle = active ? AM_COL : 'rgba(255,255,255,0.22)'
    ctx.fillText(active ? '●' : '○', x + width - 8, midY)
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.fillText('α', x + width - 20, midY)

    ctx.restore()
  }

  private _drawSourcePill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width } = b
    if (width <= 0) return
    const mobile = Node.isMobileDevice

    const n    = this._bigButtonCount()
    const rows = this._bigGridRows(n, width)
    const bigH = LG_MARGIN * 2 + rows * LG_SZ + (rows - 1) * LG_GAP
    const upperB: BBox = { x, y, width, height: bigH }
    const lowerB: BBox = { x, y: y + bigH + ROW_GAP, width, height: LOWER_H }

    ctx.save()

    // ── Upper pill — big source-selector buttons ──────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(upperB.x, upperB.y, upperB.width, upperB.height, 8)
    ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(upperB.x, upperB.y, STRIPE, upperB.height, [4, 0, 0, 4])
    ctx.fill()

    const cells = this._bigGridCells(n, upperB.x, upperB.width, upperB.y + LG_MARGIN)

    if (mobile) {
      this._camBtnB       = null
      this._camDeviceBtnB = cells
      for (let i = 0; i < n; i++) {
        const active = this._sourceType === 'camera' && this._deviceIdx === i
        this._drawBigBtn(ctx, cells[i]!, 'video-camera', this._camLabel(i), active)
      }
    } else {
      this._camDeviceBtnB = []
      const specs: [SourceType, IconName, string][] = [
        ['camera', 'video-camera', 'Camera'],
        ['screen', 'monitor',      'Screen'],
        ['file',   'folder-open',  'File'],
      ]
      for (let i = 0; i < 3; i++) {
        const [type, icon, label] = specs[i]!
        const bb = cells[i]!
        if (type === 'camera') this._camBtnB    = bb
        if (type === 'screen') this._screenBtnB = bb
        if (type === 'file')   this._fileBtnB   = bb
        this._drawBigBtn(ctx, bb, icon, label, this._sourceType === type)
      }
    }

    // ── Lower pill — secondary controls ────────────────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(lowerB.x, lowerB.y, lowerB.width, lowerB.height, Math.min(lowerB.height / 2, 8))
    ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(lowerB.x, lowerB.y, STRIPE, lowerB.height, [4, 0, 0, 4])
    ctx.fill()

    const midY = lowerB.y + lowerB.height / 2

    // Fit/fill and mirror toggle buttons — far right, always visible
    const FIT_W = 28
    const FIT_M = 4
    const fitX  = lowerB.x + lowerB.width - FIT_M - FIT_W
    const fitY  = lowerB.y + (lowerB.height - SRC_W) / 2
    this._fitBtnB = { x: fitX, y: fitY, width: FIT_W, height: SRC_W }

    ctx.fillStyle = this._fillMode ? ACCENT + '40' : 'rgba(255,255,255,0.06)'
    ctx.beginPath()
    ctx.roundRect(fitX, fitY, FIT_W, SRC_W, 4)
    ctx.fill()
    if (this._fillMode) {
      ctx.strokeStyle = ACCENT
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.roundRect(fitX + 0.5, fitY + 0.5, FIT_W - 1, SRC_W - 1, 4)
      ctx.stroke()
    }
    ctx.font         = '9px monospace'
    ctx.fillStyle    = this._fillMode ? ACCENT : 'rgba(255,255,255,0.45)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(this._fillMode ? 'fill' : 'fit', fitX + FIT_W / 2, fitY + SRC_W / 2)

    // Mirror toggle [↔] — to the left of the fit button
    const mirX = fitX - MIR_GAP - MIR_W
    this._mirrorBtnB = { x: mirX, y: fitY, width: MIR_W, height: SRC_W }

    ctx.fillStyle = this._mirrored ? ACCENT + '40' : 'rgba(255,255,255,0.06)'
    ctx.beginPath()
    ctx.roundRect(mirX, fitY, MIR_W, SRC_W, 4)
    ctx.fill()
    if (this._mirrored) {
      ctx.strokeStyle = ACCENT
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.roundRect(mirX + 0.5, fitY + 0.5, MIR_W - 1, SRC_W - 1, 4)
      ctx.stroke()
    }
    ctx.fillStyle = this._mirrored ? ACCENT : 'rgba(255,255,255,0.45)'
    drawIcon(ctx, 'arrows-left-right', mirX + MIR_W / 2, fitY + SRC_W / 2, SRC_W - 10)

    // Left side of the lower pill: on mobile, small screen/file selector
    // buttons (deprioritised — camera has its own big buttons above); on
    // desktop, straight into source-specific status/controls.
    let leftX = lowerB.x + SRC_L

    if (mobile) {
      const smallSpecs: [SourceType, IconName][] = [['screen', 'monitor'], ['file', 'folder-open']]
      this._screenBtnB = this._fileBtnB = null
      for (let i = 0; i < smallSpecs.length; i++) {
        const [type, icon] = smallSpecs[i]!
        const bx = leftX + i * (SRC_W + SRC_GAP)
        const bb: BBox = { x: bx, y: fitY, width: SRC_W, height: SRC_W }
        if (type === 'screen') this._screenBtnB = bb
        if (type === 'file')   this._fileBtnB   = bb

        const active = this._sourceType === type
        ctx.fillStyle = active ? ACCENT + '40' : 'rgba(255,255,255,0.08)'
        ctx.beginPath()
        ctx.roundRect(bx, fitY, SRC_W, SRC_W, 4)
        ctx.fill()
        if (active) {
          ctx.strokeStyle = ACCENT
          ctx.lineWidth   = 1
          ctx.beginPath()
          ctx.roundRect(bx + 0.5, fitY + 0.5, SRC_W - 1, SRC_W - 1, 4)
          ctx.stroke()
        }
        ctx.fillStyle = active ? '#ffffff' : 'rgba(255,255,255,0.55)'
        drawIcon(ctx, icon, bx + SRC_W / 2, fitY + SRC_W / 2, SRC_W - 10)
      }
      leftX = leftX + smallSpecs.length * (SRC_W + SRC_GAP) + 4
    }

    // Remaining middle section — source-specific controls/status
    const rightW = mirX - 4 - leftX

    if (rightW > 4) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(leftX, lowerB.y, rightW, lowerB.height)
      ctx.clip()

      ctx.font         = '10px monospace'
      ctx.textBaseline = 'middle'

      if (this._sourceType === 'camera') {
        if (mobile) {
          // Cameras are selected directly via the big buttons above —
          // just report current status here, no prev/next nav.
          const d    = this._devices[this._deviceIdx]
          const name = this._status !== 'live'
            ? this._status
            : (d?.label || `Camera ${this._deviceIdx + 1}`)
          ctx.fillStyle = 'rgba(255,255,255,0.80)'
          ctx.textAlign = 'left'
          ctx.fillText(name, leftX + 4, midY)
          this._prevBtnB = this._nextBtnB = this._loadBtnB = null
        } else {
          this._drawCameraControls(ctx, leftX, rightW, lowerB.y, lowerB.height, midY)
        }
      } else if (this._sourceType === 'screen') {
        ctx.fillStyle = 'rgba(255,255,255,0.80)'
        ctx.textAlign = 'left'
        ctx.fillText('screen share', leftX + 4, midY)
        this._prevBtnB = this._nextBtnB = this._loadBtnB = null
      } else if (this._sourceType === 'file') {
        this._drawFileControls(ctx, leftX, rightW, lowerB.y, lowerB.height, midY)
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.30)'
        ctx.textAlign = 'left'
        ctx.fillText('select a source', leftX + 4, midY)
        this._prevBtnB = this._nextBtnB = this._loadBtnB = null
      }

      ctx.restore()
    }

    ctx.restore()
  }

  private _drawCameraControls(
    ctx: Ctx2D, rx: number, rw: number, py: number, ph: number, midY: number,
  ): void {
    const btnY = py + (ph - NAV_SZ) / 2
    const pb: BBox = { x: rx + NAV_M, y: btnY, width: NAV_SZ, height: NAV_SZ }
    const nb: BBox = { x: rx + rw - NAV_M - NAV_SZ, y: btnY, width: NAV_SZ, height: NAV_SZ }
    this._prevBtnB = pb
    this._nextBtnB = nb
    this._loadBtnB = null

    const canNav = this._devices.length > 1
    const col    = canNav ? ACCENT : 'rgba(255,255,255,0.20)'
    this._drawBtn(ctx, pb, '◀', col)

    const nameX = pb.x + NAV_SZ + 3
    const nameW = nb.x - nameX - 3
    if (nameW > 0) {
      const d    = this._devices[this._deviceIdx]
      const name = this._status !== 'live'
        ? this._status
        : (d?.label || `Camera ${this._deviceIdx + 1}`)
      ctx.fillStyle = 'rgba(255,255,255,0.80)'
      ctx.textAlign = 'left'
      ctx.fillText(name, nameX, midY)
    }

    this._drawBtn(ctx, nb, '▶', col)
  }

  private _drawFileControls(
    ctx: Ctx2D, rx: number, rw: number, py: number, ph: number, midY: number,
  ): void {
    const loadB: BBox = { x: rx + rw - BTN_M - BTN, y: py + (ph - BTN) / 2, width: BTN, height: BTN }
    this._loadBtnB = loadB
    this._prevBtnB = this._nextBtnB = null

    const textW = loadB.x - rx - 4
    if (textW > 0) {
      ctx.textAlign = 'left'
      if (this._objectUrl === null) {
        ctx.fillStyle = 'rgba(255,255,255,0.30)'
        ctx.fillText('no file loaded', rx + 4, midY)
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.85)'
        ctx.fillText(this._filename, rx + 4, midY - 5)
        ctx.fillStyle = 'rgba(255,255,255,0.45)'
        ctx.font      = '9px monospace'
        const vw = this._video.videoWidth, vh = this._video.videoHeight
        const dims = vw && vh ? `${vw}×${vh} · ` : ''
        ctx.fillText(`${dims}${this._status}`, rx + 4, midY + 5)
      }
    }

    this._drawBtn(ctx, loadB, '📁', 'rgba(255,255,255,0.75)')
  }

  private _renderControlBar(ctx: Ctx2D): void {
    if (this._objectUrl === null) {
      this._playBtnB = this._scrubTrackB = null
      return
    }

    const cw  = Node.canvasWidth
    const ch  = Node.canvasHeight
    const bar: BBox = { x: BAR_MARGIN, y: ch - BAR_H - BAR_MARGIN, width: cw - BAR_MARGIN * 2, height: BAR_H }
    if (bar.width <= 0) return

    const playB: BBox = { x: bar.x + 4, y: bar.y + (BAR_H - PLAY_SZ) / 2, width: PLAY_SZ, height: PLAY_SZ }
    const trackL = playB.x + PLAY_SZ + 12
    const trackR = bar.x + bar.width - 12 - TIME_W
    const track: BBox = { x: trackL, y: bar.y, width: Math.max(0, trackR - trackL), height: BAR_H }
    this._playBtnB    = playB
    this._scrubTrackB = track

    const trackY  = bar.y + BAR_H / 2
    const frac    = this._duration > 0 ? this._currentTime / this._duration : 0
    const handleX = track.x + Math.max(0, Math.min(1, frac)) * track.width

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(bar.x, bar.y, bar.width, BAR_H, BAR_H / 2)
    ctx.fill()

    ctx.beginPath()
    ctx.roundRect(playB.x, playB.y, PLAY_SZ, PLAY_SZ, PLAY_SZ / 2)
    ctx.fillStyle = 'rgba(255,255,255,0.10)'
    ctx.fill()
    ctx.fillStyle    = ACCENT
    drawIcon(ctx, this._playing ? 'pause' : 'play', playB.x + PLAY_SZ / 2, playB.y + PLAY_SZ / 2, 20)

    if (track.width > 0) {
      ctx.lineCap     = 'round'
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'
      ctx.lineWidth   = TRACK_H
      ctx.beginPath()
      ctx.moveTo(track.x, trackY); ctx.lineTo(track.x + track.width, trackY)
      ctx.stroke()
      ctx.strokeStyle = ACCENT
      ctx.beginPath()
      ctx.moveTo(track.x, trackY); ctx.lineTo(handleX, trackY)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(handleX, trackY, SCRUB_R, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'; ctx.fill()
      ctx.lineWidth = 1.5; ctx.strokeStyle = ACCENT; ctx.stroke()
    }

    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.65)'
    ctx.textAlign    = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${fmtTime(this._currentTime)} / ${fmtTime(this._duration)}`,
                 bar.x + bar.width - 12, trackY)

    ctx.restore()

    if (this._scrubbing && this._previewCanvas !== null) {
      const px = Math.max(4, Math.min(cw - THUMB_W - 4, handleX - THUMB_W / 2))
      const py = bar.y - THUMB_GAP - THUMB_H
      ctx.save()
      ctx.fillStyle = 'rgba(0,0,0,0.75)'
      ctx.beginPath()
      ctx.roundRect(px - 3, py - 3, THUMB_W + 6, THUMB_H + 6, 6)
      ctx.fill()
      ctx.drawImage(this._previewCanvas as CanvasImageSource, px, py, THUMB_W, THUMB_H)
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5
      ctx.strokeRect(px, py, THUMB_W, THUMB_H)
      ctx.restore()
    }
  }

  private _drawBtn(ctx: Ctx2D, b: BBox, label: string, colour: string): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    ctx.font         = '12px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }
}
