import { Node } from '../core/Node.js'
import { Layer } from '../core/Layer.js'
import { Clock } from './Clock.js'
import type { LayerStackWidget } from '../interaction/LayerStackWidget.js'

// ------------------------------------------------------------
// Evaluator — drives the render loop and wires everything together
// ------------------------------------------------------------
//
// Responsibilities:
//   1. Run requestAnimationFrame when frames are needed.
//   2. Tick the Clock each frame (if one is attached).
//   3. Evaluate the layer stack (lazy pull — each layer evaluates
//      its dirty dependencies before rendering itself).
//   4. Composite the evaluated stack onto the visible canvas.
//
// Two operating modes:
//   • Continuous (default when a Clock is attached): rAF always
//     reschedules itself.  Suitable for animated content.
//   • Demand-driven (no Clock, or Clock stopped): rAF fires only
//     when Node.scheduleFrame() is called — i.e. when something
//     becomes dirty due to user interaction.

export class Evaluator {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D

  private _stackTop:         Layer | null  = null
  private _clock:            Clock | null  = null
  private _layerStackWidget: LayerStackWidget | null = null
  private _continuous               = false
  private _animFrameId: number | null = null
  private _displayMode              = false

  // Performance counters (useful during development).
  private _frameCount = 0
  private _lastFpsTime = 0
  fps = 0

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('Could not get 2D context from canvas')
    this.ctx = ctx

    // Wire up the static hook so any Node.markDirty() triggers a frame.
    Node.scheduleFrame = () => this.scheduleFrame()
  }

  // ----------------------------------------------------------
  // Configuration
  // ----------------------------------------------------------

  // Set the topmost layer of the stack to be rendered.
  setStack(top: Layer): void {
    this._stackTop = top
    this.scheduleFrame()
  }

  setLayerStackWidget(w: LayerStackWidget): void {
    this._layerStackWidget = w
  }

  // Attach a Clock.  When a Clock is present, the Evaluator runs
  // continuously; removing the Clock reverts to demand-driven mode.
  setClock(clock: Clock | null): void {
    this._clock = clock
    this._continuous = clock !== null
    if (this._continuous) this.scheduleFrame()
  }

  // ----------------------------------------------------------
  // Frame scheduling
  // ----------------------------------------------------------

  // Request a render on the next animation frame (idempotent).
  scheduleFrame(): void {
    if (this._animFrameId !== null) return
    this._animFrameId = requestAnimationFrame(ts => this.frame(ts))
  }

  // Pause the render loop.
  stop(): void {
    if (this._animFrameId !== null) {
      cancelAnimationFrame(this._animFrameId)
      this._animFrameId = null
    }
    this._continuous = false
  }

  // Resume continuous rendering (e.g. after stop()).
  start(): void {
    this._continuous = this._clock !== null
    this.scheduleFrame()
  }

  // ----------------------------------------------------------
  // The frame
  // ----------------------------------------------------------

  private frame(timestamp: number): void {
    this._animFrameId = null

    // 1. Advance time — this marks Clock's dependents dirty.
    this._clock?.tick(timestamp)

    // 2. Evaluate and render the stack.
    this.render()

    // 3. Update FPS counter.
    this.updateFps(timestamp)

    // 4. Reschedule if running continuously.
    if (this._continuous) this.scheduleFrame()
  }

  // Toggle between edit mode (UI overlays visible) and display mode
  // (only rendered canvas content, no controls or layer stack widget).
  toggleDisplayMode(): void {
    this._displayMode = !this._displayMode
    this.scheduleFrame()
  }

  get displayMode(): boolean { return this._displayMode }

  private render(): void {
    if (this._stackTop === null) return

    const { width, height } = this.canvas
    this.ctx.clearRect(0, 0, width, height)

    const renderTop = this._layerStackWidget?.selected ?? this._stackTop

    if (this._displayMode) {
      // Display mode: plain composite, no depth effects.
      renderTop.renderStack(this.ctx)
      return
    }

    // Edit mode: walk the chain bottom→top so each layer can be rendered
    // with individual alpha/filter settings.
    const layers: Layer[] = []
    for (let l: Layer | null = renderTop; l !== null; l = l.layerBelow) {
      layers.unshift(l)
    }
    const topIdx = layers.length - 1

    for (let i = 0; i <= topIdx; i++) {
      const layer = layers[i]!
      const depth = topIdx - i   // 0 = current layer, 1 = one below, …

      layer.evaluate()
      this.ctx.save()

      if (depth === 0) {
        // Current layer floats above the rest with a drop shadow.
        this.ctx.filter = 'drop-shadow(0px 6px 18px rgba(0,0,0,0.60))'
      } else {
        // Layers below fade progressively with depth.
        this.ctx.globalAlpha = Math.max(0.08, Math.pow(0.72, depth))
      }

      layer.renderSelf(this.ctx)
      this.ctx.restore()
    }

    renderTop.renderPanel(this.ctx)
    this._layerStackWidget?.render(this.ctx)
  }

  // ----------------------------------------------------------
  // Resize handling
  // ----------------------------------------------------------

  // Call this when the canvas element is resized (e.g. from a ResizeObserver).
  resize(width: number, height: number): void {
    this.canvas.width  = width
    this.canvas.height = height
    this.scheduleFrame()
  }

  // ----------------------------------------------------------
  // FPS
  // ----------------------------------------------------------

  private updateFps(timestamp: number): void {
    this._frameCount++
    const elapsed = timestamp - this._lastFpsTime
    if (elapsed >= 1000) {
      this.fps = Math.round(this._frameCount * 1000 / elapsed)
      this._frameCount = 0
      this._lastFpsTime = timestamp
    }
  }

  // ----------------------------------------------------------
  // Accessors
  // ----------------------------------------------------------

  get clock(): Clock | null  { return this._clock }
  get stackTop(): Layer | null { return this._stackTop }
  get isRunning(): boolean { return this._animFrameId !== null || this._continuous }
}
