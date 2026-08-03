import { Layer } from '../core/Layer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  SlotState,
  boundingBoxContains,
  type ImageValue,     type ImageSource,
  type Point,          type PointSource,
  type Amount,         type AmountSource,
  type Direction,      type DirectionSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'
import { AngleSnapper } from '../interaction/AngleSnapper.js'
import { collectSnapEdges, snapPointToEdges, drawSnapGuides, EDGE_SNAP_THRESHOLD } from '../interaction/EdgeSnapper.js'
import { drawIcon, type IconName } from '../ui/icons.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'
import { SliderSlot } from '../ui/SliderSlot.js'

// ------------------------------------------------------------
// ImageLayer — loads and renders a bitmap image on the canvas
// ------------------------------------------------------------
//
// Implements ImageSource so downstream layers can consume the
// loaded bitmap via getImage().
//
// Acquire-image panel: while no bitmap is loaded, the top of the panel
// shows three big buttons — File, Paste, Camera — for getting an image in.
// Once a bitmap is loaded these are hidden entirely; to load a different
// image the user creates a new ImageLayer rather than replacing this one.
//
// Input slots:
//   positionSlot  (Point)  — canvas anchor (centre of image).
//                            Unbound default: canvas centre.
//   opacitySlot   (Amount) — globalAlpha [0, 1].
//                            Unbound default: 1.0.
//   scaleSlot     (Amount) — maps [0, 1] → [MIN_SCALE, MAX_SCALE].
//                            Unbound default: 1.0 (natural size).
//
// Transform handles (visible on canvas when slot is unbound):
//   ⊕  Move handle    — circle+crosshair at image centre; drag to reposition.
//   □  Scale handle   — square at lower-right; drag distance from centre to scale.
//   ○  Rotate handle  — circle above centre on a dashed arm; drag angle to rotate.
//   Handles glow brightly (shadowBlur) for visibility over any content.

const ACCENT     = '#7ecf7e'
const AM_COL     = '#4a8fe8'
const MIN_SCALE  = 0.05
const MAX_SCALE  = 4.0

// Acquire-image big-button row — shown only while no bitmap is loaded, in
// place of the old thin status pill. Sized like VideoLayer's source-picker
// row (three buttons: file / paste / camera).
const LG_SZ     = 72
const LG_GAP    = 6
const LG_MARGIN = 10

// Handle geometry
const HANDLE_R   = 7    // circle handle radius (px)
const HANDLE_SZ  = 6    // square handle half-size (px)
const ROT_ARM    = 85   // rotate handle arm length from centre (px)
const SCALE_OX   = 70   // scale handle offset in image-local x (px)
const SCALE_OY   = 70   // scale handle offset in image-local y (px)
const HANDLE_HIT = 14   // pointer hit-test radius (px)

// Angle snap — 8 positions every 45°, 15° threshold, 700 ms dwell to refine
const ROT_SNAP_ANGLES: readonly number[] = Array.from({ length: 8 }, (_, i) => i * Math.PI / 4)
const ROT_SNAP_THRESHOLD = Math.PI / 12
const ROT_SNAP_DWELL_MS  = 700
const ROT_SNAP_COL = '#7ecfcf'

// Bottom convenience buttons — "Clip" and "Filter"
const CONV_BTN_H   = 30
const CONV_BTN_W   = 60
const CONV_BTN_GAP = 14   // gap from bottom edge of viewport
const CONV_BTN_SEP = 8    // gap between the two buttons

type BBox = { x: number; y: number; width: number; height: number }

type DragState =
  | { type: 'move';   startMouse: Point; startPos: Point }
  | { type: 'scale';  startDist: number; startScale: number; center: Point }
  | { type: 'rotate'; startAngle: number; startRot: number; center: Point }

