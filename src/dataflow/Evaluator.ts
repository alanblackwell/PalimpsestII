import { Node }      from '../core/Node.js'
import { Layer }     from '../core/Layer.js'
import { ValueType } from '../core/types.js'
import type { Point } from '../core/types.js'
import { Clock }     from './Clock.js'
import type { LayerStackWidget } from '../interaction/LayerStackWidget.js'
import { contentLeft } from '../interaction/layout.js'

// Duration of the swipe-gesture direction-arrow flash (see Node.gestureFlash).
const GESTURE_FLASH_MS = 350

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
  private readonly _widgetCanvas: HTMLCanvasElement | null = null
  private readonly _widgetCtx: CanvasRenderingContext2D | null = null

  private _stackTop:         Layer | null  = null
  private _clock:            Clock | null  = null
  private _background:       Node | null   = null
  private _layerStackWidget: LayerStackWidget | null = null
  private _continuous               = false
  private _animFrameId: number | null = null
  private _displayMode              = false

  // Performance counters (useful during development).
  private _frameCount = 0
  private _lastFpsTime = 0
  fps = 0

  constructor(canvas: HTMLCanvasElement, widgetCanvas?: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('Could not get 2D context from canvas')
    this.ctx = ctx

    if (widgetCanvas !== undefined) {
      this._widgetCanvas = widgetCanvas
      const wctx = widgetCanvas.getContext('2d')
      if (wctx === null) throw new Error('Could not get 2D context from widget canvas')
      this._widgetCtx = wctx
    }

    // Wire up the static hook so any Node.markDirty() triggers a frame.
    Node.scheduleFrame    = () => this.scheduleFrame()
    Node.canvasWidth      = canvas.width
    Node.canvasHeight     = canvas.height
    Node.viewportWidth    = canvas.width
    Node.viewportHeight   = canvas.height
  }

  // ----------------------------------------------------------
  // Viewport / content canvas sizing
  // ----------------------------------------------------------

  // The content canvas only ever grows — shrinking the window does not reduce
  // it. The widget canvas always matches the current viewport exactly.
  setViewport(width: number, height: number): void {
    Node.viewportWidth  = width
    Node.viewportHeight = height
    if (this._widgetCanvas !== null) {
      this._widgetCanvas.width  = width
      this._widgetCanvas.height = height
    }
    const newW = Math.max(this.canvas.width,  width)
    const newH = Math.max(this.canvas.height, height)
    if (newW !== this.canvas.width || newH !== this.canvas.height) {
      this.canvas.width  = newW
      this.canvas.height = newH
      Node.canvasWidth   = newW
      Node.canvasHeight  = newH
    }
    this.scheduleFrame()
  }

  get contentWidth():  number { return this.canvas.width  }
  get contentHeight(): number { return this.canvas.height }

  // Legacy alias kept for any call sites that set both dimensions simultaneously.
  resize(width: number, height: number): void {
    this.setViewport(width, height)
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

  // Attach the Background collection. Evaluated every frame, independent
  // of the current selection/stack chain, so its items keep recomputing
  // even while they're off-canvas.
  setBackground(background: Node | null): void {
    this._background = background
    this.scheduleFrame()
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

    // 2. Evaluate the Background collection — independent of the current
    //    selection/stack chain, so its items keep recomputing even while
    //    off-canvas.
    this._background?.evaluate()

    // 3. Evaluate and render the stack.
    this.render()

    // 4. Update FPS counter.
    this.updateFps(timestamp)

    // 5. Reschedule if running continuously.
    if (this._continuous) this.scheduleFrame()
  }

  // Toggle between edit mode (UI overlays visible) and display mode
  // (only rendered canvas content, no controls or layer stack widget).
  toggleDisplayMode(): void {
    this._displayMode = !this._displayMode
    if (this._displayMode) Node.resetViewTransform?.()
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
      Node.currentLayer = null
      renderTop.renderStack(this.ctx)
      // The overlay canvas is not cleared by the edit-mode path — clear it
      // explicitly so pills/handles/widgets don't persist from the last edit frame.
      if (this._widgetCtx !== null) {
        this._widgetCtx.clearRect(0, 0, this._widgetCanvas!.width, this._widgetCanvas!.height)
      }
      return
    }

    Node.currentLayer = renderTop

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
      if (layer.isHiddenHelper) continue   // evaluated in stack order, never drawn
      this.ctx.save()

      if (depth === 0) {
        // Current layer floats above the rest with a drop shadow.
        // Use the shadow* properties rather than ctx.filter('drop-shadow(...)') —
        // the latter is not rendered on older Safari versions.
        this.ctx.shadowColor   = 'rgba(0,0,0,0.60)'
        this.ctx.shadowBlur    = 18
        this.ctx.shadowOffsetY = 6
      }

      layer.renderSelf(this.ctx)
      this.ctx.restore()

      if (depth > 0) {
        // Atmospheric haze: wash everything rendered so far with translucent
        // white. Layers further down the stack accumulate more washes (one
        // per layer above them) and fade progressively toward white — this
        // is robust against layers that set their own globalAlpha/opacity
        // during renderSelf, which would otherwise clobber a depth-based
        // globalAlpha set here.
        this.ctx.save()
        this.ctx.fillStyle = 'rgba(255,255,255,0.25)'
        this.ctx.fillRect(0, 0, width, height)
        this.ctx.restore()
      }
    }

    const desktopPills = !Node.isMobileDevice && this._widgetCtx !== null

    if (desktopPills) {
      // Desktop: control pills are fixed in the viewport — render them to the
      // widget overlay canvas (viewport-sized, CSS-transform-independent) so
      // pan/zoom on the content canvas does not move them.
      //
      // Temporarily set Node.canvasWidth to viewportWidth so all per-layer
      // contentLeft(Node.canvasWidth) calls use viewport dimensions, matching
      // the widget canvas. Restored immediately after; renderPanel/renderSlots
      // are synchronous draw-only — no OffscreenCanvas allocations occur here.
      const wctx = this._widgetCtx!
      wctx.clearRect(0, 0, this._widgetCanvas!.width, this._widgetCanvas!.height)
      this._layerStackWidget?.render(wctx)

      const vw = Node.viewportWidth
      const vh = Node.viewportHeight
      const clipX = this._layerStackWidget?.isVisible ? contentLeft(vw) : 0
      const savedCW = Node.canvasWidth
      Node.canvasWidth = vw
      if (clipX > 0) {
        wctx.save()
        wctx.beginPath()
        wctx.rect(clipX, 0, vw - clipX, vh)
        wctx.clip()
      }
      renderTop.renderPanel(wctx)
      if (clipX > 0) wctx.restore()
      renderTop.renderSlots(wctx)
      Node.canvasWidth = savedCW
    } else {
      // Mobile / legacy: pills move with the content canvas (pan/zoom magnifies
      // them, aiding accessibility on small screens).
      const ww = this._layerStackWidget?.isVisible ? contentLeft(width) : 0
      if (ww > 0) {
        this.ctx.save()
        this.ctx.beginPath()
        this.ctx.rect(ww, 0, width - ww, height)
        this.ctx.clip()
      }
      renderTop.renderPanel(this.ctx)
      if (ww > 0) this.ctx.restore()
      renderTop.renderSlots(this.ctx)

      const wctx = this._widgetCtx ?? this.ctx
      if (this._widgetCtx !== null) {
        this._widgetCtx.clearRect(0, 0, this._widgetCanvas!.width, this._widgetCanvas!.height)
      }
      this._layerStackWidget?.render(wctx)
    }

    // Bind-drag cursor overlay — small card following the pointer.
    if (Node.bindDrag.active && Node.bindDrag.source !== null) {
      this._drawBindDragOverlay(this.ctx)
    }

    // Swipe-gesture feedback — briefly flash a direction arrow.
    if (Node.gestureFlash !== null) {
      this._drawGestureFlash(this.ctx)
    }

    // Touch-drag feedback — crosshair at the drop/edit point, since a
    // finger occludes the canvas underneath it.
    if (Node.touchDragPoint !== null) {
      this._drawTouchCrosshair(this.ctx)
    }

    // Pinch-gesture feedback — line between the two touch points.
    if (Node.pinchFeedback !== null) {
      this._drawPinchFeedback(this.ctx)
    }
  }

  // Crosshair centred on the current touch-drag point — a node handle/
  // slider/mask-paint drag, or a stack-widget reorder drag.
  private _drawTouchCrosshair(ctx: CanvasRenderingContext2D): void {
    const p = Node.touchDragPoint!
    const inner = 8, outer = 22

    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.90)'
    ctx.lineWidth   = 2
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur  = 4

    ctx.beginPath()
    ctx.moveTo(p.x - outer, p.y); ctx.lineTo(p.x - inner, p.y)
    ctx.moveTo(p.x + inner, p.y); ctx.lineTo(p.x + outer, p.y)
    ctx.moveTo(p.x, p.y - outer); ctx.lineTo(p.x, p.y - inner)
    ctx.moveTo(p.x, p.y + inner); ctx.lineTo(p.x, p.y + outer)
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(p.x, p.y, inner, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  // Grey bar with outward-pointing arrowheads connecting the two touch
  // points of an in-progress pinch gesture — a resize-handle affordance.
  private _drawPinchFeedback(ctx: CanvasRenderingContext2D): void {
    const { a, b } = Node.pinchFeedback!
    const colour = 'rgba(150,150,150,0.35)'
    const angle  = Math.atan2(b.y - a.y, b.x - a.x)

    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur  = 6
    ctx.strokeStyle = colour
    ctx.fillStyle   = colour
    ctx.lineWidth   = 18
    ctx.lineCap     = 'round'
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()

    this._drawArrowhead(ctx, a, angle + Math.PI)
    this._drawArrowhead(ctx, b, angle)
    ctx.restore()
  }

  // Filled triangle with its tip at `p`, pointing along `angle`.
  private _drawArrowhead(ctx: CanvasRenderingContext2D, p: Point, angle: number): void {
    const len = 36, width = 42
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(angle)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(-len, -width / 2)
    ctx.lineTo(-len, width / 2)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  // Briefly flash a block arrow in the swipe direction, over the centre of
  // the canvas (main-canvas swipes) or the centre of the stack widget strip
  // (stack-widget swipes) — visual confirmation that a swipe was recognised.
  private _drawGestureFlash(ctx: CanvasRenderingContext2D): void {
    const flash = Node.gestureFlash!
    const elapsed = performance.now() - flash.start
    if (elapsed > GESTURE_FLASH_MS) {
      Node.gestureFlash = null
      return
    }

    const { width, height } = this.canvas
    const cx = flash.target === 'widget'
      ? (this._layerStackWidget?.widgetWidth ?? width) / 2
      : width / 2
    const cy = height / 2

    const angle = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }[flash.dir]
    const alpha = 0.85 * (1 - elapsed / GESTURE_FLASH_MS)

    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(angle)
    ctx.globalAlpha = alpha
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur  = 12
    ctx.fillStyle   = 'rgba(255,255,255,0.95)'
    ctx.beginPath()
    ctx.moveTo(-36, 12)
    ctx.lineTo(0, -48)
    ctx.lineTo(36, 12)
    ctx.lineTo(14, 12)
    ctx.lineTo(14, 48)
    ctx.lineTo(-14, 48)
    ctx.lineTo(-14, 12)
    ctx.closePath()
    ctx.fill()
    ctx.restore()

    // Continue redrawing until the flash fades, even in demand-driven mode.
    Node.scheduleFrame?.()
  }

  private _drawBindDragOverlay(ctx: CanvasRenderingContext2D): void {
    const src = Node.bindDrag.source!
    const x   = Node.bindDrag.x + 12
    const y   = Node.bindDrag.y - 14
    const W   = 130, H = 28

    // Type colour
    const tc = (() => {
      const t = src.types
      if (t.has(ValueType.Amount))    return '#4a8fe8'
      if (t.has(ValueType.Colour))    return '#e8944a'
      if (t.has(ValueType.Image))     return '#7ecf7e'
      if (t.has(ValueType.Mask))      return '#cfcf7e'
      if (t.has(ValueType.Point))     return '#cf7ecf'
      if (t.has(ValueType.Direction)) return '#7ecfcf'
      if (t.has(ValueType.Rate))      return '#e87e7e'
      if (t.has(ValueType.Count))     return '#a0a0a0'
      if (t.has(ValueType.Event))     return '#e0e060'
      return '#888888'
    })()

    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 8

    ctx.fillStyle = 'rgba(10,10,20,0.88)'
    ctx.beginPath(); ctx.roundRect(x, y, W, H, 6); ctx.fill()

    ctx.shadowBlur = 0
    ctx.fillStyle = tc
    ctx.beginPath(); ctx.roundRect(x, y, 3, H, [6, 0, 0, 6]); ctx.fill()

    ctx.fillStyle    = 'rgba(255,255,255,0.90)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText((src as { debugName?: string }).debugName ?? '?', x + 10, y + H / 2)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Resize handling
  // ----------------------------------------------------------

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
