// PalimpsestII — entry point
import { Evaluator }         from '../dataflow/Evaluator.js'
import { InteractionSystem } from '../interaction/InteractionSystem.js'
import { Layer }             from '../core/Layer.js'
import { Node }              from '../core/Node.js'
import { ValueType, SlotState } from '../core/types.js'
import type { Point, Direction, Colour } from '../core/types.js'
import { ParameterSlot }     from '../core/ParameterSlot.js'
import { rndColour, OUTLINE_COLOUR } from '../core/colour.js'
import { graph }             from '../dataflow/Graph.js'
import { BindingLayer }      from '../layers/BindingLayer.js'
import { AnimPathLayer }     from '../layers/AnimPathLayer.js'
import { ClockLayer }        from '../layers/ClockLayer.js'
import { ImageLayer }        from '../layers/ImageLayer.js'
import { VideoLayer }        from '../layers/VideoLayer.js'
import { TempoLayer }        from '../layers/TempoLayer.js'
import { RootLayer }         from '../layers/RootLayer.js'
import { MenuLayer, rndShape } from '../layers/MenuLayer.js'
import { DeletionLayer }     from '../layers/DeletionLayer.js'
import { BackgroundLayer }   from '../layers/BackgroundLayer.js'
import { AmountLayer }       from '../layers/AmountLayer.js'
import { ColourLayer }       from '../layers/ColourLayer.js'
import { PointLayer }        from '../layers/PointLayer.js'
import { DirectionLayer }    from '../layers/DirectionLayer.js'
import { CountLayer }        from '../layers/CountLayer.js'
import { EventLayer }        from '../layers/EventLayer.js'
import { MaskLayer }         from '../layers/MaskLayer.js'
import { CollectionLayer }   from '../layers/CollectionLayer.js'
import { LayerStackWidget }  from '../interaction/LayerStackWidget.js'
import { StartupLayer }      from '../layers/StartupLayer.js'
import { TutorialLayer }     from '../layers/TutorialLayer.js'
import { StrokeLayer }       from '../layers/StrokeLayer.js'
import { RectLayer }         from '../layers/RectLayer.js'
import { EllipseLayer }      from '../layers/EllipseLayer.js'
import { PathLayer }         from '../layers/PathLayer.js'
import { TextLayer }         from '../layers/TextLayer.js'
import { ClipLayer, isClippableImageLayer } from '../layers/ClipLayer.js'
import type { ClipShapeLayer } from '../layers/ClipLayer.js'
import { FilterLayer }       from '../layers/FilterLayer.js'
import { MathLayer }         from '../layers/MathLayer.js'
import { ShapeLayer }        from '../layers/ShapeLayer.js'
import { ClipRectLayer }        from '../layers/ClipRectLayer.js'
import { TrackRectLayer }       from '../layers/TrackRectLayer.js'
import { TrackEllipseLayer }    from '../layers/TrackEllipseLayer.js'
import { TrackPathLayer }       from '../layers/TrackPathLayer.js'
import { TrackDrawingLayer }    from '../layers/TrackDrawingLayer.js'
import { ClipEllipseLayer }  from '../layers/ClipEllipseLayer.js'
import { ClipPathLayer }     from '../layers/ClipPathLayer.js'
import { ClipTextLayer }     from '../layers/ClipTextLayer.js'
import { ClipDrawingLayer }  from '../layers/ClipDrawingLayer.js'
import { TransformLayer }    from '../layers/TransformLayer.js'
import { RotateLayer }       from '../layers/RotateLayer.js'
import { NoiseLayer }        from '../layers/NoiseLayer.js'
import { TileLayer }         from '../layers/TileLayer.js'
import { FillLayer }         from '../layers/FillLayer.js'
import { MotionBlurLayer }   from '../layers/MotionBlurLayer.js'
import { CompositeLayer }   from '../layers/CompositeLayer.js'
import { LineLayer }         from '../layers/LineLayer.js'
import { BindingMapLayer }   from '../layers/BindingMapLayer.js'
import { TraceLayer }        from '../layers/TraceLayer.js'
import * as Persistence      from '../persistence/Persistence.js'
import * as MobileStore      from '../persistence/MobileStore.js'
import { openGallery }       from '../ui/MobileGallery.js'

// Bind a TempoLayer's timeSlot to the shared singleton Clock, if not already
// bound, so its phase starts advancing immediately.
function bindRateClock(rate: TempoLayer): void {
  if (!rate.timeSlot.isActive) BindingLayer.create(clock, rate.timeSlot)
}

// Create a hidden helper TempoLayer directly above `host`, bind it to
// `phaseSlot`, and wire its timeSlot to the singleton Clock.
// `rateHz` is the initial rate; pass `1.0` for the default.
function createHiddenRate(host: Layer, phaseSlot: ParameterSlot, rateHz: number): void {
  const rate = new TempoLayer(rateHz)
  Layer.assignDebugName(rate)
  rate.bounds = { ...host.bounds }
  rate.insertAbove(host)
  rate.isHiddenHelper = true
  rate.helperHost = host
  host.hiddenHelper = rate
  bindRateClock(rate)
  BindingLayer.create(rate, phaseSlot)
}

// Auto-bind a phase slot to a Rate or Clock layer, creating a hidden helper
// TempoLayer above `host` (fed by the shared singleton Clock) if neither is
// found nearby. Used by RotateLayer.
function ensurePhaseSource(host: Layer, phaseSlot: ParameterSlot): void {
  if (phaseSlot.isActive) return

  let phaseSource: TempoLayer | ClockLayer | null = null
  for (let l: Layer | null = host.layerBelow; l !== null; l = l.layerBelow) {
    if (l instanceof TempoLayer || l instanceof ClockLayer) { phaseSource = l; break }
  }
  if (phaseSource === null) {
    for (let l: Layer | null = host.layerAbove; l !== null; l = l.layerAbove) {
      if (l instanceof TempoLayer || l instanceof ClockLayer) { phaseSource = l; break }
    }
  }

  if (phaseSource === null) {
    createHiddenRate(host, phaseSlot, 1.0)
    return
  }

  BindingLayer.create(phaseSource, phaseSlot)
}

// Log-uniform random rate in [0.1, 1.5] Hz — spread across octaves so each
// new AnimPath feels distinct from others.
function randomAnimRate(): number {
  const logMin = Math.log(0.1), logMax = Math.log(1.5)
  return Math.exp(logMin + Math.random() * (logMax - logMin))
}

function wireColourFillButton(layer: ColourLayer): void {
  layer.setOnAddFill(() => {
    const fill = new FillLayer()
    Layer.assignDebugName(fill)
    fill.bounds = { x: X, y: 24, width: W, height: 36 }
    fill.insertBelow(layer)
    BindingLayer.create(layer, fill.colourASlot)
    postInsertLayer(fill)
    refreshStack()
  })
}

// Wire a ColourLayer's sample-image-slot auto-setup: when an image source
// is first bound to the sample image slot (while the sample point slot is
// still unbound), create a PointLayer immediately above that image source,
// bind it to the sample point slot, enable sampling, and select the PointLayer.
function wireColourSampleSetup(layer: ColourLayer): void {
  layer.setOnSampleImageBound(() => {
    const imgSource = layer.sampleImageSlot.source
    if (!(imgSource instanceof Layer)) return

    const pt = new PointLayer({ x: Node.canvasWidth / 2, y: Node.canvasHeight / 2 })
    Layer.assignDebugName(pt)
    pt.bounds = { x: X, y: 24, width: W, height: 36 }

    // Place immediately above the image source if it is in the main stack,
    // otherwise fall back to above the ColourLayer itself.
    pt.insertAbove(!imgSource.outsideStack ? imgSource : layer)

    BindingLayer.create(pt, layer.samplePointSlot)
    layer.enableSampling()

    postInsertLayer(pt)
    refreshStack(pt)
  })
}

