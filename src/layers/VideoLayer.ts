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

const ACCENT  = '#7ecf7e'   // Image type colour
const STRIPE  = 4
const BTN_M   = 6           // right-edge margin
const NAV_SZ  = 22          // prev / next button size
const TOG_SZ  = 26          // freeze toggle button size
const NAV_OX  = STRIPE + 6  // prev button left offset from panel x

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

  // Human-readable status shown in the panel while the stream is
  // not yet running (replaces the camera name)
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
      // A brief getUserMedia call is the only reliable way to unlock labels.
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
    // Stop any existing stream.
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
    const { x, y, width, height } = this.bounds
    if (width <= 0 || height <= 0) return

    const midY = y + height / 2

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

    const pb = this._prevBtnBounds()
    const nb = this._nextBtnBounds()
    const tb = this._toggleBtnBounds()

    const canNav = this._devices.length > 1
    const navCol = canNav ? ACCENT : 'rgba(255,255,255,0.20)'

    // ◀ prev camera
    this._drawBtn(ctx, pb, '◀', navCol)

    // Camera name or status — clipped between prev and next buttons
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

    // ▶ next camera
    this._drawBtn(ctx, nb, '▶', navCol)

    // Freeze / live toggle
    const frozen  = this._frozen
    const bound   = this.enableSlot.isActive
    const togCol  = bound
      ? '#e0e060'
      : frozen ? 'rgba(255,140,40,0.85)' : ACCENT
    this._drawBtn(ctx, tb, frozen ? '⏸' : '⏺', togCol)
  }

  // ── Interaction ───────────────────────────────────────────────

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    return boundingBoxContains(this.bounds, point) ? this : null
  }

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._prevBtnBounds(), point)) {
      if (this._devices.length > 1) {
        this._deviceIdx = (this._deviceIdx + this._devices.length - 1) % this._devices.length
        void this._startStream()
      }
      return true
    }
    if (boundingBoxContains(this._nextBtnBounds(), point)) {
      if (this._devices.length > 1) {
        this._deviceIdx = (this._deviceIdx + 1) % this._devices.length
        void this._startStream()
      }
      return true
    }
    if (boundingBoxContains(this._toggleBtnBounds(), point)) {
      this._handleToggle()
      return true
    }
    return false
  }

  handlePointerUp(): void {}

  // ── Private helpers ───────────────────────────────────────────

  private _handleToggle(): void {
    if (this.enableSlot.state === SlotState.Bound) {
      // Suspend the binding — manual control takes over.
      this.enableSlot.suspend()
    } else if (this.enableSlot.state === SlotState.SuspendedBound) {
      // Re-enable the binding.
      this.enableSlot.resume()
    } else {
      this._frozen = !this._frozen
      this.markDirty()
    }
  }

  private _displayName(): string {
    if (this._status !== 'live') return this._status
    const d = this._devices[this._deviceIdx]
    if (!d)        return 'no camera'
    return d.label || `Camera ${this._deviceIdx + 1}`
  }

  // ── Button geometry ───────────────────────────────────────────

  private _prevBtnBounds() {
    const { x, y, height } = this.bounds
    return {
      x:      x + NAV_OX,
      y:      y + (height - NAV_SZ) / 2,
      width:  NAV_SZ,
      height: NAV_SZ,
    }
  }

  private _toggleBtnBounds() {
    const { x, y, width, height } = this.bounds
    return {
      x:      x + width - BTN_M - TOG_SZ,
      y:      y + (height - TOG_SZ) / 2,
      width:  TOG_SZ,
      height: TOG_SZ,
    }
  }

  private _nextBtnBounds() {
    const tb = this._toggleBtnBounds()
    return {
      x:      tb.x - 4 - NAV_SZ,
      y:      tb.y + (TOG_SZ - NAV_SZ) / 2,
      width:  NAV_SZ,
      height: NAV_SZ,
    }
  }

  private _drawBtn(
    ctx:    Ctx2D,
    b:      { x: number; y: number; width: number; height: number },
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
