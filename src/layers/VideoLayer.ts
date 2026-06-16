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

// ── Constants ─────────────────────────────────────────────────

const ACCENT     = '#7ecf7e'   // Image type colour
const ROT_ACCENT = '#7ecfcf'   // Direction type colour for rotation handle
const STRIPE     = 4
const NAV_SZ     = 22          // prev / next button size
const NAV_OX     = STRIPE + 6  // nav button left offset from panel x

// Transform handles
const HANDLE_R   = 7    // circle handle radius
const HANDLE_SZ  = 6    // square handle half-size
const HANDLE_HIT = 14   // pointer hit-test radius
const ROT_ARM    = 85   // rotate-handle arm length from centre
const SCALE_OX   = 70   // scale handle image-local x offset from centre
const SCALE_OY   = 70   // scale handle image-local y offset from centre
const MIN_VW     = 40   // minimum display width when scaling
const MIN_VH     = 30   // minimum display height when scaling

// ── Types ─────────────────────────────────────────────────────

type BBox = { x: number; y: number; width: number; height: number }

type DragState =
  | { type: 'move';   startMouse: Point; startCX: number; startCY: number }
  | { type: 'scale';  startDist: number; startW: number; startH: number; center: Point }
  | { type: 'rotate'; startAngle: number; startRot: number; center: Point }

function ptDist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// ── VideoLayer ────────────────────────────────────────────────