// All per-type setup that runs after a new layer is inserted into the stack.
// Called from both the MenuLayer onAdded callback and wireTutorialLayer so
// that every creation path (menu, tutorial buttons) gets identical behaviour.
function postInsertLayer(newLayer: Layer): void {
  if (newLayer instanceof TempoLayer) {
    // Bind to the shared singleton Clock immediately, so the rate's phase
    // starts advancing as soon as the layer appears.
    bindRateClock(newLayer)
  }
  if (newLayer instanceof CollectionLayer) {
    newLayer.setEjectCallback(() => refreshStack())
  }
  if (newLayer instanceof TutorialLayer) {
    wireTutorialLayer(newLayer)
  }
  if (newLayer instanceof ClipLayer) {
    wireClipLayer(newLayer)
  }
  if (newLayer instanceof ImageLayer) {
    wireImageLayer(newLayer)
    newLayer.opacityWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy)
  }
  if (newLayer instanceof StrokeLayer) {
    newLayer.setOnClose((stroke) => {
      const below = stroke.layerBelow   // record position before removal
      const snap  = stroke.getStateSnapshot()

      const pl = new PathLayer(snap.points)
      Layer.assignDebugName(pl)
      pl.bounds = { ...stroke.bounds }
      pl.applyStateSnapshot(snap)
      pl.insertAbove(below ?? root)

      deletionLayer.archive(stroke)
      postInsertLayer(pl)
      refreshStack(pl)
    })
  }
  const _isTrackShapeLayer = (l: Layer) =>
    l instanceof TrackRectLayer || l instanceof TrackEllipseLayer || l instanceof TrackPathLayer

  if (newLayer instanceof ShapeLayer &&
      !(newLayer instanceof ClipRectLayer) &&
      !(newLayer instanceof ClipEllipseLayer) &&
      !(newLayer instanceof ClipPathLayer) &&
      !_isTrackShapeLayer(newLayer)) {
    wireAnimatableShape(newLayer)
  }
  if (newLayer instanceof ShapeLayer &&
      !(newLayer instanceof ClipRectLayer) &&
      !(newLayer instanceof ClipEllipseLayer) &&
      !(newLayer instanceof ClipPathLayer) &&
      !_isTrackShapeLayer(newLayer)) {
    wireMaskButton(newLayer)
  }
  if (newLayer instanceof TextLayer) {
    wireTextMaskButton(newLayer)
    wirePointButton(newLayer)
    newLayer.opacityWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy)
  }
  if (newLayer instanceof LineLayer) {
    wireLineMaskButton(newLayer)
    const wi = (slot: ParameterSlot, cx: number, cy: number) => interaction.showInspectorForSlot(slot, cx, cy)
    newLayer.widthWidget.onInspectorRequest   = wi
    newLayer.opacityWidget.onInspectorRequest = wi
  }
  if (newLayer instanceof TraceLayer) wireTraceButtons(newLayer)
  if (newLayer instanceof ShapeLayer &&
      !(newLayer instanceof ClipRectLayer) &&
      !(newLayer instanceof ClipEllipseLayer) &&
      !(newLayer instanceof ClipPathLayer) &&
      !_isTrackShapeLayer(newLayer)) wirePointButton(newLayer)
  if (newLayer instanceof LineLayer) wirePointButton(newLayer)
  if (newLayer instanceof StrokeLayer) wireStrokeSnapPoint(newLayer)
  if (newLayer instanceof LineLayer)   wireLineSnapPoint(newLayer)
  applyDefaultBindings(newLayer)

  if (newLayer instanceof AmountLayer) {
    wireCalcButton(newLayer)
  }

  if (newLayer instanceof AnimPathLayer) {
    wireAnimPathLayer(newLayer)

    // Auto-bind shape slot to the first samplePerimeter-capable layer below.
    if (!newLayer.shapeSlot.isActive) {
      let l: Layer | null = newLayer.layerBelow
      while (l !== null) {
        if (!l.isInfrastructure && 'samplePerimeter' in l) {
          BindingLayer.create(l, newLayer.shapeSlot)
          break
        }
        l = l.layerBelow
      }
    }

    // Always create a fresh hidden Rate layer for each AnimPath, with a random
    // rate, so multiple AnimPaths don't share the same speed by default.
    if (!newLayer.phaseSlot.isActive) {
      createHiddenRate(newLayer, newLayer.phaseSlot, randomAnimRate())
    }
  }

  if (newLayer instanceof RotateLayer) {
    // Same phase auto-binding as AnimPathLayer.
    ensurePhaseSource(newLayer, newLayer.phaseSlot)
  }

  if (newLayer instanceof FillLayer) {
    // Search down the stack for up to two Colour-producing layers: the
    // first found is bound to colourASlot, the second (if any) to
    // colourBSlot. Mode stays 'fill' (the default) — colourBSlot is inert
    // until the user switches to a gradient mode.
    const cols: Layer[] = []
    for (let l: Layer | null = newLayer.layerBelow; l !== null && cols.length < 2; l = l.layerBelow) {
      if (!l.isInfrastructure && !l.isHiddenHelper && l.types.has(ValueType.Colour)) cols.push(l)
    }
    if (cols[0] && !newLayer.colourASlot.isActive) BindingLayer.create(cols[0], newLayer.colourASlot)
    if (cols[1] && !newLayer.colourBSlot.isActive) BindingLayer.create(cols[1], newLayer.colourBSlot)
    // Wire the opacity SliderSlot's inspector button to the InteractionSystem panel.
    newLayer.opacityWidget.onInspectorRequest = (slot, cx, cy) =>
      interaction.showInspectorForSlot(slot, cx, cy)
  }

  if (newLayer instanceof PointLayer) {
    const wireInspector = (slot: ParameterSlot, cx: number, cy: number) =>
      interaction.showInspectorForSlot(slot, cx, cy)
    newLayer.amountWidget.onInspectorRequest = wireInspector
    newLayer.speedWidget.onInspectorRequest  = wireInspector
  }

  if (newLayer instanceof ShapeLayer) {
    const wi = (slot: ParameterSlot, cx: number, cy: number) => interaction.showInspectorForSlot(slot, cx, cy)
    newLayer.opacityWidget.onInspectorRequest      = wi
    newLayer.strokeWidthWidget.onInspectorRequest  = wi
    newLayer.scaleWidget.onInspectorRequest        = wi
    if (newLayer instanceof PathLayer) newLayer.radiusWidget.onInspectorRequest = wi
  }

  if (newLayer instanceof TransformLayer) {
    newLayer.opacityWidget.onInspectorRequest = (slot, cx, cy) =>
      interaction.showInspectorForSlot(slot, cx, cy)
  }

  if (newLayer instanceof CompositeLayer) {
    newLayer.blendWidget.onInspectorRequest = (slot, cx, cy) =>
      interaction.showInspectorForSlot(slot, cx, cy)
  }

  if (newLayer instanceof FilterLayer) {
    newLayer.wireSliderInspectors((slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy))
  }

  if (newLayer instanceof MathLayer) {
    newLayer.wireSliderInspectors((slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy))
  }

  if (newLayer instanceof MotionBlurLayer) {
    const wire = (slot: ParameterSlot, cx: number, cy: number) =>
      interaction.showInspectorForSlot(slot, cx, cy)
    newLayer.fadeWidget.onInspectorRequest  = wire
    newLayer.delayWidget.onInspectorRequest = wire
  }

  if (newLayer instanceof DirectionLayer) {
    newLayer.speedWidget.onInspectorRequest = (slot, cx, cy) =>
      interaction.showInspectorForSlot(slot, cx, cy)
  }

  if (newLayer instanceof NoiseLayer) {
    // "time" is the shared singleton Clock's raw, unbounded elapsed time —
    // no modulo wrap, so there is no periodic "pop". The noise's own
    // "speed" parameter scales how fast it actually evolves.
    if (!newLayer.timeSlot.isActive) {
      BindingLayer.create(clock, newLayer.timeSlot)
    }
    const wire = (slot: ParameterSlot, cx: number, cy: number) =>
      interaction.showInspectorForSlot(slot, cx, cy)
    newLayer.scaleWidget.onInspectorRequest  = wire
    newLayer.speedWidget.onInspectorRequest  = wire
    newLayer.detailWidget.onInspectorRequest = wire
    newLayer.driftWidget.onInspectorRequest   = wire
    newLayer.opacityWidget.onInspectorRequest = wire
  }

  if (newLayer instanceof TileLayer) {
    newLayer.opacityWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy)
  }

  if (newLayer instanceof ColourLayer) {
    wireColourFillButton(newLayer)
    wireColourSampleSetup(newLayer)
  }
  if (newLayer instanceof VideoLayer) {
    wireVideoTrackButton(newLayer)
    newLayer.opacityWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy)
  }
  if (newLayer instanceof TrackRectLayer || newLayer instanceof TrackEllipseLayer ||
      newLayer instanceof TrackPathLayer  || newLayer instanceof TrackDrawingLayer) {
    wireTrackLayer(newLayer)
  }
  if (newLayer instanceof ClipRectLayer || newLayer instanceof ClipEllipseLayer || newLayer instanceof ClipPathLayer || newLayer instanceof ClipDrawingLayer) {
    wireClipShapeLayer(newLayer)

    // The hidden helper is a plain MaskLayer directly below the Clip layer,
    // with no handles of its own — its content tracks the Clip layer's own
    // shape mask (setMaskTracker) and is bound to maskSlot so it can be
    // exposed by clicking that (bound) slot.
    const maskHelper = new MaskLayer()
    Layer.assignDebugName(maskHelper)
    maskHelper.bounds = { ...newLayer.bounds }
    maskHelper.insertBelow(newLayer)
    maskHelper.isHiddenHelper = true
    maskHelper.helperHost = newLayer
    newLayer.hiddenHelper = maskHelper
    newLayer.helperBelow = true
    newLayer.setMaskTracker(maskHelper)

    BindingLayer.create(maskHelper, newLayer.maskSlot)
  }

  if (newLayer instanceof ClipTextLayer) {
    // Same hidden-helper pattern as the other Clip<Shape> layers, but bound
    // to clipMaskSlot — TextLayer's own (pre-existing) maskSlot is a
    // different feature (flows the glyphs inside a bound mask shape).
    const maskHelper = new MaskLayer()
    Layer.assignDebugName(maskHelper)
    maskHelper.bounds = { ...newLayer.bounds }
    maskHelper.insertBelow(newLayer)
    maskHelper.isHiddenHelper = true
    maskHelper.helperHost = newLayer
    newLayer.hiddenHelper = maskHelper
    newLayer.helperBelow = true
    newLayer.setMaskTracker(maskHelper)

    BindingLayer.create(maskHelper, newLayer.clipMaskSlot)
  }
}

// Wire an AmountLayer's "Calc" convenience button: creates a MathLayer below,
// binds the AmountLayer as its input, and selects the new MathLayer.
function wireCalcButton(layer: AmountLayer): void {
  layer.setOnAddCalc(() => {
    const math = new MathLayer()
    Layer.assignDebugName(math)
    math.bounds = { x: X, y: 24, width: W, height: 36 }
    math.insertBelow(layer)
    BindingLayer.create(layer, math.inputSlot)
    postInsertLayer(math)
    refreshStack(math)   // select the new Calc layer
  })
}

// Wire an AnimPathLayer's bottom "Amount" convenience button: creates an
// AmountLayer below, binds AnimPath's Point output to its y-position slot,
// and keeps the AnimPath layer selected.
function wireAnimPathLayer(animPath: AnimPathLayer): void {
  animPath.setOnAddAmount(() => {
    const amount = new AmountLayer()
    Layer.assignDebugName(amount)
    amount.bounds = { x: X, y: 24, width: W, height: 36 }
    amount.insertBelow(animPath)
    BindingLayer.create(animPath, amount.ySlot)
    postInsertLayer(amount)
    refreshStack()   // no arg → current selection (animPath) unchanged
  })
}

// Wire an ImageLayer's "Clip" and "Filter" convenience buttons. Pressing
// either inserts the new layer above the image, binds the image as its
// source, then sends the image to BackgroundLayer.
function wireImageLayer(layer: ImageLayer): void {
  layer.setOnAddClip(() => {
    const clip = new ClipLayer()
    Layer.assignDebugName(clip)
    clip.bounds = { x: X, y: 24, width: W, height: 36 }
    clip.insertAbove(layer)
    BindingLayer.create(layer, clip.imageSlot)
    backgroundLayer.add(layer)
    postInsertLayer(clip)
    refreshStack(clip)
  })
  layer.setOnAddFilter(() => {
    const filter = new FilterLayer()
    Layer.assignDebugName(filter)
    filter.bounds = { x: X, y: 24, width: W, height: 36 }
    filter.insertAbove(layer)
    BindingLayer.create(layer, filter.sourceSlot)
    backgroundLayer.add(layer)
    postInsertLayer(filter)
    refreshStack(filter)
  })
}

