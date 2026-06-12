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

const ACCENT   = '#7ecf7e'   // Image type colour
const STRIPE   = 4
const PANEL_X  = 300
const PANEL_W  = 260
const NAV_SZ   = 22          // prev / next button size
const NAV_OX   = STRIPE + 6  // nav button left offset from panel x

// ── VideoLayer ────────────────────────────────────────────────

type BBox = { x: number; y: number; width: number; height: number }

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

  // ── Construction ─────────────────────────────────────────────

  constructor() {
    super()
    this.debugName = 'Video'

    this.enableSlot = new ParameterSlot(ValueType.Event, this, 'freeze toggle')
    this.slots.push(this.enableSlot)

    // Hidden video element — must live in the DOM for Safari to
    // deliver frames; positioned far off-screen.
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

  // Acquire permission first so enumerateDevices returns real labels,
  // then start the default (first) camera.
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

    // Capture a new frame when live and video data is ready.
    if (!this._frozen && this._stream !== null &&
        this._video.readyState >= HTMLVideoElement.HAVE_CURRENT_DATA) {
      const cw = Node.canvasWidth
      const ch = Node.canvasHeight

      if (!this._result || this._result.width !== cw || this._result.height !== ch)
        this._result = new OffscreenCanvas(cw, ch)

      const ctx = this._result.getContext('2d')!
      ctx.clearRect(0, 0, cw, ch)

      // Cover-scale: fill the canvas, centred, preserving aspect ratio.
      const vw = this._video.videoWidth  || cw
      const vh = this._video.videoHeight || ch
      const scale = Math.max(cw / vw, ch / vh)
      const dw = vw * scale, dh = vh * scale
      ctx.drawImage(this._video, (cw - dw) / 2, (ch - dh) / 2, dw, dh)
    }

    // While live and still in the stack, schedule the next frame via a
    // microtask — forceDirty() is called AFTER evaluate() clears our dirty
    // flag, so the next rAF finds us dirty and captures a fresh frame.
    if (!this._frozen && this._stream !== null && !this.outsideStack) {
      queueMicrotask(() => {
        if (!this._frozen && this._stream !== null && !this.outsideStack) {
          this.forceDirty()
        }
      })
    }
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
    const h = this.bounds.height
    // Left strip pill (visible in the layer stack widget)
    this._drawStripPill(ctx, this.bounds)
    // Canvas-space pill with camera selector controls
    this._drawCameraPill(ctx, { x: PANEL_X, y: 50, width: PANEL_W, height: h })
  }

  // Slot rows are rendered by the base class; we add the freeze toggle button.
  override renderSlots(ctx: Ctx2D): void {
    super.renderSlots(ctx)

    const SLOT_H   = 26
    const SLOT_GAP = 4
    const BTN_SZ   = SLOT_H - 6   // 20px

    const idx = this.slots.indexOf(this.enableSlot)
    if (idx < 0) return

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

    // Freeze/live icon
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

  // ── Interaction ───────────────────────────────────────────────

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    // Toggle button (in slot row)
    if (this._toggleBounds !== null) {
      const b = this._toggleBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) return this
    }
    // Camera prev / next buttons
    if (this._prevBtnB !== null && boundingBoxContains(this._prevBtnB, point)) return this
    if (this._nextBtnB !== null && boundingBoxContains(this._nextBtnB, point)) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
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

  handlePointerUp(): void {}

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
    ctx.fillText('Video', x + 12, y + height / 2)
    ctx.restore()
  }

  // Camera selector pill drawn in canvas space (right of Stack Widget).
  private _drawCameraPill(ctx: Ctx2D, b: BBox): void {
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

    // ◀ prev camera button
    const pb: BBox = {
      x:      x + NAV_OX,
      y:      y + (height - NAV_SZ) / 2,
      width:  NAV_SZ,
      height: NAV_SZ,
    }
    this._prevBtnB = pb

    // ▶ next camera button — right-aligned, leave margin
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

    // Camera name — clipped between the two nav buttons
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

  private _drawNavBtn(
    ctx:    Ctx2D,
    b:      BBox,
    label:  string,
    colour: string,
  ): void {
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