export class VideoLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  // Camera enumeration
  private _devices:   MediaDeviceInfo[] = []
  private _deviceIdx: number = 0

  // Off-screen video element — receives the MediaStream
  private _video:  HTMLVideoElement
  private _stream: MediaStream | null = null

  // Freeze state: when true the last captured frame is held
  private _frozen = false
  get frozen(): boolean { return this._frozen }

  // Last captured frame (result canvas)
  private _result: OffscreenCanvas | null = null

  // Event slot — each event edge toggles the freeze state
  readonly enableSlot: ParameterSlot
  private _lastEventTime: EventValue = null

  // Toggle button bounds (set during renderSlots, used for hit-testing)
  private _toggleBounds: BBox | null = null

  // Camera pill bounds (set during renderPanel, used for hit-testing)
  private _prevBtnB: BBox | null = null
  private _nextBtnB: BBox | null = null

  // Human-readable status shown in the panel while the stream is not yet running
  private _status = 'initialising…'

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

  // ── Construction ─────────────────────────────────────────────

  constructor() {
    super()
    this.debugName = 'Video'

    this.enableSlot = new ParameterSlot(ValueType.Event, this, 'freeze toggle')
    this.slots.push(this.enableSlot)

    this._video = document.createElement('video')
    this._video.playsInline = true
    this._video.muted       = true
    this._video.style.cssText =
      'position:fixed;top:-9999px;left:-9999px;pointer-events:none;opacity:0'
    document.body.appendChild(this._video)

    graph.register(this)
    this._init()
  }

  // ── Camera initialisation ─────────────────────────────────────

  private async _init(): Promise<void> {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      probe.getTracks().forEach(t => t.stop())
    } catch {
      this._status = 'permission denied'
      this.markDirty()
      return
    }

    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      this._devices = all.filter(d => d.kind === 'videoinput')
    } catch {
      this._status = 'enumerate failed'
      this.markDirty()
      return
    }

    if (this._devices.length === 0) {
      this._status = 'no camera found'
      this.markDirty()
      return
    }

    await this._startStream()
  }

  private async _startStream(): Promise<void> {
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop())
      this._stream = null
      this._video.srcObject = null
    }

    const device = this._devices[this._deviceIdx]
    if (!device) return

    this._status = 'starting…'
    this.markDirty()

    try {
      const constraints: MediaStreamConstraints = {
        video: device.deviceId ? { deviceId: { exact: device.deviceId } } : true,
        audio: false,
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      this._stream = stream
      this._video.srcObject = stream
      await this._video.play()
      this._status = 'live'
      this.markDirty()
    } catch {
      this._status = 'camera error'
      this.markDirty()
    }
  }

  // ── ImageSource ───────────────────────────────────────────────

  getImage(): ImageValue { return this._result }

  // ── Persistence ───────────────────────────────────────────────

  override serializeState(): Record<string, unknown> {
    return {
      deviceIdx:       this._deviceIdx,
      frozen:          this._frozen,
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
    if (typeof state.deviceIdx === 'number')  this._deviceIdx = state.deviceIdx
    if (typeof state.frozen === 'boolean')    this._frozen    = state.frozen
    if (typeof state.lastEventTime === 'number' || state.lastEventTime === null) {
      this._lastEventTime = state.lastEventTime as EventValue
    }
    if (typeof state.cx === 'number')              this._cx             = state.cx
    if (typeof state.cy === 'number')              this._cy             = state.cy
    if (typeof state.displayW === 'number')        this._displayW       = state.displayW
    if (typeof state.displayH === 'number')        this._displayH       = state.displayH
    if (typeof state.rotation === 'number')        this._rotation       = state.rotation
    if (typeof state.manualTransform === 'boolean') this._manualTransform = state.manualTransform
  }

  // ── Node — evaluate & recompute ───────────────────────────────

  override evaluate(): void {
    if (this.enableSlot.isActive) this.enableSlot.source!.evaluate()
    super.evaluate()
  }

  protected recompute(): void {
    // Consume event slot — each rising edge toggles freeze.
    if (this.enableSlot.isActive) {
      const t = (this.enableSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastEventTime) {
        this._lastEventTime = t
        this._frozen = !this._frozen
      }
    }

    // Auto-fit the video within the visible viewport (contain/letterbox).
    // Skipped once the user has manually positioned or resized via handles.
    if (!this._manualTransform) this._computeAutoFit()

    // Capture a new frame when live and video data is ready.
    if (!this._frozen && this._stream !== null &&
        this._video.readyState >= HTMLVideoElement.HAVE_CURRENT_DATA) {
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
    }

    if (!this._frozen && this._stream !== null && (!this.outsideStack || this.inBackground)) {
      queueMicrotask(() => {
        if (!this._frozen && this._stream !== null && (!this.outsideStack || this.inBackground)) {
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
    this._drawStripPill(ctx, this.bounds)
    this._drawCameraPill(ctx, this.canvasBounds)
    this._renderHandles(ctx)
  }

  override renderSlots(ctx: Ctx2D): void {
    super.renderSlots(ctx)

    const SLOT_H   = 26
    const SLOT_GAP = 4
    const BTN_SZ   = SLOT_H - 6

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

    ctx.strokeStyle = isActive ? ACCENT + '99' : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    if (isSuspended) ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.roundRect(btnX + 0.5, btnY + 0.5, BTN_SZ - 1, BTN_SZ - 1, 3)
    ctx.stroke()
    ctx.setLineDash([])

    const frozen  = this._frozen
    const iconCol = isActive
      ? ACCENT
      : isSuspended ? 'rgba(255,255,255,0.35)'
      : frozen ? 'rgba(255,140,40,0.85)' : ACCENT
    ctx.font         = '11px monospace'
    ctx.fillStyle    = iconCol
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(frozen ? '⏸' : '⏺', btnX + BTN_SZ / 2, midY)

    ctx.restore()
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
    // Toggle button (in slot row)
    if (this._toggleBounds !== null) {
      const b = this._toggleBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) return this
    }
    // Camera prev / next buttons
    if (this._prevBtnB !== null && boundingBoxContains(this._prevBtnB, point)) return this
    if (this._nextBtnB !== null && boundingBoxContains(this._nextBtnB, point)) return this
    // Transform handles
    if (this._displayW > 0) {
      const hp = this._handlePos()
      if (ptDist(point, hp.move)   <= HANDLE_HIT) return this
      if (ptDist(point, hp.scale)  <= HANDLE_HIT) return this
      if (ptDist(point, hp.rotate) <= HANDLE_HIT) return this
    }
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

    if (this._prevBtnB !== null && boundingBoxContains(this._prevBtnB, point)) {
      if (this._devices.length > 1) {
        this._deviceIdx = (this._deviceIdx + this._devices.length - 1) % this._devices.length
        void this._startStream()
      }
      return true
    }
    if (this._nextBtnB !== null && boundingBoxContains(this._nextBtnB, point)) {
      if (this._devices.length > 1) {
        this._deviceIdx = (this._deviceIdx + 1) % this._devices.length
        void this._startStream()
      }
      return true
    }
    if (this._toggleBounds !== null) {
      const b = this._toggleBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) {
        this._handleToggle()
        return true
      }
    }
    return false
  }

  handlePointerMove(point: Point): void {
    if (this._drag === null) return
    if (this._drag.type === 'move') {
      this._cx = this._drag.startCX + point.x - this._drag.startMouse.x
      this._cy = this._drag.startCY + point.y - this._drag.startMouse.y
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
  }

  handlePointerUp(): void {
    this._drag = null
  }

  // ── Private helpers ───────────────────────────────────────────

  private _handleToggle(): void {
    if (this.enableSlot.state === SlotState.Bound) {
      this.enableSlot.suspend()
    } else if (this.enableSlot.state === SlotState.SuspendedBound) {
      this.enableSlot.resume()
    } else {
      this._frozen = !this._frozen
      this.markDirty()
    }
  }

  private _displayName(): string {
    if (this._status !== 'live') return this._status
    const d = this._devices[this._deviceIdx]
    if (!d) return 'no camera'
    return d.label || `Camera ${this._deviceIdx + 1}`
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
    ctx.fillText('Video', x + 12, y + height / 2)
    ctx.restore()
  }

  private _drawCameraPill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return

    const midY = y + height / 2

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, STRIPE, height, [4, 0, 0, 4])
    ctx.fill()

    const pb: BBox = {
      x:      x + NAV_OX,
      y:      y + (height - NAV_SZ) / 2,
      width:  NAV_SZ,
      height: NAV_SZ,
    }
    this._prevBtnB = pb

    const nb: BBox = {
      x:      x + width - NAV_OX - NAV_SZ,
      y:      y + (height - NAV_SZ) / 2,
      width:  NAV_SZ,
      height: NAV_SZ,
    }
    this._nextBtnB = nb

    const canNav = this._devices.length > 1
    const navCol = canNav ? ACCENT : 'rgba(255,255,255,0.20)'

    this._drawNavBtn(ctx, pb, '◀', navCol)

    const nameX = pb.x + pb.width + 4
    const nameW = nb.x - nameX - 4
    if (nameW > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(nameX, y, nameW, height)
      ctx.clip()
      ctx.font         = '10px monospace'
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillStyle    = 'rgba(255,255,255,0.80)'
      ctx.fillText(this._displayName(), nameX, midY)
      ctx.restore()
    }

    this._drawNavBtn(ctx, nb, '▶', navCol)

    ctx.restore()
  }

  private _drawNavBtn(ctx: Ctx2D, b: BBox, label: string, colour: string): void {
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