// Wire a shape or stroke layer's "Animate" convenience button. Pressing it
// inserts an AnimPathLayer above the shape, binds the shape as its perimeter
// source, and selects the new layer. The shape stays in the stack.
function wireAnimatableShape(layer: ShapeLayer): void {
  layer.setOnAddAnimate(() => {
    const animPath = new AnimPathLayer(Node.canvasWidth / 2, Node.canvasHeight / 2)
    Layer.assignDebugName(animPath)
    animPath.bounds = { x: X, y: 24, width: W, height: 36 }
    animPath.insertAbove(layer)
    BindingLayer.create(layer, animPath.shapeSlot)
    postInsertLayer(animPath)
    refreshStack(animPath)
  })
}

function wireMaskButton(layer: ShapeLayer): void {
  layer.setOnAddMask(() => {
    const mask = new MaskLayer()
    Layer.assignDebugName(mask)
    mask.bounds = { ...layer.bounds }
    mask.insertBelow(layer)
    BindingLayer.create(layer, mask.firstShapeSlot)
    postInsertLayer(mask)
    refreshStack()   // no arg — keep shape layer selected
  })
}

function wireTextMaskButton(layer: TextLayer): void {
  layer.setOnAddMask(() => {
    const mask = new MaskLayer()
    Layer.assignDebugName(mask)
    mask.bounds = { ...layer.bounds }
    mask.insertBelow(layer)
    BindingLayer.create(layer, mask.firstShapeSlot)
    postInsertLayer(mask)
    refreshStack()
  })
}

function wireLineMaskButton(layer: LineLayer): void {
  layer.setOnAddMask(() => {
    const mask = new MaskLayer()
    Layer.assignDebugName(mask)
    mask.bounds = { ...layer.bounds }
    mask.insertBelow(layer)
    BindingLayer.create(layer, mask.firstShapeSlot)
    postInsertLayer(mask)
    refreshStack()
  })
}

function wireTraceButtons(layer: TraceLayer): void {
  layer.setOnAddPath(() => {
    const pts = layer.getControlPoints()
    if (pts.length < 3) return
    const c  = Node.greyDefault ? OUTLINE_COLOUR : rndColour()
    const pl = new PathLayer(pts, 0, 0, c)
    Layer.assignDebugName(pl)
    pl.bounds = { ...layer.bounds }
    pl.insertAbove(layer)
    postInsertLayer(pl)
    refreshStack(pl)
  })

  layer.setOnAddClip(() => {
    const pts = layer.getControlPoints()
    if (pts.length < 3) return
    const c   = Node.greyDefault ? OUTLINE_COLOUR : rndColour()
    const clip = new ClipPathLayer(pts, c)
    Layer.assignDebugName(clip)
    clip.bounds = { ...layer.bounds }
    clip.insertAbove(layer)
    // Bind the same image source that feeds this TraceLayer.
    const imgBinding = BindingLayer.findForSlot(layer.imageSlot)
    if (imgBinding !== null) {
      BindingLayer.create(imgBinding.source, clip.imageSlot)
      backgroundLayer.add(imgBinding.source as Layer)
    }
    postInsertLayer(clip)
    refreshStack(clip)
  })
}

function wirePointButton(layer: ShapeLayer | LineLayer | TextLayer): void {
  layer.setOnAddPoint(() => {
    // Use the layer's first reference point as initial position so the binding
    // starts as a no-op (the PointLayer is already at the ref point it will drive).
    const src = layer as unknown as { getRefPoints?(): { x: number; y: number }[] }
    const refPts = typeof src.getRefPoints === 'function' ? src.getRefPoints() : []
    const initPt = refPts[0] ?? { x: Node.canvasWidth / 2, y: Node.canvasHeight / 2 }
    const pt = new PointLayer(initPt)
    Layer.assignDebugName(pt)
    pt.bounds = { x: X, y: 24, width: W, height: 36 }
    pt.insertAbove(layer)
    BindingLayer.create(layer, pt.shapeSlot)
    pt.setShapeEnabled(true)
    postInsertLayer(pt)
    refreshStack(pt)
  })
}

// Create a PointLayer pinned to a shape's ref point, then bind it as the
// stroke's start or end endpoint. Called when the user drags an endpoint
// onto a shape's reference point during a StrokeLayer or LineLayer edit.
function createSnapPointLayer(
  shapeLayer: Layer,
  refIdx:     number,
  above:      Layer,
): PointLayer {
  const src = shapeLayer as unknown as { getRefPoints?(): { x: number; y: number }[] }
  const refPts = typeof src.getRefPoints === 'function' ? src.getRefPoints() : []
  const initPt = refPts[refIdx] ?? { x: Node.canvasWidth / 2, y: Node.canvasHeight / 2 }
  const pt = new PointLayer(initPt)
  Layer.assignDebugName(pt)
  pt.bounds = { x: X, y: 24, width: W, height: 36 }
  pt.insertAbove(above)
  pt.isHiddenHelper = true
  pt.helperHost = above
  above.hiddenHelper = pt
  BindingLayer.create(shapeLayer, pt.shapeSlot)
  pt.setShapeRefIndex(refIdx)
  pt.setShapeEnabled(true)
  postInsertLayer(pt)
  return pt
}

function wireStrokeSnapPoint(stroke: StrokeLayer): void {
  stroke.setOnSnapPoint((which, shapeLayer, refIdx) => {
    const pt = createSnapPointLayer(shapeLayer, refIdx, stroke)
    const slot = which === 'start' ? stroke.startSlot : stroke.endSlot
    BindingLayer.create(pt, slot)
    refreshStack()
  })
}

function wireLineSnapPoint(line: LineLayer): void {
  line.setOnSnapPoint((which, shapeLayer, refIdx) => {
    const pt = createSnapPointLayer(shapeLayer, refIdx, line)
    const slot = which === 'start' ? line.startSlot : line.endSlot
    BindingLayer.create(pt, slot)
    refreshStack()
  })
}

// Wire a Clip<Shape> layer's bottom "Move" convenience button. Pressing it
// inserts a TransformLayer above the clip layer, binds the clip as the
// transform's image source, then sends both the clip layer and its hidden
// mask-tracker helper to BackgroundLayer so they keep recomputing while the
// stack stays clean.
type ClipShapeMovable = ClipRectLayer | ClipEllipseLayer | ClipPathLayer | ClipDrawingLayer
function wireClipShapeLayer(layer: ClipShapeMovable): void {
  layer.setOnAddMove(() => {
    const transform = new TransformLayer(Node.canvasWidth, Node.canvasHeight)
    Layer.assignDebugName(transform)
    transform.bounds = { x: X, y: 24, width: W, height: 36 }
    // Insert transform directly above the clip layer, then remove clip from
    // the stack: transform ends up at the clip's old position.
    transform.insertAbove(layer)
    BindingLayer.create(layer, transform.sourceSlot)
    const helper = layer.hiddenHelper
    backgroundLayer.add(layer)
    if (helper !== null) backgroundLayer.add(helper)
    postInsertLayer(transform)
    refreshStack(transform)
  })
}

// Wire VideoLayer's "Track" convenience button. Creates a TrackEllipseLayer
// above the VideoLayer and binds the video feed to its imageSlot.
function wireVideoTrackButton(videoLayer: VideoLayer): void {
  videoLayer.setOnAddTrack(() => {
    const tracker = new TrackEllipseLayer()
    Layer.assignDebugName(tracker)
    tracker.bounds = { x: X, y: 24, width: W, height: 36 }
    tracker.insertAbove(videoLayer)
    BindingLayer.create(videoLayer, tracker.imageSlot)
    postInsertLayer(tracker)
    refreshStack(tracker)
  })
}

type TrackLayer = TrackRectLayer | TrackEllipseLayer | TrackPathLayer | TrackDrawingLayer

// Wire the replacement buttons on a Track* layer. Pressing Rect/Ellipse/Path/Draw
// replaces this layer with the chosen tracker type, transferring the image
// binding and any downstream Point consumers.
function wireTrackLayer(layer: TrackLayer): void {
  const replaceWith = (factory: () => TrackLayer) => {
    const below = layer.layerBelow

    const imgBinding = BindingLayer.findForSlot(layer.imageSlot)
    const imgSource  = imgBinding?.source ?? null
    imgBinding?.remove()

    const outBindings = [...layer.dependents].filter(
      (d): d is BindingLayer => d instanceof BindingLayer,
    )

    const newTracker = factory()
    Layer.assignDebugName(newTracker)
    newTracker.bounds = { ...layer.bounds }
    newTracker.insertAbove(below ?? root)

    if (imgSource !== null) BindingLayer.create(imgSource, newTracker.imageSlot)
    for (const bl of outBindings) BindingLayer.create(newTracker, bl.slot)

    deletionLayer.archive(layer)
    postInsertLayer(newTracker)
    refreshStack(newTracker)
  }

  if (layer instanceof TrackEllipseLayer) {
    layer.setOnReplaceRect(() => replaceWith(() => new TrackRectLayer()))
    layer.setOnReplacePath(() => replaceWith(() => new TrackPathLayer()))
    layer.setOnReplaceDraw(() => replaceWith(() => new TrackDrawingLayer()))
  } else if (layer instanceof TrackRectLayer) {
    layer.setOnReplaceEllipse(() => replaceWith(() => new TrackEllipseLayer()))
    layer.setOnReplacePath   (() => replaceWith(() => new TrackPathLayer()))
    layer.setOnReplaceDraw   (() => replaceWith(() => new TrackDrawingLayer()))
  } else if (layer instanceof TrackPathLayer) {
    layer.setOnReplaceRect   (() => replaceWith(() => new TrackRectLayer()))
    layer.setOnReplaceEllipse(() => replaceWith(() => new TrackEllipseLayer()))
    layer.setOnReplaceDraw   (() => replaceWith(() => new TrackDrawingLayer()))
  } else if (layer instanceof TrackDrawingLayer) {
    layer.setOnReplaceRect   (() => replaceWith(() => new TrackRectLayer()))
    layer.setOnReplaceEllipse(() => replaceWith(() => new TrackEllipseLayer()))
    layer.setOnReplacePath   (() => replaceWith(() => new TrackPathLayer()))
  }
}