function ptDist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export class ImageLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _positionSlot: ParameterSlot
  private readonly _opacitySlot:  ParameterSlot
  private readonly _scaleSlot:    ParameterSlot
  private readonly _rotationSlot: ParameterSlot

  private _bitmap:     ImageValue      = null
  private _offscreen:  OffscreenCanvas = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)
  private _filename:   string          = ''
  private _natW:       number          = 0
  private _natH:       number          = 0
  private _dragOver:   boolean         = false

  // Acquire-image big buttons — set during renderPanel while _bitmap is
  // null, used for hit-testing; not relevant once an image is loaded.
  private _fileBtnB:   BBox | null = null
  private _pasteBtnB:  BBox | null = null
  private _cameraBtnB: BBox | null = null

  // Live camera preview — active between tapping "Camera" and either
  // taking the shot (shutter) or cancelling. Ephemeral: never persisted.
  private _cameraMode:      boolean            = false
  private _cameraStream:    MediaStream | null = null
  private _cameraVideo:     HTMLVideoElement | null = null
  private _cameraDevices:   MediaDeviceInfo[]  = []
  private _cameraDeviceIdx  = 0
  private _shutterBtnB:        BBox | null = null
  private _flipBtnB:           BBox | null = null
  private _cameraCancelBtnB:   BBox | null = null

  // Direct-manipulation state (persist across recompute when slot is unbound)
  private _rotation:       number       = 0
  private _manualPosition: Point | null = null
  private _manualScale:    number | null = null
  private _manualOpacity   = 1.0
  private _drag:           DragState | null = null

  private readonly _opacityWidget: SliderSlot

  private readonly _rotSnapper = new AngleSnapper(ROT_SNAP_ANGLES, ROT_SNAP_THRESHOLD, ROT_SNAP_DWELL_MS)
  private _snapSnapped  = false
  private _snapProgress = 0
  private _rotDwellTimer: ReturnType<typeof setInterval> | null = null

  // Edge snap guide lines
  private _edgeSnapX: number | null = null
  private _edgeSnapY: number | null = null

  // Bottom convenience buttons — set by main.ts after insertion/load
  private _onAddClip:    (() => void) | null = null
  private _onAddFilter:  (() => void) | null = null
  private _addClipDone   = false
  private _addFilterDone = false

  // Resolved values (updated in recompute)
  private _position: Point  = { x: Node.viewportWidth / 2, y: Node.viewportHeight / 2 }
  private _opacity:  number = 1.0
  private _scale:    number = 1.0

  constructor() {
    super()
    this._positionSlot = new ParameterSlot(ValueType.Point,     this)
    this._opacitySlot  = new ParameterSlot(ValueType.Amount,    this, 'opacity')
    this._scaleSlot    = new ParameterSlot(ValueType.Amount,    this, 'scale')
    this._rotationSlot = new ParameterSlot(ValueType.Direction, this)
    this.slots.push(this._positionSlot, this._opacitySlot, this._scaleSlot, this._rotationSlot)
    this._opacityWidget = new SliderSlot(
      this._opacitySlot, 'opacity', AM_COL,
      () => this._manualOpacity,
      (v) => {
        if (this._opacitySlot.state === SlotState.Bound) BindingLayer.findForSlot(this._opacitySlot)?.toggle()
        this._manualOpacity = v
        this.markDirty()
      },
      () => this.markDirty(),
    )
    this.debugName = 'ImageLayer'
    graph.register(this)
  }

  setOnAddClip(fn: () => void):   void { this._onAddClip   = fn }
  setOnAddFilter(fn: () => void): void { this._onAddFilter = fn }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._bitmap !== null ? this._offscreen : null }

  override getSnapBounds() {
    if (this._bitmap === null || this._natW === 0 || this._natH === 0) return null
    const halfW = this._natW * this._scale / 2
    const halfH = this._natH * this._scale / 2
    const cosA  = Math.cos(this._rotation), sinA = Math.sin(this._rotation)
    const { x, y } = this._position
    const extX  = Math.abs(halfW * cosA) + Math.abs(halfH * sinA)
    const extY  = Math.abs(halfW * sinA) + Math.abs(halfH * cosA)
    return { minX: x - extX, maxX: x + extX, minY: y - extY, maxY: y + extY }
  }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get positionSlot():  ParameterSlot { return this._positionSlot }
  get opacitySlot():   ParameterSlot { return this._opacitySlot  }
  get scaleSlot():     ParameterSlot { return this._scaleSlot    }
  get rotationSlot():  ParameterSlot { return this._rotationSlot }
  get opacityWidget(): SliderSlot    { return this._opacityWidget }

  // Seed a newly-created layer (via slot-click-to-create) with the value
  // currently shown by the corresponding manual control, so the binding
  // starts as a no-op.
  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | null {
    if (slot === this._positionSlot)  return this._manualPosition ?? this._position
    if (slot === this._opacitySlot)   return this._manualOpacity
    if (slot === this._scaleSlot) {
      const scale = this._manualScale ?? this._scale
      return Math.max(0, Math.min(1, (scale - MIN_SCALE) / (MAX_SCALE - MIN_SCALE)))
    }
    if (slot === this._rotationSlot)  return { angle: this._rotation, magnitude: 1 }
    return null
  }

  // ----------------------------------------------------------
  // Image loading
  // ----------------------------------------------------------

  // Common landing point for every acquisition path (file, paste, camera):
  // swaps in the new bitmap and, on mobile, fits it to the viewport so it's
  // fully visible in the current orientation. The default position
  // (viewport centre) already centres it — only the scale needs setting.
  private _adoptBitmap(bitmap: ImageBitmap, filename: string): void {
    this._bitmap?.close()
    this._bitmap   = bitmap
    this._filename = filename
    this._natW     = bitmap.width
    this._natH     = bitmap.height
    if (Node.isMobileDevice && bitmap.width > 0 && bitmap.height > 0) {
      const fitScale = Math.min(
        Node.viewportWidth  / bitmap.width,
        Node.viewportHeight / bitmap.height,
      )
      this._manualScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fitScale))
    }
    this.markDirty()
  }

  async loadFile(file: File): Promise<void> {
    try {
      const bitmap = await createImageBitmap(file)
      this._adoptBitmap(bitmap, file.name)
    } catch {
      // Unsupported format or decode error — leave previous bitmap intact.
    }
  }

  openFilePicker(): void {
    const input = document.createElement('input')
    input.type   = 'file'
    input.accept = 'image/*'
    input.style.display = 'none'
    document.body.appendChild(input)
    input.onchange = () => {
      const file = input.files?.[0]
      document.body.removeChild(input)
      if (file) this.loadFile(file)
    }
    input.click()
  }

  // Reads the system clipboard for an image and adopts it. Requires a user
  // gesture (called from the Paste button's click handler) and may prompt
  // for clipboard-read permission.
  private async _pasteFromClipboard(): Promise<void> {
    if (!navigator.clipboard?.read) return
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const type = item.types.find(t => t.startsWith('image/'))
        if (type === undefined) continue
        const blob   = await item.getType(type)
        const bitmap = await createImageBitmap(blob)
        this._adoptBitmap(bitmap, 'Pasted image')
        return
      }
    } catch {
      // Permission denied, or nothing image-like on the clipboard — no-op.
    }
  }

  // ── Live camera preview + capture ──────────────────────────────
  //
  // Tapping "Camera" on the acquire row opens a live preview — replacing
  // the acquire row with a shutter + flip-camera control — rather than
  // snapping immediately, so the user can see and frame the shot first.

  private async _startCameraPreview(): Promise<void> {
    if (this._cameraDevices.length === 0) {
      try {
        const all = await navigator.mediaDevices.enumerateDevices()
        this._cameraDevices = all.filter(d => d.kind === 'videoinput')
      } catch {
        // Enumeration unavailable — fall through and request the default camera.
      }
    }
    await this._openCameraStream()
  }

  private async _openCameraStream(): Promise<void> {
    this._stopCameraStream()
    const device = this._cameraDevices[this._cameraDeviceIdx]
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: device?.deviceId ? { deviceId: { exact: device.deviceId } } : true,
        audio: false,
      })
      const video = document.createElement('video')
      video.playsInline = true
      video.muted        = true
      video.srcObject     = stream
      await video.play()
      this._cameraStream = stream
      this._cameraVideo  = video
      this._cameraMode   = true
      this.markDirty()
      void this._refreshCameraDeviceList()
    } catch {
      // Permission denied, no camera, or the flip target vanished — fall
      // back to the acquire row rather than leaving a blank preview.
      this._cameraMode = false
      this.markDirty()
    }
  }

  // Silent re-enumeration after permission is granted: device labels/ids
  // are blank pre-permission in most browsers, so the flip button and
  // device cycling need this to identify cameras properly.
  private async _refreshCameraDeviceList(): Promise<void> {
    try {
      const all  = await navigator.mediaDevices.enumerateDevices()
      const cams = all.filter(d => d.kind === 'videoinput')
      if (cams.length === 0) return
      const curId = this._cameraDevices[this._cameraDeviceIdx]?.deviceId
      this._cameraDevices = cams
      if (curId) {
        const idx = cams.findIndex(d => d.deviceId === curId)
        if (idx >= 0) this._cameraDeviceIdx = idx
      }
      this.markDirty()
    } catch {
      // Ignore — keep the existing device list.
    }
  }

  private _flipCamera(): void {
    if (this._cameraDevices.length < 2) return
    this._cameraDeviceIdx = (this._cameraDeviceIdx + 1) % this._cameraDevices.length
    void this._openCameraStream()
  }

  private _stopCameraStream(): void {
    if (this._cameraStream !== null) {
      this._cameraStream.getTracks().forEach(t => t.stop())
      this._cameraStream = null
    }
    this._cameraVideo = null
  }

  private _cancelCameraPreview(): void {
    this._stopCameraStream()
    this._cameraMode = false
    this.markDirty()
  }

  private async _captureShutter(): Promise<void> {
    const video = this._cameraVideo
    if (video === null || video.videoWidth === 0) return
    const vw = video.videoWidth, vh = video.videoHeight
    const canvas = new OffscreenCanvas(vw, vh)
    canvas.getContext('2d')!.drawImage(video, 0, 0, vw, vh)
    const bitmap = await createImageBitmap(canvas)
    this._stopCameraStream()
    this._cameraMode = false
    this._adoptBitmap(bitmap, 'Camera capture')
  }

  setDragOver(v: boolean): void {
    if (this._dragOver !== v) {
      this._dragOver = v
      this.markDirty()
    }
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    this._position = this._positionSlot.isActive
      ? (this._positionSlot.source as PointSource).getPoint()
      : this._manualPosition ?? { x: Node.viewportWidth / 2, y: Node.viewportHeight / 2 }

    this._opacity = this._opacitySlot.isActive
      ? (this._opacitySlot.source as AmountSource).getAmount() as Amount
      : this._manualOpacity

    if (this._scaleSlot.isActive) {
      const t = (this._scaleSlot.source as AmountSource).getAmount() as Amount
      this._scale = MIN_SCALE + t * (MAX_SCALE - MIN_SCALE)
    } else {
      this._scale = this._manualScale ?? 1.0
    }

    if (this._rotationSlot.isActive) {
      this._rotation = (this._rotationSlot.source as DirectionSource).getDirection().angle
    }

    this._updateOffscreen()

    // Keep recomputing every frame while the live camera preview is active,
    // so renderSelf (which reads the <video> element directly) stays fresh.
    if (this._cameraMode) {
      queueMicrotask(() => {
        if (this._cameraMode) this.forceDirty()
      })
    }
  }

  private _updateOffscreen(): void {
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    if (this._offscreen.width !== w || this._offscreen.height !== h) {
      this._offscreen = new OffscreenCanvas(w, h)
    }
    const ctx = this._offscreen.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    if (this._bitmap === null) return
    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, this._opacity))
    ctx.translate(this._position.x, this._position.y)
    ctx.rotate(this._rotation)
    const bw = this._natW * this._scale
    const bh = this._natH * this._scale
    ctx.drawImage(this._bitmap, -bw / 2, -bh / 2, bw, bh)
    ctx.restore()
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      bitmap:         this._bitmap,
      filename:       this._filename,
      natW:           this._natW,
      natH:           this._natH,
      rotation:       this._rotation,
      manualPosition: this._manualPosition,
      manualScale:    this._manualScale,
      addClipDone:    this._addClipDone,
      addFilterDone:  this._addFilterDone,
      manualOpacity:  this._manualOpacity,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (state.bitmap instanceof ImageBitmap) this._bitmap = state.bitmap
    if (typeof state.filename === 'string') this._filename = state.filename
    if (typeof state.natW === 'number') this._natW = state.natW
    if (typeof state.natH === 'number') this._natH = state.natH
    if (typeof state.rotation === 'number') this._rotation = state.rotation
    if (state.manualPosition && typeof state.manualPosition === 'object') {
      this._manualPosition = state.manualPosition as Point
    }
    if (typeof state.addClipDone   === 'boolean') this._addClipDone   = state.addClipDone
    if (typeof state.addFilterDone === 'boolean') this._addFilterDone = state.addFilterDone
    if (typeof state.manualScale   === 'number')  this._manualScale   = state.manualScale
    if (typeof state.manualOpacity === 'number')  this._manualOpacity = state.manualOpacity
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    // Live camera preview replaces the convenience buttons / handles /
    // acquire row while active — but the opacity slot row below is still
    // reachable, so this falls through rather than returning early.
    if (this._cameraMode) {
      if (this._shutterBtnB !== null && boundingBoxContains(this._shutterBtnB, point)) {
        void this._captureShutter()
        return true
      }
      if (this._flipBtnB !== null && boundingBoxContains(this._flipBtnB, point)) {
        this._flipCamera()
        return true
      }
      if (this._cameraCancelBtnB !== null && boundingBoxContains(this._cameraCancelBtnB, point)) {
        this._cancelCameraPreview()
        return true
      }
    } else {
      // Convenience buttons take priority over handles
      if (this._convBtnHitTest(point, 'clip')) {
        this._onAddClip?.()
        return true
      }
      if (this._convBtnHitTest(point, 'filter')) {
        this._addFilterDone = true
        this._onAddFilter?.()
        return true
      }

      const hp = this._handlePos()

      // Rotate handle — suspends rotationSlot binding (if any) and takes manual control
      if (ptDist(point, hp.rotate) <= HANDLE_HIT) {
        if (this._rotationSlot.state === SlotState.Bound) {
          BindingLayer.findForSlot(this._rotationSlot)?.toggle()
        }
        this._rotSnapper.reset()
        this._drag = {
          type: 'rotate',
          center:     { ...this._position },
          startAngle: Math.atan2(point.y - this._position.y, point.x - this._position.x),
          startRot:   this._rotation,
        }
        return true
      }

      // Scale handle — suspends scaleSlot binding (if any) and takes manual control
      if (ptDist(point, hp.scale) <= HANDLE_HIT) {
        if (this._scaleSlot.state === SlotState.Bound) {
          BindingLayer.findForSlot(this._scaleSlot)?.toggle()
        }
        this._drag = {
          type:       'scale',
          center:     { ...this._position },
          startDist:  Math.max(1, ptDist(point, this._position)),
          startScale: this._scale,
        }
        return true
      }

      // Move handle — suspends positionSlot binding (if any) and takes manual control
      if (ptDist(point, hp.move) <= HANDLE_HIT) {
        if (this._positionSlot.state === SlotState.Bound) {
          BindingLayer.findForSlot(this._positionSlot)?.toggle()
        }
        this._drag = {
          type:       'move',
          startMouse: { ...point },
          startPos:   { ...this._position },
        }
        return true
      }

      // Acquire-image buttons — only present (and only hit-tested) while no
      // bitmap is loaded; checked after handles so a handle on top always wins.
      if (this._bitmap === null) {
        if (this._fileBtnB !== null && boundingBoxContains(this._fileBtnB, point)) {
          this.openFilePicker()
          return true
        }
        if (this._pasteBtnB !== null && boundingBoxContains(this._pasteBtnB, point)) {
          void this._pasteFromClipboard()
          return true
        }
        if (this._cameraBtnB !== null && boundingBoxContains(this._cameraBtnB, point)) {
          void this._startCameraPreview()
          return true
        }
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
    if (this._drag === null) return

    if (this._drag.type === 'move') {
      const rawPos = {
        x: this._drag.startPos.x + point.x - this._drag.startMouse.x,
        y: this._drag.startPos.y + point.y - this._drag.startMouse.y,
      }
      const edges = collectSnapEdges(this, 3)
      if (edges.xs.length > 0 || edges.ys.length > 0) {
        const halfW = this._natW * this._scale / 2
        const halfH = this._natH * this._scale / 2
        const cosA  = Math.cos(this._rotation), sinA = Math.sin(this._rotation)
        const extX  = Math.abs(halfW * cosA) + Math.abs(halfH * sinA)
        const extY  = Math.abs(halfW * sinA) + Math.abs(halfH * cosA)
        const snapped = snapPointToEdges(rawPos, edges, EDGE_SNAP_THRESHOLD,
          [-extX, 0, extX], [-extY, 0, extY])
        this._manualPosition = { x: snapped.x, y: snapped.y }
        this._edgeSnapX = snapped.snapLineX; this._edgeSnapY = snapped.snapLineY
      } else {
        this._manualPosition = rawPos
        this._edgeSnapX = null; this._edgeSnapY = null
      }
    } else if (this._drag.type === 'scale') {
      const d = Math.max(1, ptDist(point, this._drag.center))
      const s = this._drag.startScale * (d / this._drag.startDist)
      this._manualScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s))
    } else {
      // rotate
      const angle  = Math.atan2(point.y - this._drag.center.y, point.x - this._drag.center.x)
      const rawRot = this._drag.startRot + (angle - this._drag.startAngle)
      this._applySnapRotation(rawRot)
    }
    this.markDirty()
  }

  handlePointerUp(): void {
    this._drag = null
    this._clearRotDwellTimer()
    this._edgeSnapX = null; this._edgeSnapY = null
    this._opacityWidget.handlePointerUp()
  }

  private _applySnapRotation(raw: number): void {
    const result = this._rotSnapper.update(raw)
    this._rotation     = result.angle
    this._snapSnapped  = result.snapped
    this._snapProgress = result.progress
    if (result.snapped && this._rotDwellTimer === null) {
      this._rotDwellTimer = setInterval(() => {
        const r = this._rotSnapper.update(this._rotation)
        this._snapSnapped  = r.snapped
        this._snapProgress = r.progress
        this.markDirty()
        if (this._rotSnapper.isRefining) this._clearRotDwellTimer()
      }, 16)
    } else if (!result.snapped) {
      this._clearRotDwellTimer()
    }
  }

  private _clearRotDwellTimer(): void {
    if (this._rotDwellTimer !== null) {
      clearInterval(this._rotDwellTimer)
      this._rotDwellTimer = null
    }
    this._snapSnapped  = false
    this._snapProgress = 0
  }

  private _opacityPillBounds() {
    const cb = this.canvasBounds
    const standard = this.slots.filter(s => s !== this._opacitySlot)
    const standardH = standard.length * (30 + 4) - 4
    return { x: cb.x, y: this.panelBottom + standardH + 8, width: cb.width, height: 30 }
  }

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const standard = this.slots.filter(s => s !== this._opacitySlot)
    this.renderSlotGroup(ctx, standard, this.panelBottom)
    const ob = this._opacityPillBounds()
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(ob.x, ob.y, ob.width, ob.height, 6)
    ctx.fill()
    ctx.restore()
    this._slotBounds.set(this._opacitySlot, ob)
    this._opacityWidget.render(ctx, ob)
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    // Capture all events while dragging
    if (this._drag !== null) return this

    if (this._cameraMode) {
      // Live preview replaces convenience buttons / handles / acquire row.
      if (this._shutterBtnB      !== null && boundingBoxContains(this._shutterBtnB,      point)) return this
      if (this._flipBtnB         !== null && boundingBoxContains(this._flipBtnB,         point)) return this
      if (this._cameraCancelBtnB !== null && boundingBoxContains(this._cameraCancelBtnB, point)) return this
    } else {
      // Convenience buttons (drawn over canvas, not clipped)
      if (this._convBtnHitTest(point, 'clip'))   return this
      if (this._convBtnHitTest(point, 'filter')) return this
      // Transform handles take priority over the panel pill
      const hp = this._handlePos()
      if (ptDist(point, hp.move)   <= HANDLE_HIT) return this
      if (ptDist(point, hp.scale)  <= HANDLE_HIT) return this
      if (ptDist(point, hp.rotate) <= HANDLE_HIT) return this
      // Acquire-image buttons — only present while no bitmap is loaded.
      if (this._bitmap === null) {
        if (this._fileBtnB   !== null && boundingBoxContains(this._fileBtnB,   point)) return this
        if (this._pasteBtnB  !== null && boundingBoxContains(this._pasteBtnB,  point)) return this
        if (this._cameraBtnB !== null && boundingBoxContains(this._cameraBtnB, point)) return this
      }
    }

    if (this._opacityWidget.hitZone(point, this._opacityPillBounds()) !== null) return this
    return null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    this._renderCanvas(ctx)
  }

  // Room for the acquire row / camera controls (if shown) pushes the
  // standard slot rows down; once a bitmap is loaded there's no panel pill
  // at all, so rows start right at the top.
  override get panelBottom(): number {
    if (this._cameraMode) return 50 + this._cameraRowH() + 8
    return this._bitmap === null ? 50 + this._acquireRowH() + 8 : 50
  }

  renderPanel(ctx: Ctx2D): void {
    if (this._cameraMode) this._renderCameraControls(ctx)
    else if (this._bitmap === null) this._renderAcquireRow(ctx)
  }

  override renderOverlay(ctx: Ctx2D): void {
    if (this._cameraMode) return   // live preview replaces handles + convenience buttons
    this._renderHandles(ctx)
    drawSnapGuides(ctx, this._edgeSnapX, this._edgeSnapY, Node.canvasWidth, Node.canvasHeight)
    this._renderConvBtn(ctx, 'clip')
    this._renderConvBtn(ctx, 'filter')
  }

  // ── Acquire-image row (File / Paste / Camera) ────────────────

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

  private _acquireRowH(): number {
    const rows = this._bigGridRows(3, panelWidth(Node.canvasWidth))
    return LG_MARGIN * 2 + rows * LG_SZ + (rows - 1) * LG_GAP
  }

  private _renderAcquireRow(ctx: Ctx2D): void {
    const pillX = contentLeft(Node.canvasWidth)
    const pillW = panelWidth(Node.canvasWidth)
    if (pillW <= 0) return
    const h = this._acquireRowH()

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(pillX, 50, pillW, h, 8)
    ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(pillX, 50, 4, h, [4, 0, 0, 4])
    ctx.fill()

    const cells = this._bigGridCells(3, pillX, pillW, 50 + LG_MARGIN)
    this._fileBtnB   = cells[0]!
    this._pasteBtnB  = cells[1]!
    this._cameraBtnB = cells[2]!

    this._drawBigIconBtn(ctx, this._fileBtnB, 'folder-open', 'File')
    this._drawBigClipboardBtn(ctx, this._pasteBtnB, 'Paste')
    this._drawBigIconBtn(ctx, this._cameraBtnB, 'camera', 'Camera')

    ctx.restore()
  }

  // ── Live camera preview controls (Shutter / Flip / Cancel) ────

  private _cameraRowH(): number {
    const n = this._cameraDevices.length > 1 ? 2 : 1
    const rows = this._bigGridRows(n, panelWidth(Node.canvasWidth))
    return LG_MARGIN * 2 + rows * LG_SZ + (rows - 1) * LG_GAP
  }

  private _renderCameraControls(ctx: Ctx2D): void {
    const pillX = contentLeft(Node.canvasWidth)
    const pillW = panelWidth(Node.canvasWidth)
    if (pillW <= 0) return
    const n = this._cameraDevices.length > 1 ? 2 : 1
    const h = this._cameraRowH()

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(pillX, 50, pillW, h, 8)
    ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(pillX, 50, 4, h, [4, 0, 0, 4])
    ctx.fill()

    const cells = this._bigGridCells(n, pillX, pillW, 50 + LG_MARGIN)
    this._shutterBtnB = cells[0]!
    this._flipBtnB    = n > 1 ? cells[1]! : null

    this._drawShutterBtn(ctx, this._shutterBtnB)
    if (this._flipBtnB !== null) this._drawBigIconBtn(ctx, this._flipBtnB, 'swap', 'Flip')

    // Small cancel button — far right of the pill, same row as the grid.
    const CANCEL_SZ = 28
    const cancelB: BBox = {
      x: pillX + pillW - 6 - CANCEL_SZ,
      y: 50 + (h - CANCEL_SZ) / 2,
      width: CANCEL_SZ, height: CANCEL_SZ,
    }
    this._cameraCancelBtnB = cancelB
    ctx.fillStyle = 'rgba(255,255,255,0.10)'
    ctx.beginPath()
    ctx.roundRect(cancelB.x, cancelB.y, CANCEL_SZ, CANCEL_SZ, 4)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.70)'
    drawIcon(ctx, 'x', cancelB.x + CANCEL_SZ / 2, cancelB.y + CANCEL_SZ / 2, CANCEL_SZ - 10)

    ctx.restore()
  }

  // Bright red dished disc, distinct from CaptureLayer's neutral shutter —
  // this is a one-shot "take the photo now" action, not a persistent
  // record control.
  private _drawShutterBtn(ctx: Ctx2D, b: BBox): void {
    ctx.save()
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 6)
    ctx.fill()

    const cx = b.x + b.width / 2
    const cy = b.y + b.height * 0.42
    const r  = b.width * 0.26

    const grad = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r)
    grad.addColorStop(0, '#ff6b5e')
    grad.addColorStop(1, '#d81f1f')
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = grad
    ctx.fill()
    ctx.lineWidth   = 2
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.stroke()

    ctx.font         = `${Math.max(9, Math.round(b.width * 0.13))}px monospace`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.fillText('Shutter', b.x + b.width / 2, b.y + b.height - Math.max(10, b.height * 0.16))
    ctx.restore()
  }

  private _drawBigIconBtn(ctx: Ctx2D, b: BBox, icon: IconName, label: string): void {
    ctx.save()
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 6)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    drawIcon(ctx, icon, b.x + b.width / 2, b.y + b.height * 0.40, Math.round(b.width * 0.40))
    ctx.font         = `${Math.max(9, Math.round(b.width * 0.13))}px monospace`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = 'rgba(255,255,255,0.60)'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height - Math.max(10, b.height * 0.16))
    ctx.restore()
  }

  // No dedicated Phosphor icon exists for "paste" — hand-drawn clipboard
  // glyph, matching the bespoke-icon convention used elsewhere (e.g.
  // CaptureLayer's edit/stack/share icons).
  private _drawBigClipboardBtn(ctx: Ctx2D, b: BBox, label: string): void {
    ctx.save()
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 6)
    ctx.fill()

    const cx = b.x + b.width / 2
    const cy = b.y + b.height * 0.38
    const bw = b.width * 0.34
    const bh = b.width * 0.42
    const colour = 'rgba(255,255,255,0.75)'

    ctx.strokeStyle = colour
    ctx.fillStyle   = colour
    ctx.lineWidth   = Math.max(1.5, b.width * 0.03)
    ctx.beginPath()
    ctx.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, 3)
    ctx.stroke()

    // Clip tab at the top edge
    const tw = bw * 0.5, th = bh * 0.16
    ctx.beginPath()
    ctx.roundRect(cx - tw / 2, cy - bh / 2 - th * 0.6, tw, th, 2)
    ctx.fill()

    // Two lines suggesting text/image content
    ctx.beginPath()
    ctx.moveTo(cx - bw * 0.28, cy - bh * 0.05)
    ctx.lineTo(cx + bw * 0.28, cy - bh * 0.05)
    ctx.moveTo(cx - bw * 0.28, cy + bh * 0.20)
    ctx.lineTo(cx + bw * 0.10, cy + bh * 0.20)
    ctx.stroke()

    ctx.font         = `${Math.max(9, Math.round(b.width * 0.13))}px monospace`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = 'rgba(255,255,255,0.60)'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height - Math.max(10, b.height * 0.16))
    ctx.restore()
  }

  // ── Canvas image ─────────────────────────────────────────────

  private _renderCanvas(ctx: Ctx2D): void {
    if (this._cameraMode) {
      this._renderCameraPreview(ctx)
      return
    }

    const { x: px, y: py } = this._position

    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, this._opacity))
    ctx.translate(px, py)
    ctx.rotate(this._rotation)

    if (this._bitmap !== null) {
      const w = this._natW * this._scale
      const h = this._natH * this._scale
      ctx.drawImage(this._bitmap, -w / 2, -h / 2, w, h)
    } else {
      // Placeholder: dashed rectangle centred on the position.
      const pw = 120, ph = 80
      ctx.strokeStyle = 'rgba(126,207,126,0.40)'
      ctx.lineWidth   = 1.5
      ctx.setLineDash([4, 4])
      ctx.strokeRect(-pw / 2, -ph / 2, pw, ph)
      ctx.setLineDash([])
      ctx.font         = '11px monospace'
      ctx.fillStyle    = 'rgba(126,207,126,0.50)'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('no image', 0, 0)
    }

    ctx.restore()

    // Drop zone overlay — rendered on top of image/placeholder.
    if (this._dragOver) {
      const cw = ctx.canvas.width
      const ch = ctx.canvas.height
      const pad = 24
      ctx.save()
      ctx.fillStyle = 'rgba(126,207,126,0.10)'
      ctx.fillRect(0, 0, cw, ch)
      ctx.strokeStyle = 'rgba(126,207,126,0.80)'
      ctx.lineWidth   = 2
      ctx.setLineDash([10, 6])
      ctx.strokeRect(pad, pad, cw - pad * 2, ch - pad * 2)
      ctx.setLineDash([])
      ctx.font         = 'bold 20px monospace'
      ctx.fillStyle    = 'rgba(126,207,126,0.90)'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('Drop image here', cw / 2, ch / 2)
      ctx.restore()
    }
  }

  // Live feed, letterboxed to fit the canvas — drawn straight from the
  // <video> element every frame; no offscreen buffering is needed since
  // this never feeds getImage() (the bitmap stays null until captured).
  private _renderCameraPreview(ctx: Ctx2D): void {
    const video = this._cameraVideo
    if (video === null || video.videoWidth === 0) return
    const vw = video.videoWidth, vh = video.videoHeight
    const cw = Node.canvasWidth, ch = Node.canvasHeight
    const scale = Math.min(cw / vw, ch / vh)
    const dw = vw * scale, dh = vh * scale
    ctx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh)
  }

  // ── Transform handles ────────────────────────────────────────

  private _handlePos() {
    const { x: px, y: py } = this._position
    const cos = Math.cos(this._rotation)
    const sin = Math.sin(this._rotation)

    return {
      move: { x: px, y: py },
      // Scale handle: (SCALE_OX, SCALE_OY) rotated into world space → lower-right
      scale: {
        x: px + SCALE_OX * cos - SCALE_OY * sin,
        y: py + SCALE_OX * sin + SCALE_OY * cos,
      },
      // Rotate handle: (0, -ROT_ARM) rotated into world space → directly above when rot=0
      rotate: {
        x: px + ROT_ARM * sin,
        y: py - ROT_ARM * cos,
      },
    }
  }

  private _renderHandles(ctx: Ctx2D): void {
    const hp = this._handlePos()

    ctx.save()
    ctx.setLineDash([])

    // Dashed arm lines
    ctx.strokeStyle = 'rgba(255,255,255,0.38)'
    ctx.lineWidth   = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(hp.move.x, hp.move.y)
    ctx.lineTo(hp.rotate.x, hp.rotate.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(hp.move.x, hp.move.y)
    ctx.lineTo(hp.scale.x, hp.scale.y)
    ctx.stroke()
    ctx.setLineDash([])

    // Scale handle — square, cyan glow (dimmed when slot bound)
    this._drawGlowSquare(ctx, hp.scale, HANDLE_SZ,
      this._scaleSlot.isActive ? '#666688' : '#81d4fa')

    // Rotate handle — orange normally; cyan when snapping; dimmed when slot bound
    const rotCol = this._rotationSlot.isActive ? '#666688'
                 : this._snapSnapped           ? ROT_SNAP_COL
                 : '#ffb74d'
    this._drawGlowCircle(ctx, hp.rotate, HANDLE_R, rotCol)
    if (this._snapSnapped && this._snapProgress > 0) {
      const arcR  = HANDLE_R + 5
      const start = -Math.PI / 2
      const end   = start + this._snapProgress * 2 * Math.PI
      ctx.save()
      ctx.strokeStyle = ROT_SNAP_COL
      ctx.lineWidth   = 2
      ctx.globalAlpha = 0.85
      ctx.beginPath()
      ctx.arc(hp.rotate.x, hp.rotate.y, arcR, start, end)
      ctx.stroke()
      ctx.restore()
    }

    // Move handle — circle + crosshair, white glow (dimmed when slot bound)
    this._drawGlowCircle(ctx, hp.move, HANDLE_R,
      this._positionSlot.isActive ? '#666688' : '#ffffff')
    const cr = HANDLE_R - 2
    ctx.strokeStyle = 'rgba(0,0,0,0.80)'
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.moveTo(hp.move.x - cr, hp.move.y)
    ctx.lineTo(hp.move.x + cr, hp.move.y)
    ctx.moveTo(hp.move.x, hp.move.y - cr)
    ctx.lineTo(hp.move.x, hp.move.y + cr)
    ctx.stroke()

    ctx.restore()
  }

  private _drawGlowCircle(ctx: Ctx2D, pt: Point, r: number, glowColour: string): void {
    ctx.save()
    ctx.shadowColor = glowColour
    ctx.shadowBlur  = 14
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,255,255,0.95)'
    ctx.fill()
    ctx.restore()
    // Dark outline drawn without shadow
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(0,0,0,0.65)'
    ctx.lineWidth   = 1.5
    ctx.stroke()
  }

  private _drawGlowSquare(ctx: Ctx2D, pt: Point, s: number, glowColour: string): void {
    ctx.save()
    ctx.shadowColor = glowColour
    ctx.shadowBlur  = 14
    ctx.fillStyle   = 'rgba(255,255,255,0.95)'
    ctx.fillRect(pt.x - s, pt.y - s, s * 2, s * 2)
    ctx.restore()
    ctx.strokeStyle = 'rgba(0,0,0,0.65)'
    ctx.lineWidth   = 1.5
    ctx.strokeRect(pt.x - s, pt.y - s, s * 2, s * 2)
  }

  // ----------------------------------------------------------
  // Bottom convenience buttons — Clip / Filter
  // ----------------------------------------------------------

  private _convBtnRect(which: 'clip' | 'filter'): { x: number; y: number } {
    const left  = contentLeft(Node.canvasWidth)
    const total = CONV_BTN_W * 2 + CONV_BTN_SEP
    const startX = left + Math.max(0, (Node.viewportWidth - left - total) / 2)
    const y = Node.viewportHeight - CONV_BTN_H - CONV_BTN_GAP
    return { x: which === 'clip' ? startX : startX + CONV_BTN_W + CONV_BTN_SEP, y }
  }

  private _convBtnHitTest(point: Point, which: 'clip' | 'filter'): boolean {
    if (which === 'clip'   && this._addClipDone)   return false
    if (which === 'filter' && this._addFilterDone) return false
    const { x, y } = this._convBtnRect(which)
    return point.x >= x && point.x <= x + CONV_BTN_W &&
           point.y >= y && point.y <= y + CONV_BTN_H
  }

  private _renderConvBtn(ctx: Ctx2D, which: 'clip' | 'filter'): void {
    if (which === 'clip'   && this._addClipDone)   return
    if (which === 'filter' && this._addFilterDone) return
    const { x, y } = this._convBtnRect(which)
    const midY = y + CONV_BTN_H / 2

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(x, y, CONV_BTN_W, CONV_BTN_H, 5)
    ctx.fill()

    ctx.fillStyle = ACCENT + 'cc'
    ctx.beginPath()
    ctx.roundRect(x, y, 3, CONV_BTN_H, [5, 0, 0, 5])
    ctx.fill()

    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, CONV_BTN_W, CONV_BTN_H)
    ctx.clip()
    ctx.fillStyle    = 'rgba(255,255,255,0.85)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(which === 'clip' ? 'Clip' : 'Filter', x + 10, midY)
    ctx.restore()

    ctx.restore()
  }
}