// Wire a ClipLayer's bottom-row "replace with specialised Clip<Shape>"
// buttons. Pressing one creates the chosen layer at this ClipLayer's stack
// position, carries over the image binding (if any) and redirects any
// consumers of this ClipLayer's image output to the new layer, then either
// archives the old ClipLayer (recoverable via DeletionLayer, same as Delete)
// or — if it had no other bindings/manual transform worth keeping — purges
// it permanently.
function wireClipLayer(clipLayer: ClipLayer): void {
  clipLayer.setOnReplace((factory: () => ClipShapeLayer) => {
    const below = clipLayer.layerBelow
    if (below === null) return

    const newLayer = factory()
    Layer.assignDebugName(newLayer)
    newLayer.bounds = { ...clipLayer.bounds }

    // Carry over the image binding, if any.
    const imgBinding = BindingLayer.findForSlot(clipLayer.imageSlot)
    const imgSource  = imgBinding?.source ?? null
    imgBinding?.remove()

    // Redirect any layers consuming this ClipLayer's image output.
    const outBindings = [...clipLayer.dependents].filter(
      (d): d is BindingLayer => d instanceof BindingLayer,
    )

    newLayer.insertAbove(below)

    if (imgSource !== null) {
      BindingLayer.create(imgSource, newLayer.imageSlot)
    }
    for (const bl of outBindings) {
      BindingLayer.create(newLayer, bl.slot)
    }

    if (clipLayer.hasRestorableState()) {
      deletionLayer.archive(clipLayer)
    } else {
      clipLayer.removeFromStack()
      graph.unregister(clipLayer)
    }

    postInsertLayer(newLayer)
    refreshStack(newLayer)
  })
}

function wireTutorialLayer(tl: TutorialLayer): void {
  tl.setOnAdded((newLayer) => {
    Layer.assignDebugName(newLayer)
    newLayer.bounds = { x: X, y: 24, width: W, height: 36 }
    const below = tl.layerBelow
    if (below !== null) newLayer.insertAbove(below)
    postInsertLayer(newLayer)
    refreshStack(tl)   // keep TutorialLayer selected, like MenuLayer keeps itself selected
  })
}

// ------------------------------------------------------------------
// Generic shape factory — used to populate empty slots that are
// conventionally bound to a shape (AnimPath's shape slot, MaskLayer's
// shape slots; see Layer.wantsShapeForSlot). Picks a closed shape type at
// random and starts it in outline mode, since its role here is to define
// a region/path, not to add coloured content.
// ------------------------------------------------------------------
function randomClosedShapeLayer(canvasW: number, canvasH: number): Layer {
  const s = rndShape(canvasW, canvasH)
  const pick = Math.floor(Math.random() * 3)
  const c = Node.greyDefault ? OUTLINE_COLOUR : rndColour()
  const shape =
    pick === 0 ? new RectLayer(s.cx, s.cy, s.sw, s.sh, c) :
    pick === 1 ? new EllipseLayer(s.cx, s.cy, s.sw, s.sh, c) :
    new PathLayer(undefined, s.cx, s.cy, c)
  shape.setFilled(false)
  return shape
}

// Search down the stack from `consumer` for an existing shape layer whose
// silhouette could serve as a Mask's initial content — used when an empty
// Mask-typed slot (other than MaskLayer's own shape slots, see
// Layer.wantsShapeForSlot) is clicked.
function findSuitableMaskShape(consumer: Layer): Layer | null {
  for (let l: Layer | null = consumer.layerBelow; l !== null; l = l.layerBelow) {
    if (l.isInfrastructure || l.isHiddenHelper) continue
    if (l instanceof RectLayer || l instanceof EllipseLayer || l instanceof PathLayer ||
        l instanceof TextLayer) return l
  }
  return null
}

// ------------------------------------------------------------------
// Canonical default layer for each value type — used when the user
// clicks an empty parameter slot.
// ------------------------------------------------------------------
const DEFAULT_VALUE_LAYER: Partial<Record<ValueType, (w: number, h: number) => Layer>> = {
  [ValueType.Amount]:    ()     => new AmountLayer(0.5),
  [ValueType.Colour]:    ()     => new ColourLayer(rndColour()),
  [ValueType.Point]:     (w, h) => new PointLayer({ x: w / 2, y: h / 2 }),
  [ValueType.Direction]: ()     => new DirectionLayer(0, 1),
  [ValueType.Rate]:      ()     => new TempoLayer(1.0),
  [ValueType.Count]:     ()     => new CountLayer(0),
  [ValueType.Event]:     ()     => new EventLayer(),
  [ValueType.Image]:     ()     => new ImageLayer(),
  [ValueType.Mask]:      ()     => new MaskLayer(),
  [ValueType.Collection]:()     => new CollectionLayer(),
}

// Panel-height override for the canonical layer of a given type
// (mirrors MenuLayer.BUTTONS — only ColourLayer needs extra height).
const DEFAULT_VALUE_HEIGHT: Partial<Record<ValueType, number>> = {
  [ValueType.Colour]: 170,
}

// ------------------------------------------------------------------
// Canvas setup
// ------------------------------------------------------------------
const app = document.getElementById('app')!
const container = document.createElement('div')
container.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden'
app.appendChild(container)

// Content canvas: CSS-transformed for pan/zoom; always at least as large as
// the viewport (never shrinks). touch-action:none prevents the browser from
// intercepting swipe/pinch gestures before InteractionSystem sees them.
//
// The canvas is kept large enough for full menu/tutorial layout (min 800×600)
// so that zooming out reveals off-screen controls on both mobile and desktop.
// The widget canvas and Node.viewportWidth/Height track the actual screen size,
// so layers can centre their artistic content within the visible area even
// when the canvas backing store is larger.
const MIN_CANVAS_W = 800   // enough for 4 menu columns at full width
const MIN_CANVAS_H = 600   // enough for all menu rows / tutorial content
const canvas = document.createElement('canvas')
canvas.width  = Math.max(window.innerWidth,  MIN_CANVAS_W)
canvas.height = Math.max(window.innerHeight, MIN_CANVAS_H)
canvas.style.cssText = 'position:absolute;top:0;left:0;touch-action:none;transform-origin:0 0'
container.appendChild(canvas)
Node.canvasElement = canvas

// Widget canvas: always viewport-sized, overlaid with pointer-events:none so
// touches pass through to the content canvas. The LayerStackWidget renders
// here so it stays fixed even while the content canvas is panned/zoomed.
const widgetCanvas = document.createElement('canvas')
widgetCanvas.width  = window.innerWidth
widgetCanvas.height = window.innerHeight
widgetCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none'
container.appendChild(widgetCanvas)

// ------------------------------------------------------------------
// Evaluator (drives the render loop)
// ------------------------------------------------------------------
// Detect touch-primary devices so Evaluator can decide whether control pills
// should be fixed in the viewport (desktop) or move with the canvas (mobile).
Node.isMobileDevice = window.matchMedia('(pointer: coarse)').matches

// Desktop default: coloured outlines suit the fine-arts artistic mode audience.
// Mobile: filled coloured shapes (outlines too fine to read; artistic detail lost).
Node.outlineDefault = true
if (Node.isMobileDevice) {
  Node.artisticMode   = false
  Node.outlineDefault = false
}

const evaluator = new Evaluator(canvas, widgetCanvas)
// Correct viewport — canvas may be larger than the viewport on mobile.
// This also resizes the widget canvas to the actual viewport size so it
// stays viewport-sized rather than matching the oversized content canvas.
evaluator.setViewport(window.innerWidth, window.innerHeight)

// ------------------------------------------------------------------
// Initial stack: Root → MenuLayer  (DeletionLayer added on first deletion)
// ------------------------------------------------------------------
// X/W size every layer's "strip pill" (debug panel, this.bounds) — it's
// normally hidden under the LayerStackWidget. X + W must stay comfortably
// below WIDGET_MIN (120, see interaction/layout.ts) so it stays hidden even
// at the narrowest widget width, with margin for label text overflow.
const X = 8
const W = 100

const root = new RootLayer(canvas.width, canvas.height)

// Singleton Clock — created once at startup, hidden (outsideStack) until
// the user clicks Root's clockSlot to expose it. Every TempoLayer shares
// this same instance via ensurePhaseSource; Evaluator ticks it directly
// every frame regardless of stack membership.
const clock = new ClockLayer()
Layer.assignDebugName(clock)
clock.bounds = { x: X, y: 24, width: W, height: 36 }
clock.outsideStack = true
root.setClock(clock)
evaluator.setClock(clock)
Node.clock = clock

const deletionLayer = new DeletionLayer()
deletionLayer.bounds = { x: X, y: 24, width: W, height: 36 }
// Permanently part of the stack, directly above Root — invisible (like
// Root) until it holds an archived layer or the user navigates to it.
deletionLayer.insertAbove(root)

// Background collection — never part of the layer stack; the Evaluator
// evaluates it directly every frame so its items keep recomputing while
// off-canvas. Browsed via DeletionLayer's toggle.
const backgroundLayer = new BackgroundLayer()
evaluator.setBackground(backgroundLayer)
deletionLayer.setBackgroundLayer(backgroundLayer)

// ------------------------------------------------------------------
// Widget, interaction, helpers
// ------------------------------------------------------------------
const widget = new LayerStackWidget(widgetCanvas)
widget.setVisible(false)   // hidden at startup; revealed when a mode is chosen
evaluator.setLayerStackWidget(widget)

// Lets any layer change the selected/current layer programmatically —
// see CaptureLayer's edit-mode shutter sequence.
Node.selectLayer = (layer) => {
  if (layer instanceof Layer) widget.selected = layer
}

// Lets any layer render the LayerStackWidget into its own canvas — see
// CaptureLayer's stack-capture toggle.
Node.renderStackWidget = (ctx) => widget.render(ctx, true)
Node.sendToBackground = (node) => { if (node instanceof Layer) backgroundLayer.add(node) }
Node.markAllDirty = () => { for (const n of graph.nodes) n.forceDirty() }

const interaction = new InteractionSystem(canvas)
interaction.setLayerStackWidget(widget)
interaction.setSpaceAction(() => evaluator.toggleDisplayMode())
interaction.setDisplayModeGetter(() => evaluator.displayMode)

// Apply any auto-bind rules declared by a newly-added layer.
// Each rule names a slot and a predicate; we walk down the stack and bind
// the first non-infrastructure layer that satisfies the predicate.
function applyDefaultBindings(newLayer: Layer): void {
  for (const { slot, accepts, sendToBackgroundAfterBind } of newLayer.autoBindRules()) {
    if (slot.isActive) continue
    for (let l: Layer | null = newLayer.layerBelow; l !== null; l = l.layerBelow) {
      if (!l.isInfrastructure && !l.isHiddenHelper && accepts(l)) {
        BindingLayer.create(l, slot)
        if (sendToBackgroundAfterBind) {
          backgroundLayer.add(l)
        }
        break
      }
    }
  }
}

// Helper: refresh evaluator + widget + interaction after stack mutations.
const refreshStack = (selectLayer?: Layer) => {
  let top: Layer = root
  while (top.layerAbove !== null) top = top.layerAbove

  evaluator.setStack(top)
  widget.setStack(top)
  interaction.setStack(top)
  if (selectLayer !== undefined) widget.selected = selectLayer
}

// The lowest layer above which new user layers should be inserted —
// DeletionLayer is permanently part of the stack directly above Root.
function lowestAnchor(): Layer { return deletionLayer }

// Insert `newLayer` above `selected` — except when RootLayer itself is
// selected, in which case DeletionLayer sits directly above Root (even when
// empty/not visible) and the new layer must go above that instead, so it
// isn't buried below it.
function insertAboveSelected(newLayer: Layer, selected: Layer): void {
  newLayer.insertAbove(selected instanceof RootLayer ? lowestAnchor() : selected)
}

// MenuLayer sits at the very top.
const menuLayer = new MenuLayer((newLayer, selectAfterCreate) => {
  postInsertLayer(newLayer)
  refreshStack(selectAfterCreate ? newLayer : menuLayer)
})
menuLayer.debugName = 'Menu'
menuLayer.bounds    = { x: X, y: 24, width: W, height: 36 }
// menuLayer is NOT inserted at startup — StartupLayer handles that.

// ------------------------------------------------------------------
// Save / Load — wired to MenuLayer's "Save"/"Load" buttons.
// On mobile: IndexedDB gallery with preview thumbnails.
// On desktop: download/upload JSON files.
// ------------------------------------------------------------------
const isMobile = navigator.maxTouchPoints > 1

const persistenceCtx: Persistence.PersistenceContext = {
  root, clock, deletionLayer, backgroundLayer, menuLayer, selected: null,
}

// ── Shared: apply a loaded SaveFile to the running session ──────
async function applyLoadedSession(json: Persistence.SaveFile): Promise<void> {
  let selected: Layer | null = null
  try {
    selected = await Persistence.deserialize(json, persistenceCtx)
  } catch (err) {
    console.warn('Persistence: failed to load save file', err)
    return
  }
  // Restore callbacks on any layers that need post-insert wiring —
  // Persistence.deserialize doesn't call main.ts callbacks.
  const isClipShapeMovable = (l: Layer): l is ClipShapeMovable =>
    l instanceof ClipRectLayer || l instanceof ClipEllipseLayer ||
    l instanceof ClipPathLayer || l instanceof ClipDrawingLayer

  const isTrackShapeLayer = (l: Layer) =>
    l instanceof TrackRectLayer || l instanceof TrackEllipseLayer || l instanceof TrackPathLayer

  const isAnimatableShape = (l: Layer): l is ShapeLayer =>
    l instanceof ShapeLayer && !isClipShapeMovable(l) && !isTrackShapeLayer(l)

  let scanL: Layer | null = root
  while (scanL !== null) {
    if (scanL instanceof CollectionLayer)  scanL.setEjectCallback(() => refreshStack())
    if (scanL instanceof AmountLayer)      wireCalcButton(scanL)
    if (scanL instanceof AnimPathLayer)    wireAnimPathLayer(scanL)
    if (scanL instanceof ColourLayer)      { wireColourFillButton(scanL); wireColourSampleSetup(scanL) }
    if (scanL instanceof ImageLayer) { wireImageLayer(scanL); scanL.opacityWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy) }
    if (scanL instanceof VideoLayer) { wireVideoTrackButton(scanL); scanL.opacityWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy) }
    if (scanL instanceof TileLayer)        scanL.opacityWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy)
    if (isAnimatableShape(scanL))          wireAnimatableShape(scanL)
    if (scanL instanceof TrackRectLayer    || scanL instanceof TrackEllipseLayer ||
        scanL instanceof TrackPathLayer    || scanL instanceof TrackDrawingLayer)
      wireTrackLayer(scanL)
    if (isClipShapeMovable(scanL))         wireClipShapeLayer(scanL)
    if (scanL instanceof ShapeLayer && !isClipShapeMovable(scanL) && !isTrackShapeLayer(scanL)) wireMaskButton(scanL)
    if (scanL instanceof TextLayer) {
      wireTextMaskButton(scanL)
      wirePointButton(scanL)
      scanL.opacityWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy)
    }
    if (scanL instanceof LineLayer) {
      wireLineMaskButton(scanL)
      const wi = (slot: ParameterSlot, cx: number, cy: number) => interaction.showInspectorForSlot(slot, cx, cy)
      scanL.widthWidget.onInspectorRequest   = wi
      scanL.opacityWidget.onInspectorRequest = wi
    }
    if (scanL instanceof TraceLayer)      wireTraceButtons(scanL)
    if (scanL instanceof ShapeLayer && !isClipShapeMovable(scanL) && !isTrackShapeLayer(scanL)) wirePointButton(scanL)
    if (scanL instanceof LineLayer)       wirePointButton(scanL)
    if (scanL instanceof StrokeLayer)     wireStrokeSnapPoint(scanL)
    if (scanL instanceof LineLayer)       wireLineSnapPoint(scanL)
    if (scanL instanceof PointLayer) {
      const wi = (slot: ParameterSlot, cx: number, cy: number) => interaction.showInspectorForSlot(slot, cx, cy)
      scanL.amountWidget.onInspectorRequest = wi
      scanL.speedWidget.onInspectorRequest  = wi
    }
    if (scanL instanceof ShapeLayer) {
      const wi = (slot: ParameterSlot, cx: number, cy: number) => interaction.showInspectorForSlot(slot, cx, cy)
      scanL.opacityWidget.onInspectorRequest     = wi
      scanL.strokeWidthWidget.onInspectorRequest = wi
      scanL.scaleWidget.onInspectorRequest       = wi
      if (scanL instanceof PathLayer) scanL.radiusWidget.onInspectorRequest = wi
    }
    if (scanL instanceof TransformLayer)  scanL.opacityWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy)
    if (scanL instanceof CompositeLayer)  scanL.blendWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy)
    if (scanL instanceof FilterLayer)     scanL.wireSliderInspectors((slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy))
    if (scanL instanceof MathLayer)       scanL.wireSliderInspectors((slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy))
    if (scanL instanceof MotionBlurLayer) {
      const wi = (slot: ParameterSlot, cx: number, cy: number) => interaction.showInspectorForSlot(slot, cx, cy)
      scanL.fadeWidget.onInspectorRequest  = wi
      scanL.delayWidget.onInspectorRequest = wi
    }
    if (scanL instanceof DirectionLayer)  scanL.speedWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy)
    if (scanL instanceof NoiseLayer) {
      const wi = (slot: ParameterSlot, cx: number, cy: number) => interaction.showInspectorForSlot(slot, cx, cy)
      scanL.scaleWidget.onInspectorRequest   = wi
      scanL.speedWidget.onInspectorRequest   = wi
      scanL.detailWidget.onInspectorRequest  = wi
      scanL.driftWidget.onInspectorRequest   = wi
      scanL.opacityWidget.onInspectorRequest = wi
    }
    scanL = scanL.layerAbove
  }
  for (const archived of deletionLayer.archivedLayers) {
    if (archived instanceof CollectionLayer) archived.setEjectCallback(() => refreshStack())
    if (archived instanceof AmountLayer)     wireCalcButton(archived)
    if (archived instanceof AnimPathLayer)   wireAnimPathLayer(archived)
    if (archived instanceof ColourLayer)     { wireColourFillButton(archived); wireColourSampleSetup(archived) }
    if (archived instanceof ImageLayer)      { wireImageLayer(archived); archived.opacityWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy) }
    if (isAnimatableShape(archived))         wireAnimatableShape(archived)
    if (archived instanceof VideoLayer)      { wireVideoTrackButton(archived); archived.opacityWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy) }
    if (archived instanceof TileLayer)         archived.opacityWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy)
    if (archived instanceof TrackRectLayer    || archived instanceof TrackEllipseLayer ||
        archived instanceof TrackPathLayer    || archived instanceof TrackDrawingLayer)
      wireTrackLayer(archived)
    if (isClipShapeMovable(archived))          wireClipShapeLayer(archived)
    if (archived instanceof ShapeLayer && !isClipShapeMovable(archived) && !isTrackShapeLayer(archived)) wireMaskButton(archived)
    if (archived instanceof TextLayer) {
      wireTextMaskButton(archived)
      wirePointButton(archived)
      archived.opacityWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy)
    }
    if (archived instanceof LineLayer) {
      wireLineMaskButton(archived)
      const wi = (slot: ParameterSlot, cx: number, cy: number) => interaction.showInspectorForSlot(slot, cx, cy)
      archived.widthWidget.onInspectorRequest   = wi
      archived.opacityWidget.onInspectorRequest = wi
    }
    if (archived instanceof TraceLayer)      wireTraceButtons(archived)
    if (archived instanceof ShapeLayer && !isClipShapeMovable(archived) && !isTrackShapeLayer(archived)) wirePointButton(archived)
    if (archived instanceof LineLayer)       wirePointButton(archived)
    if (archived instanceof StrokeLayer)     wireStrokeSnapPoint(archived)
    if (archived instanceof LineLayer)       wireLineSnapPoint(archived)
    if (archived instanceof PointLayer) {
      const wi = (slot: ParameterSlot, cx: number, cy: number) => interaction.showInspectorForSlot(slot, cx, cy)
      archived.amountWidget.onInspectorRequest = wi
      archived.speedWidget.onInspectorRequest  = wi
    }
    if (archived instanceof ShapeLayer) {
      const wi = (slot: ParameterSlot, cx: number, cy: number) => interaction.showInspectorForSlot(slot, cx, cy)
      archived.opacityWidget.onInspectorRequest     = wi
      archived.strokeWidthWidget.onInspectorRequest = wi
      archived.scaleWidget.onInspectorRequest       = wi
      if (archived instanceof PathLayer) archived.radiusWidget.onInspectorRequest = wi
    }
    if (archived instanceof TransformLayer)  archived.opacityWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy)
    if (archived instanceof CompositeLayer)  archived.blendWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy)
    if (archived instanceof FilterLayer)     archived.wireSliderInspectors((slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy))
    if (archived instanceof MathLayer)       archived.wireSliderInspectors((slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy))
    if (archived instanceof MotionBlurLayer) {
      const wi = (slot: ParameterSlot, cx: number, cy: number) => interaction.showInspectorForSlot(slot, cx, cy)
      archived.fadeWidget.onInspectorRequest  = wi
      archived.delayWidget.onInspectorRequest = wi
    }
    if (archived instanceof DirectionLayer)  archived.speedWidget.onInspectorRequest = (slot, cx, cy) => interaction.showInspectorForSlot(slot, cx, cy)
    if (archived instanceof NoiseLayer) {
      const wi = (slot: ParameterSlot, cx: number, cy: number) => interaction.showInspectorForSlot(slot, cx, cy)
      archived.scaleWidget.onInspectorRequest   = wi
      archived.speedWidget.onInspectorRequest   = wi
      archived.detailWidget.onInspectorRequest  = wi
      archived.driftWidget.onInspectorRequest   = wi
      archived.opacityWidget.onInspectorRequest = wi
    }
  }
  widget.setVisible(true)
  refreshStack(selected ?? menuLayer)
}

// ── Desktop: download / upload ──────────────────────────────────
function downloadJSON(filename: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function handleSaveDesktop(): Promise<void> {
  persistenceCtx.selected = widget.selected
  const saveFile = await Persistence.serialize(persistenceCtx)
  const now = new Date()
  const stamp = now.getFullYear()
    + '-' + String(now.getMonth() + 1).padStart(2, '0')
    + '-' + String(now.getDate()).padStart(2, '0')
    + '_' + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
  downloadJSON(`palimpsest_${stamp}.json`, JSON.stringify(saveFile))
}

function handleLoadDesktop(): void {
  const input = document.createElement('input')
  input.type   = 'file'
  input.accept = 'application/json'
  input.style.display = 'none'
  document.body.appendChild(input)
  input.onchange = () => {
    const file = input.files?.[0]
    document.body.removeChild(input)
    if (!file) return
    void (async () => {
      let json: Persistence.SaveFile
      try {
        json = JSON.parse(await file.text())
      } catch {
        console.warn('Persistence: failed to parse save file')
        return
      }
      await applyLoadedSession(json)
    })()
  }
  input.click()
}

// ── Mobile: IndexedDB gallery ───────────────────────────────────
function capturePreview(): string {
  return evaluator.captureDisplayMode(320, 180)
}

function fmtSaveName(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

async function handleSaveMobile(): Promise<void> {
  persistenceCtx.selected = widget.selected
  const saveFile = await Persistence.serialize(persistenceCtx)
  const preview  = capturePreview()
  const id       = crypto.randomUUID()
  const savedAt  = Date.now()
  await MobileStore.writeSave({ id, name: fmtSaveName(savedAt), savedAt, preview, session: saveFile })
  openGallery({ onLoad: s => void applyLoadedSession(s as Persistence.SaveFile) }, id)
}

function handleLoadMobile(): void {
  openGallery({ onLoad: s => void applyLoadedSession(s as Persistence.SaveFile) })
}

// ── Wire callbacks ──────────────────────────────────────────────
menuLayer.setSaveLoadCallbacks(
  isMobile ? handleSaveMobile  : handleSaveDesktop,
  isMobile ? handleLoadMobile  : handleLoadDesktop,
)

// DeletionLayer restore: put the layer just above DeletionLayer, then refresh.
// forceDirty() restarts any self-perpetuating frame loop (VideoLayer,
// MediaLayer, PointLayer wander, etc.) that died when outsideStack became
// true on archive/background — its queueMicrotask guard checks
// !outsideStack, which was false the whole time it sat parked.
deletionLayer.setRestoreCallback((layer) => {
  layer.insertAbove(deletionLayer)
  layer.forceDirty()
  if (layer instanceof MaskLayer) layer.resetActiveTool()
  refreshStack(layer)
})

// Delete key: archive the currently selected layer into DeletionLayer.
interaction.setDeleteAction(() => {
  const layer = widget.selected
  if (layer === null || layer === deletionLayer || layer === root || layer === menuLayer) return
  let below: Layer | null = layer.layerBelow
  while (below !== null && below.isInfrastructure) below = below.layerBelow
  // If this is the bottom-most layer (nothing but Root/DeletionLayer below
  // it), focus moves up to the layer above rather than down to either.
  if (below === root || below === deletionLayer) below = null
  const above = layer.layerAbove
  const nextSel = below ?? above ?? deletionLayer
  deletionLayer.archive(layer)
  refreshStack(nextSel)
})

// 'b' key: move the selected layer into the Background collection — it
// keeps recomputing every frame (so downstream bindings stay live) but is
// removed from the main stack and never rendered. Browsed via DeletionLayer's
// toggle; restore/purge use the same callbacks as the Deleted archive.
interaction.setBackgroundAction(() => {
  const layer = widget.selected
  if (layer === null || layer === deletionLayer || layer === root ||
      layer === menuLayer || layer === backgroundLayer) return
  let below: Layer | null = layer.layerBelow
  while (below !== null && below.isInfrastructure) below = below.layerBelow
  // If this is the bottom-most layer (nothing but Root/DeletionLayer below
  // it), focus moves up to the layer above rather than down to either.
  if (below === root || below === deletionLayer) below = null
  const above = layer.layerAbove
  const nextSel = below ?? above ?? lowestAnchor()
  backgroundLayer.add(layer)
  refreshStack(nextSel)
})

// 'm' key: bring the Menu layer to immediately above the current layer and
// select it, so new layers can be added in context next to the current work.
interaction.setMenuFocusAction(() => {
  const layer = widget.selected
  if (layer === null || layer === menuLayer) return
  menuLayer.removeFromStack()
  const target = (layer.hiddenHelper !== null && !layer.helperBelow) ? layer.hiddenHelper : layer
  menuLayer.insertAbove(target)
  refreshStack(menuLayer)
})

// 'p' key — pause/resume the singleton ClockLayer.
interaction.setPauseClockAction(() => { clock.togglePause() })

// 'c' key — collect the layer below into a CollectionLayer.
//
// First press: create a Collection above the selected layer, ingest the
//              selected layer into it, and select the Collection.
//
// Subsequent presses: selected layer IS already a CollectionLayer — ingest
//                     the next non-infrastructure layer below it.
interaction.setCollectionAction(() => {
  const selected = widget.selected
  if (selected === null || selected === menuLayer || selected === deletionLayer || selected === root) return

  if (selected instanceof CollectionLayer) {
    // Find the next ingestable layer below the collection.
    let below: Layer | null = selected.layerBelow
    while (below !== null && below.isInfrastructure) below = below.layerBelow
    if (below === null || below === deletionLayer || below === root) return
    selected.ingest(below)
    refreshStack(selected)
  } else {
    // Look for an existing CollectionLayer below the selected layer.
    let existing: Layer | null = selected.layerBelow
    while (existing !== null && !(existing instanceof CollectionLayer)) existing = existing.layerBelow
    if (existing instanceof CollectionLayer) {
      const nextSel = selected.layerBelow ?? selected.layerAbove ?? menuLayer
      existing.ingest(selected)
      refreshStack(nextSel)
    } else {
      // No existing collection — create one, position it where the selected
      // layer is, then ingest the selected layer into it.
      const collection = new CollectionLayer()
      Layer.assignDebugName(collection)
      collection.bounds = { x: X, y: 24, width: W, height: 36 }
      collection.setEjectCallback(() => refreshStack())
      collection.insertAbove(selected)
      collection.ingest(selected)
      refreshStack(collection)
    }
  }
})

interaction.setBoundCallback((source, slot) => {
  BindingLayer.create(source, slot)
  refreshStack()
})

// Dragging a Mask-producing layer's card from the stack onto an Image/Fill/
// Noise/Video layer wraps that layer in a ClipLayer, bound to the dropped
// mask. The ClipLayer takes the target's stack position; both the original
// image-producing layer and the mask layer move to the Background
// collection (still recomputing, recoverable via DeletionLayer's toggle).
//
// If the dropped layer is a shape (Rect/Ellipse/Path/Text) rather than a
// dedicated mask source, it doesn't have a usable mask output on its own in
// this context — so a new MaskLayer is created, the shape is bound into its
// first shape slot, and that MaskLayer (not the shape) feeds clip.maskSlot.
// Both the shape and the new MaskLayer move to Background, never appearing
// in the stack.
interaction.setMaskDropCallback((source, target) => {
  if (!source.types.has(ValueType.Mask)) return
  if (!isClippableImageLayer(target)) return

  const below = target.layerBelow
  if (below === null) return

  const isShape = source instanceof RectLayer || source instanceof EllipseLayer ||
    source instanceof PathLayer || source instanceof TextLayer

  let maskSource: Node = source
  if (isShape) {
    const maskLayer = new MaskLayer()
    Layer.assignDebugName(maskLayer)
    // Insert temporarily so BindingLayer.create has a live stack position to
    // attach to; both it and the resulting BindingLayer move to Background
    // immediately afterwards (in the order that unwinds the stack cleanly),
    // leaving the visible stack untouched.
    maskLayer.insertAbove(target)
    const bl = BindingLayer.create(source, maskLayer.firstShapeSlot)
    if (bl !== null) backgroundLayer.add(bl)
    backgroundLayer.add(maskLayer)
    maskSource = maskLayer
  }

  const clip = new ClipLayer()
  Layer.assignDebugName(clip)
  clip.bounds = { ...target.bounds }

  target.removeFromStack()
  clip.insertAbove(below)

  BindingLayer.create(target, clip.imageSlot)
  BindingLayer.create(maskSource, clip.maskSlot)

  backgroundLayer.add(target)
  if (source instanceof Layer) backgroundLayer.add(source)

  postInsertLayer(clip)
  refreshStack(clip)
})

// Click on a parameter-slot row:
//   • Empty slot  — create a new layer of the slot's canonical default
//                    type, insert it above the consumer, bind it, and
//                    select it.
//   • Bound slot  — select the layer that feeds it, restoring it from
//                    the Deleted archive (above the consumer) or the
//                    Background collection (below the consumer) if needed.
interaction.setSlotClickCallback((consumer, slot) => {
  if (slot.state === SlotState.Unbound) {
    if (slot.type === null) return

    // StrokeLayer start/end slots: initialise the new PointLayer at the
    // actual stroke endpoint so the binding is a no-op by default.
    if (consumer instanceof StrokeLayer && slot.type === ValueType.Point) {
      const pos = slot === consumer.startSlot
        ? consumer.getStrokeStart()
        : slot === consumer.endSlot
          ? consumer.getStrokeEnd()
          : null
      if (pos !== null) {
        const newLayer = new PointLayer(pos)
        Layer.assignSlotCreatedName(newLayer, consumer, slot)
        newLayer.bounds = { x: X, y: 24, width: W, height: 36 }
        newLayer.insertAbove(consumer)
        BindingLayer.create(newLayer, slot)
        refreshStack(newLayer)
        return
      }
    }

    // DirectionLayer position/handle slots: initialise the new PointLayer
    // at the dial's current centre / control-handle position so the
    // binding is a no-op by default.
    if (consumer instanceof DirectionLayer && slot.type === ValueType.Point) {
      const pos = slot === consumer.positionSlot
        ? consumer.getDialPosition()
        : slot === consumer.handleSlot
          ? consumer.getHandlePosition()
          : null
      if (pos !== null) {
        const newLayer = new PointLayer(pos)
        Layer.assignSlotCreatedName(newLayer, consumer, slot)
        newLayer.bounds = { x: X, y: 24, width: W, height: 36 }
        newLayer.insertAbove(consumer)
        BindingLayer.create(newLayer, slot)
        refreshStack(newLayer)
        return
      }
    }

    // Generic: if the consumer's manual control already has a value for
    // this slot (handle position, slider value, dial angle, ...), seed the
    // new layer with that value so the binding is a no-op until the user
    // changes it.
    if (slot.type === ValueType.Point || slot.type === ValueType.Amount || slot.type === ValueType.Direction || (slot.type === ValueType.Colour && !Node.greyDefault)) {
      const def = consumer.getSlotDefault(slot)
      if (def !== null) {
        let newLayer: Layer
        if (slot.type === ValueType.Point) {
          newLayer = new PointLayer(def as Point)
        } else if (slot.type === ValueType.Amount) {
          newLayer = new AmountLayer(def as number)
        } else if (slot.type === ValueType.Colour) {
          newLayer = new ColourLayer(def as Colour)
        } else {
          const d = def as Direction
          newLayer = new DirectionLayer(d.angle, d.magnitude)
        }
        Layer.assignSlotCreatedName(newLayer, consumer, slot)
        newLayer.bounds = { x: X, y: 24, width: W, height: DEFAULT_VALUE_HEIGHT[slot.type] ?? 36 }
        newLayer.insertAbove(consumer)
        BindingLayer.create(newLayer, slot)
        refreshStack(newLayer)
        return
      }
    }

    // Slots conventionally bound to a shape (AnimPath's shape slot,
    // MaskLayer's shape slots) get a fresh random closed shape in outline
    // mode, instead of the slot type's normal canonical default.
    if (consumer.wantsShapeForSlot(slot)) {
      const newLayer = randomClosedShapeLayer(Node.viewportWidth, Node.viewportHeight)
      Layer.assignSlotCreatedName(newLayer, consumer, slot)
      newLayer.bounds = { x: X, y: 24, width: W, height: 36 }
      newLayer.insertAbove(consumer)
      BindingLayer.create(newLayer, slot)
      refreshStack(newLayer)
      return
    }

    // Other empty Mask-typed slots (e.g. ClipLayer.maskSlot, TextLayer.maskSlot):
    // wrap a shape's silhouette in a MaskLayer, sent to Background. Reuses a
    // suitable existing shape from the stack below the consumer if one
    // exists; otherwise creates a fresh random outline shape (as above),
    // which stays in the stack and becomes the current layer.
    if (slot.type === ValueType.Mask) {
      let shapeLayer = findSuitableMaskShape(consumer)
      if (shapeLayer === null) {
        shapeLayer = randomClosedShapeLayer(Node.viewportWidth, Node.viewportHeight)
        Layer.assignDebugName(shapeLayer)
        shapeLayer.bounds = { x: X, y: 24, width: W, height: 36 }
        shapeLayer.insertAbove(consumer)
      }

      const maskLayer = new MaskLayer()
      Layer.assignSlotCreatedName(maskLayer, consumer, slot)
      // Insert temporarily so BindingLayer.create has a live stack position
      // to attach to; both it and the resulting BindingLayer move to
      // Background immediately afterwards, leaving shapeLayer's position
      // (and the rest of the stack) untouched.
      maskLayer.insertAbove(shapeLayer)
      const bl = BindingLayer.create(shapeLayer, maskLayer.firstShapeSlot)
      if (bl !== null) backgroundLayer.add(bl)
      backgroundLayer.add(maskLayer)

      BindingLayer.create(maskLayer, slot)
      refreshStack(shapeLayer)
      return
    }

    const factory = DEFAULT_VALUE_LAYER[slot.type]
    if (factory === undefined) return

    const newLayer = factory(Node.viewportWidth, Node.viewportHeight)
    Layer.assignSlotCreatedName(newLayer, consumer, slot)
    newLayer.bounds = { x: X, y: 24, width: W, height: DEFAULT_VALUE_HEIGHT[slot.type] ?? 36 }
    newLayer.insertAbove(consumer)
    BindingLayer.create(newLayer, slot)
    if (newLayer instanceof TempoLayer) bindRateClock(newLayer)
    refreshStack(newLayer)
    return
  }

  const source = slot.source
  if (!(source instanceof Layer)) return

  // Clicking the slot a hidden helper is bound to exposes it: it becomes
  // a normal layer with a thumbnail at its current stack position, and
  // permanently stops moving together with its host.
  if (source.isHiddenHelper) {
    if (source.helperHost !== null) source.helperHost.hiddenHelper = null
    source.helperHost = null
    source.isHiddenHelper = false
  }

  if (source.outsideStack) {
    if (deletionLayer.removeFromArchive(source)) {
      source.insertAbove(consumer)
    } else if (backgroundLayer.removeItem(source)) {
      source.insertBelow(consumer)
    } else {
      // Never archived or backgrounded — e.g. the singleton ClockLayer,
      // nominally bound to Root's clockSlot but otherwise outsideStack
      // since startup. Insert it at the consumer's position.
      source.insertAbove(consumer)
    }
    // Restart any self-perpetuating frame loop that died while outsideStack
    // was true (see the DeletionLayer restore callback above).
    source.forceDirty()
    if (source instanceof MaskLayer) source.resetActiveTool()
  }
  refreshStack(source)
})

interaction.setRefreshCallback(() => refreshStack())

interaction.setCreateBindingMapCallback((source) => {
  const layer = new BindingMapLayer(source)
  Layer.assignDebugName(layer)
  layer.bounds = { x: X, y: 24, width: W, height: 36 }
  const sel = widget.selected
  if (sel !== null) insertAboveSelected(layer, sel)
  else layer.insertAbove(lowestAnchor())
  postInsertLayer(layer)
  refreshStack(layer)
})

// Permanently remove a layer from the archive and clear any bindings that
// still source from it.  We snapshot dependents before iterating because
// each BindingLayer.remove() call modifies the set in-place.
deletionLayer.setPurgeCallback((layer) => {
  const bls = [...layer.dependents].filter(d => d instanceof BindingLayer)
  for (const bl of bls) (bl as BindingLayer).remove()
  refreshStack()
})

// ------------------------------------------------------------------
// Startup layer — shown instead of MenuLayer at launch.
// ------------------------------------------------------------------

const startupLayer = new StartupLayer(
  // "Menu" button: show widget, insert MenuLayer, remove startup, refresh.
  () => {
    widget.setVisible(true)
    startupLayer.removeFromStack()
    menuLayer.insertAbove(deletionLayer)
    refreshStack(menuLayer)
  },
  // "Tutorial" button: show widget, insert MenuLayer + TutorialLayer, refresh.
  () => {
    // Tutorial mode: colourful outlines with grid, no artistic rendering.
    // Grid communicates the mathematical constraint architecture to new users.
    // Outlines (not fills) keep shapes visually distinct; coloured (not grey).
    Node.artisticMode   = false
    Node.showGrid       = true
    Node.outlineDefault = true
    // greyDefault stays false — coloured outlines
    widget.setVisible(true)
    startupLayer.removeFromStack()
    menuLayer.insertAbove(deletionLayer)
    const tl = new TutorialLayer()
    Layer.assignDebugName(tl)
    tl.bounds = { x: X, y: 24, width: W, height: 36 }
    wireTutorialLayer(tl)
    tl.insertAbove(menuLayer)
    refreshStack(tl)
  },
)
startupLayer.bounds = { x: X, y: 24, width: W, height: 36 }
startupLayer.insertAbove(deletionLayer)

refreshStack(startupLayer)

// ------------------------------------------------------------------
// Drag-and-drop media loading — always creates a new ImageLayer (for
// image files) or VideoLayer (for video files)
// ------------------------------------------------------------------
//
// Multi-file drops: one ImageLayer is created per image file. The first
// file follows the normal placement rules; subsequent image files are
// inserted below it in the stack, in drop order.
//
// Placement rules:
//   • Dragged over the LayerStackWidget → a placeholder card opens a gap
//     at the pointer position and follows it, exactly like reordering an
//     existing layer's thumbnail; dropping inserts the new layer at
//     that position in the stack and selects it.
//   • MenuLayer selected      → new layer inserted below MenuLayer
//   • Drop on Image slot, or
//     current layer has an
//     empty Image slot        → new layer inserted below current layer,
//                                bound to that slot; current layer stays selected
//   • Otherwise                → new layer inserted above current layer,
//                                new layer becomes selected

// Placeholder layer for a drag currently hovering the stack widget — not
// yet linked into the live stack (outsideStack) until the drop commits.
let fileDragGhost: ImageLayer | VideoLayer | null = null

// Insert image files from `files` starting at `startIndex` below `prevLayer`,
// each below the previous, in drop order.
function insertAdditionalImageFiles(
  files: FileList | null | undefined,
  prevLayer: Layer,
  startIndex: number,
): void {
  if (!files) return
  let prev = prevLayer
  for (let i = startIndex; i < files.length; i++) {
    const f = files[i]
    if (!f || !f.type.startsWith('image/')) continue
    const layer = new ImageLayer()
    Layer.assignDebugName(layer)
    layer.bounds = { ...menuLayer.bounds }
    layer.insertAbove(prev.layerBelow ?? lowestAnchor())
    layer.loadFile(f)
    wireImageLayer(layer)
    prev = layer
  }
}

// During dragover, DataTransferItem.type carries the file's MIME type
// (the File object itself is only available on drop).
function isVideoDrag(e: DragEvent): boolean {
  const item = e.dataTransfer?.items[0]
  return item !== undefined && item.kind === 'file' && item.type.startsWith('video/')
}

canvas.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'

  const pt = { x: e.offsetX, y: e.offsetY }

  if (widget.inBounds(pt)) {
    if (Node.fileDragActive) {
      Node.fileDragActive = false
      Node.scheduleFrame?.()
    }
    if (fileDragGhost === null) {
      fileDragGhost = isVideoDrag(e) ? new VideoLayer() : new ImageLayer()
      fileDragGhost.bounds = { ...menuLayer.bounds }
      widget.beginExternalDrag(fileDragGhost, pt)
    } else {
      widget.updateExternalDrag(pt)
    }
    return
  }

  if (fileDragGhost !== null) {
    widget.cancelExternalDrag()
    graph.unregister(fileDragGhost)
    fileDragGhost = null
  }

  if (!Node.fileDragActive) {
    Node.fileDragActive = true
    Node.scheduleFrame?.()
  }
})

canvas.addEventListener('dragleave', () => {
  if (fileDragGhost !== null) {
    widget.cancelExternalDrag()
    graph.unregister(fileDragGhost)
    fileDragGhost = null
  }
  if (Node.fileDragActive) {
    Node.fileDragActive = false
    Node.scheduleFrame?.()
  }
})

canvas.addEventListener('drop', (e) => {
  e.preventDefault()
  Node.fileDragActive = false

  const files = e.dataTransfer?.files
  const file  = files?.[0]

  if (fileDragGhost !== null) {
    const ghost = fileDragGhost
    fileDragGhost = null
    if (file) {
      Layer.assignDebugName(ghost)
      widget.commitExternalDrag()
      ghost.loadFile(file)
      if (ghost instanceof ImageLayer) wireImageLayer(ghost)
      insertAdditionalImageFiles(files, ghost, 1)
      refreshStack(ghost)
    } else {
      widget.cancelExternalDrag()
      graph.unregister(ghost)
    }
    return
  }

  if (!file) return

  const dropPoint  = { x: e.offsetX, y: e.offsetY }
  const selected   = widget.selected

  const newLayer: ImageLayer | VideoLayer = file.type.startsWith('video/')
    ? new VideoLayer()
    : new ImageLayer()
  Layer.assignDebugName(newLayer)
  newLayer.bounds    = { ...menuLayer.bounds }

  let targetSlot: ParameterSlot | null = null

  if (selected instanceof MenuLayer) {
    // Place below MenuLayer.
    const below = menuLayer.layerBelow
    newLayer.insertAbove(below ?? lowestAnchor())
  } else if (selected !== null) {
    const hitSlot = selected.hitTestSlot(dropPoint)
    const slot = (hitSlot !== null && hitSlot.type === ValueType.Image)
      ? hitSlot
      : selected.findEmptySlot(ValueType.Image)

    if (slot !== null) {
      // Dropped onto an Image-type slot, or the current layer has an empty
      // image slot — insert below selected, then bind.
      targetSlot = slot
      newLayer.insertAbove(selected.layerBelow ?? lowestAnchor())
    } else {
      // Default: insert above current layer.
      insertAboveSelected(newLayer, selected)
    }
  } else {
    newLayer.insertAbove(lowestAnchor())
  }

  newLayer.loadFile(file)

  if (targetSlot !== null) {
    BindingLayer.create(newLayer, targetSlot)
  }

  if (newLayer instanceof ImageLayer) wireImageLayer(newLayer)

  // For multi-file drops, insert additional image files below the first layer.
  insertAdditionalImageFiles(files, newLayer, 1)

  refreshStack(targetSlot !== null ? selected! : newLayer)
})

// ------------------------------------------------------------------
// Drag-and-drop plain text — pastes into the selected TextLayer at the
// cursor, or creates a new TextLayer.
// ------------------------------------------------------------------
//
// Placement rules:
//   • Dragged over the LayerStackWidget → placeholder card, same as the
//     file-drop ghost above; dropping creates a TextLayer at that position.
//   • Selected layer is a TextLayer → green edit-region highlight appears
//     while dragging over the canvas; drop pastes at the cursor (or
//     replaces the default text, per TextLayer.pasteTextAtCursor).
//   • MenuLayer selected → new TextLayer inserted below MenuLayer.
//   • Otherwise → new TextLayer inserted above the selected layer.

let textDragGhost: TextLayer | null = null

function isTextDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  return !!types && types.includes('text/plain') && !types.includes('Files')
}

canvas.addEventListener('dragover', (e) => {
  if (!isTextDrag(e)) return
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'

  const pt = { x: e.offsetX, y: e.offsetY }

  if (widget.inBounds(pt)) {
    const selected = widget.selected
    if (selected instanceof TextLayer) selected.setExternalDragHover(false)
    if (textDragGhost === null) {
      textDragGhost = new TextLayer()
      textDragGhost.bounds = { ...menuLayer.bounds }
      widget.beginExternalDrag(textDragGhost, pt)
    } else {
      widget.updateExternalDrag(pt)
    }
    return
  }

  if (textDragGhost !== null) {
    widget.cancelExternalDrag()
    graph.unregister(textDragGhost)
    textDragGhost = null
  }

  const selected = widget.selected
  if (selected instanceof TextLayer) {
    selected.setExternalDragHover(true)
    Node.scheduleFrame?.()
  }
})

canvas.addEventListener('dragleave', () => {
  if (textDragGhost !== null) {
    widget.cancelExternalDrag()
    graph.unregister(textDragGhost)
    textDragGhost = null
  }
  const selected = widget.selected
  if (selected instanceof TextLayer) {
    selected.setExternalDragHover(false)
    Node.scheduleFrame?.()
  }
})

canvas.addEventListener('drop', (e) => {
  if (!isTextDrag(e)) return
  e.preventDefault()

  const text = e.dataTransfer?.getData('text/plain') ?? ''

  if (textDragGhost !== null) {
    const ghost = textDragGhost
    textDragGhost = null
    if (text) {
      Layer.assignDebugName(ghost)
      widget.commitExternalDrag()
      ghost.pasteTextAtCursor(text)
      postInsertLayer(ghost)
      refreshStack(ghost)
    } else {
      widget.cancelExternalDrag()
      graph.unregister(ghost)
    }
    return
  }

  const selected = widget.selected
  if (selected instanceof TextLayer) {
    selected.setExternalDragHover(false)
    if (text) selected.pasteTextAtCursor(text)
    return
  }

  if (!text) return
  createTextLayerFromText(text)
})

// Create a new TextLayer containing `text`, placed above the selected
// layer — or below MenuLayer if MenuLayer is selected. Shared by the OS
// text-drop handler above and the global system-paste action below.
function createTextLayerFromText(text: string): void {
  const selected = widget.selected

  const newLayer = new TextLayer()
  Layer.assignDebugName(newLayer)
  newLayer.bounds = { ...menuLayer.bounds }
  newLayer.pasteTextAtCursor(text)

  if (selected instanceof MenuLayer) {
    const below = menuLayer.layerBelow
    newLayer.insertAbove(below ?? lowestAnchor())
  } else if (selected !== null) {
    insertAboveSelected(newLayer, selected)
  } else {
    newLayer.insertAbove(lowestAnchor())
  }

  postInsertLayer(newLayer)
  refreshStack(newLayer)
}

// Global system paste (Cmd/Ctrl+V) when no layer is in in-place text-edit
// mode — same placement rule as dropping text onto the canvas.
interaction.setPasteAction((text) => createTextLayerFromText(text))

// Create a new ImageLayer containing the pasted image data, placed above the
// selected layer — or below MenuLayer if MenuLayer is selected. Same
// placement rule as createTextLayerFromText.
function createImageLayerFromFile(file: File): void {
  const selected = widget.selected

  const newLayer = new ImageLayer()
  Layer.assignDebugName(newLayer)
  newLayer.bounds = { ...menuLayer.bounds }

  if (selected instanceof MenuLayer) {
    const below = menuLayer.layerBelow
    newLayer.insertAbove(below ?? lowestAnchor())
  } else if (selected !== null) {
    insertAboveSelected(newLayer, selected)
  } else {
    newLayer.insertAbove(lowestAnchor())
  }

  newLayer.loadFile(file)
  postInsertLayer(newLayer)
  refreshStack(newLayer)
}

// Global system paste of image data (Cmd/Ctrl+V) — same placement rule as
// pasting text.
interaction.setImagePasteAction((file) => createImageLayerFromFile(file))

// ------------------------------------------------------------------
// Resize
// ------------------------------------------------------------------
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight
  const prevCW = evaluator.contentWidth, prevCH = evaluator.contentHeight
  evaluator.setViewport(w, h)
  if (evaluator.contentWidth !== prevCW || evaluator.contentHeight !== prevCH) {
    root.resize(evaluator.contentWidth, evaluator.contentHeight)
  }
})
// screen.orientation.change fires after window.innerWidth/Height have settled
// on iOS/Android, making it more reliable than 'resize' alone for orientation flips.
screen.orientation?.addEventListener('change', () => {
  if (Node.isMobileDevice) {
    evaluator.setViewport(window.innerWidth, window.innerHeight)
    root.resize(evaluator.contentWidth, evaluator.contentHeight)
  }
})
