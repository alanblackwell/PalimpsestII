import { Node } from '../core/Node.js'
import { Layer } from '../core/Layer.js'
import { SlotState, type BoundingBox } from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

import { RootLayer }       from '../layers/RootLayer.js'
import { ClockLayer }      from '../layers/ClockLayer.js'
import { DeletionLayer }   from '../layers/DeletionLayer.js'
import { BackgroundLayer } from '../layers/BackgroundLayer.js'
import { BindingLayer }    from '../layers/BindingLayer.js'
import { StartupLayer }    from '../layers/StartupLayer.js'

import { AmountLayer }      from '../layers/AmountLayer.js'
import { ColourLayer }       from '../layers/ColourLayer.js'
import { PointLayer }        from '../layers/PointLayer.js'
import { RateLayer }         from '../layers/RateLayer.js'
import { AnimPathLayer }     from '../layers/AnimPathLayer.js'
import { SelectLayer }       from '../layers/SelectLayer.js'
import { CountLayer }        from '../layers/CountLayer.js'
import { EventLayer }        from '../layers/EventLayer.js'
import { FlashLayer }        from '../layers/FlashLayer.js'
import { DirectionLayer }    from '../layers/DirectionLayer.js'
import { MathLayer }         from '../layers/MathLayer.js'
import { TextLayer }         from '../layers/TextLayer.js'
import { ImageLayer }        from '../layers/ImageLayer.js'
import { TraceLayer }        from '../layers/TraceLayer.js'
import { MaskLayer }         from '../layers/MaskLayer.js'
import { CompositeLayer }    from '../layers/CompositeLayer.js'
import { FilterLayer }       from '../layers/FilterLayer.js'
import { CollectionLayer }   from '../layers/CollectionLayer.js'
import { NoiseLayer }        from '../layers/NoiseLayer.js'
import { FillLayer }         from '../layers/FillLayer.js'
import { TransformLayer }    from '../layers/TransformLayer.js'
import { SequencerLayer }    from '../layers/SequencerLayer.js'
import { ClipLayer }         from '../layers/ClipLayer.js'
import { TileLayer }         from '../layers/TileLayer.js'
import { StrokeLayer }       from '../layers/StrokeLayer.js'
import { LineLayer }         from '../layers/LineLayer.js'
import { ClipRectLayer }     from '../layers/ClipRectLayer.js'
import { ClipEllipseLayer }  from '../layers/ClipEllipseLayer.js'
import { ClipPathLayer }     from '../layers/ClipPathLayer.js'
import { ClipTextLayer }     from '../layers/ClipTextLayer.js'
import { ClipDrawingLayer }  from '../layers/ClipDrawingLayer.js'
import { RotateLayer }       from '../layers/RotateLayer.js'
import { CaptureLayer }      from '../layers/CaptureLayer.js'
import { VideoLayer }        from '../layers/VideoLayer.js'
import { TutorialLayer }     from '../layers/TutorialLayer.js'
import { RectLayer }         from '../layers/RectLayer.js'
import { EllipseLayer }      from '../layers/EllipseLayer.js'
import { PathLayer }         from '../layers/PathLayer.js'
import { BindingMapLayer }   from '../layers/BindingMapLayer.js'
import { WarpLayer }         from '../layers/WarpLayer.js'
import { MotionBlurLayer }   from '../layers/MotionBlurLayer.js'
import { TrackRectLayer }     from '../layers/TrackRectLayer.js'
import { TrackEllipseLayer }  from '../layers/TrackEllipseLayer.js'
import { TrackPathLayer }     from '../layers/TrackPathLayer.js'
import { TrackDrawingLayer }  from '../layers/TrackDrawingLayer.js'

// ------------------------------------------------------------
// Persistence — save/load a Palimpsest session as a single JSON document
// ------------------------------------------------------------
//
// See /Users/alan/.claude/plans/soft-floating-quasar.md for the design.
//
// Singletons (root, clock, deletionLayer, backgroundLayer, menuLayer) are
// never (re)constructed here — `PersistenceContext` carries the live
// instances, and `root` is always LayerRecord id 0.

export const SAVE_FILE_VERSION = 1

// Sentinel ids for singletons that can appear as slot sources, or in
// `stack`, but are not normal LayerRecords (root is the exception — it IS
// a LayerRecord, with the conventional id 0).
export const SENTINEL_MENU       = -1
export const SENTINEL_CLOCK      = -2
export const SENTINEL_DELETION   = -3
export const SENTINEL_BACKGROUND = -4

export interface PersistenceContext {
  root: RootLayer
  clock: ClockLayer
  deletionLayer: DeletionLayer
  backgroundLayer: BackgroundLayer
  menuLayer: Layer
  // The layer the user currently has selected (LayerStackWidget.selected),
  // captured at save time. Layer.selected is a dead field, never set.
  selected: Layer | null
}

export interface SlotRecord {
  state: SlotState
  sourceId: number | null
}

export interface LayerRecord {
  id: number
  class: string
  debugName: string
  bounds: BoundingBox
  isHiddenHelper: boolean
  helperHostId: number | null
  hiddenHelperId: number | null
  helperBelow: boolean
  state: Record<string, unknown>
  slots: SlotRecord[]
  // CollectionLayer-only: ids of ingested layers (this._layers), not
  // otherwise reachable via stack/background/archive. Empty for every
  // other layer class.
  itemIds: number[]
}

export interface SaveFile {
  version: number
  canvas: { width: number; height: number }
  clock: { elapsed: number; paused: boolean }
  layers: LayerRecord[]
  stack: number[]
  background: number[]
  archive: number[]
  selectedId: number | null
}

// ------------------------------------------------------------
// Layer class registry — mechanical, one entry per concrete, persistable
// layer class. Excluded: RootLayer, ClockLayer, DeletionLayer,
// BackgroundLayer, MenuLayer, StartupLayer, BindingLayer (singletons /
// infrastructure, handled structurally) and AnimationPathLayer (dead code).
// ------------------------------------------------------------

export const LAYER_CLASSES: Record<string, () => Layer> = {
  AmountLayer:      () => new AmountLayer(),
  ColourLayer:      () => new ColourLayer(),
  PointLayer:       () => new PointLayer(),
  RateLayer:        () => new RateLayer(),
  AnimPathLayer:    () => new AnimPathLayer(Node.canvasWidth / 2, Node.canvasHeight / 2),
  SelectLayer:      () => new SelectLayer(),
  CountLayer:       () => new CountLayer(),
  EventLayer:       () => new EventLayer(),
  FlashLayer:       () => new FlashLayer(),
  DirectionLayer:   () => new DirectionLayer(),
  MathLayer:        () => new MathLayer(),
  TextLayer:        () => new TextLayer(),
  ImageLayer:       () => new ImageLayer(),
  TraceLayer:       () => new TraceLayer(),
  EdgePathLayer:    () => new TraceLayer(),   // backward-compat alias for saved sessions
  MaskLayer:        () => new MaskLayer(),
  CompositeLayer:   () => new CompositeLayer(Node.canvasWidth, Node.canvasHeight),
  FilterLayer:      () => new FilterLayer(),
  CollectionLayer:  () => new CollectionLayer(),
  NoiseLayer:       () => new NoiseLayer(),
  FillLayer:        () => new FillLayer(Node.canvasWidth, Node.canvasHeight),
  TransformLayer:   () => new TransformLayer(Node.canvasWidth, Node.canvasHeight),
  SequencerLayer:   () => new SequencerLayer(Node.canvasWidth, Node.canvasHeight),
  ClipLayer:        () => new ClipLayer(),
  TileLayer:        () => new TileLayer(),
  StrokeLayer:      () => new StrokeLayer(),
  LineLayer:        () => new LineLayer(),
  ClipRectLayer:    () => new ClipRectLayer(),
  ClipEllipseLayer: () => new ClipEllipseLayer(),
  ClipPathLayer:    () => new ClipPathLayer(),
  ClipTextLayer:    () => new ClipTextLayer(),
  ClipDrawingLayer: () => new ClipDrawingLayer(),
  RotateLayer:      () => new RotateLayer(),
  MediaLayer:       () => new VideoLayer(),   // migration alias for old saves
  CaptureLayer:     () => new CaptureLayer(),
  VideoLayer:       () => new VideoLayer(),
  TutorialLayer:    () => new TutorialLayer(),
  RectLayer:        () => new RectLayer(Node.canvasWidth / 2, Node.canvasHeight / 2, 200, 150),
  EllipseLayer:     () => new EllipseLayer(Node.canvasWidth / 2, Node.canvasHeight / 2, 200, 150),
  PathLayer:        () => new PathLayer(),
  BindingMapLayer:  () => new BindingMapLayer(),
  WarpLayer:        () => new WarpLayer(),
  MotionBlurLayer:  () => new MotionBlurLayer(),
  TrackRectLayer:     () => new TrackRectLayer(),
  TrackEllipseLayer:  () => new TrackEllipseLayer(),
  TrackPathLayer:     () => new TrackPathLayer(),
  TrackDrawingLayer:  () => new TrackDrawingLayer(),
}

// ------------------------------------------------------------
// Image encoding (PNG data-URLs)
// ------------------------------------------------------------

function isImageSurface(v: unknown): v is OffscreenCanvas | ImageBitmap {
  return (typeof OffscreenCanvas !== 'undefined' && v instanceof OffscreenCanvas)
      || (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap)
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function surfaceToDataURL(surface: OffscreenCanvas | ImageBitmap): Promise<string> {
  let canvas: OffscreenCanvas
  if (surface instanceof OffscreenCanvas) {
    canvas = surface
  } else {
    canvas = new OffscreenCanvas(surface.width, surface.height)
    canvas.getContext('2d')!.drawImage(surface, 0, 0)
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return blobToDataURL(blob)
}

async function dataURLToBitmap(dataURL: string): Promise<ImageBitmap> {
  const res  = await fetch(dataURL)
  const blob = await res.blob()
  return createImageBitmap(blob)
}

// Walk a serializeState() result, replacing any OffscreenCanvas/ImageBitmap
// values with PNG data-URLs so the result is JSON-safe.
async function encodeState(state: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(state)) {
    out[key] = isImageSurface(value) ? await surfaceToDataURL(value) : value
  }
  return out
}

// Walk a saved state record, replacing any PNG data-URL strings with decoded
// ImageBitmaps, ready to pass to deserializeState.
async function decodeState(state: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(state)) {
    out[key] = (typeof value === 'string' && value.startsWith('data:image/'))
      ? await dataURLToBitmap(value)
      : value
  }
  return out
}

// ------------------------------------------------------------
// Save
// ------------------------------------------------------------

export async function serialize(ctx: PersistenceContext): Promise<SaveFile> {
  const order: Layer[] = []
  const idOfLayer = new Map<Layer, number>()

  function visit(layer: Layer): number {
    let id = idOfLayer.get(layer)
    if (id !== undefined) return id
    id = order.length
    idOfLayer.set(layer, id)
    order.push(layer)
    return id
  }

  function refId(node: Node | null): number | null {
    if (node === null) return null
    if (node === ctx.clock)           return SENTINEL_CLOCK
    if (node === ctx.deletionLayer)   return SENTINEL_DELETION
    if (node === ctx.backgroundLayer) return SENTINEL_BACKGROUND
    if (node === ctx.menuLayer)       return SENTINEL_MENU
    if (node instanceof Layer)        return visit(node)
    return null
  }

  // root is always id 0
  visit(ctx.root)

  // Main stack, root-to-top. Skip infrastructure (BindingLayers — recreated
  // in phase 7), StartupLayer (transient, never persisted) and the menu
  // (sentinel — it's a singleton, not a LayerRecord).
  const stackIds: number[] = []
  for (let l: Layer | null = ctx.root; l !== null; l = l.layerAbove) {
    if (l === ctx.root)     { stackIds.push(0); continue }
    if (l.isInfrastructure) continue
    if (l instanceof StartupLayer) continue
    if (l === ctx.menuLayer) { stackIds.push(SENTINEL_MENU); continue }
    stackIds.push(visit(l))
  }

  // Background items. BindingLayers occasionally parked here (e.g. the
  // mask-drop shortcut) are skipped — the binding they represent is
  // recovered from the consumer's own slot record in phase 7.
  const backgroundIds: number[] = []
  for (const l of ctx.backgroundLayer.items) {
    if (l.isInfrastructure) continue
    backgroundIds.push(visit(l))
  }

  // Archived (deleted) layers.
  const archiveIds: number[] = []
  for (const l of ctx.deletionLayer.archivedLayers) {
    if (l.isInfrastructure) continue
    archiveIds.push(visit(l))
  }

  // Build LayerRecords. `order` may grow while this runs (a slot source
  // not otherwise reachable gets visited here); the loop bound re-reads
  // `order.length` each iteration so such layers get records too.
  const layers: LayerRecord[] = []
  for (let i = 0; i < order.length; i++) {
    const layer = order[i]!
    const state = await encodeState(layer.serializeState())

    // root.clockSlot is a raw ParameterSlot.bind() to the singleton Clock,
    // re-established unconditionally by main.ts's bootstrap — never
    // serialize it as a normal bindable slot.
    const clockSlot = (layer === ctx.root) ? ctx.root.clockSlot : null

    const slots: SlotRecord[] = layer.slotList.map(slot => {
      if (slot === clockSlot) return { state: SlotState.Unbound, sourceId: null }
      return { state: slot.state, sourceId: refId(slot.source) }
    })

    // CollectionLayer's ingested items live only in _layers — not in the
    // stack/background/archive — so visit() here is what gives them ids.
    const itemIds: number[] = layer instanceof CollectionLayer
      ? layer.items.map(item => visit(item))
      : []

    layers.push({
      id: i,
      class: layer.constructor.name,
      debugName: layer.debugName,
      bounds: { ...layer.bounds },
      isHiddenHelper: layer.isHiddenHelper,
      helperHostId: refId(layer.helperHost),
      hiddenHelperId: refId(layer.hiddenHelper),
      helperBelow: layer.helperBelow,
      state,
      slots,
      itemIds,
    })
  }

  const selectedId = ctx.selected !== null ? (idOfLayer.get(ctx.selected) ?? null) : null

  return {
    version: SAVE_FILE_VERSION,
    canvas: { width: Node.canvasWidth, height: Node.canvasHeight },
    clock: { elapsed: ctx.clock.elapsed, paused: ctx.clock.paused },
    layers,
    stack: stackIds,
    background: backgroundIds,
    archive: archiveIds,
    selectedId,
  }
}

// ------------------------------------------------------------
// Teardown — discard the current session's non-singleton layers so
// `deserialize` can rebuild in place, with no page reload.
// ------------------------------------------------------------

export function teardownSession(ctx: PersistenceContext): void {
  const singletons = new Set<Layer>([
    ctx.root, ctx.clock, ctx.deletionLayer, ctx.backgroundLayer, ctx.menuLayer,
  ])

  // Snapshot everything reachable from the live stack, background, and
  // archive, then detach the stack chain entirely (including the
  // singletons within it — they get re-spliced by deserialize's phase 3).
  const chain: Layer[] = []
  for (let l: Layer | null = ctx.root.layerAbove; l !== null; l = l.layerAbove) chain.push(l)
  for (const l of chain) l.removeFromStack()

  const doomed = new Set<Layer>()
  for (const l of chain) if (!singletons.has(l)) doomed.add(l)
  for (const l of ctx.backgroundLayer.items) if (!singletons.has(l)) doomed.add(l)
  for (const l of ctx.deletionLayer.archivedLayers) if (!singletons.has(l)) doomed.add(l)

  for (const l of [...ctx.backgroundLayer.items]) ctx.backgroundLayer.removeItem(l)
  for (const l of [...ctx.deletionLayer.archivedLayers]) ctx.deletionLayer.removeFromArchive(l)

  // Sever every BindingLayer that touches a doomed layer, in either
  // direction — this unbinds the consumer's slot and detaches the
  // BindingLayer from its source's dependents (including persisting
  // singletons such as `clock`).
  for (const node of [...graph.nodes]) {
    if (!(node instanceof BindingLayer)) continue
    const consumer = node.slot.owner
    const source   = node.source
    const touchesDoomed =
      doomed.has(node) ||
      (consumer instanceof Layer && doomed.has(consumer)) ||
      (source instanceof Layer   && doomed.has(source))
    if (touchesDoomed) node.remove()
  }

  for (const l of doomed) graph.unregister(l)
}

// ------------------------------------------------------------
// Load
// ------------------------------------------------------------

interface MaskTrackerHost {
  setMaskTracker(helper: MaskLayer): void
}

function hasMaskTracker(layer: Layer): layer is Layer & MaskTrackerHost {
  return typeof (layer as unknown as { setMaskTracker?: unknown }).setMaskTracker === 'function'
}

function resolveSource(id: number, idToLayer: Map<number, Layer>, ctx: PersistenceContext): Node | null {
  switch (id) {
    case SENTINEL_CLOCK:      return ctx.clock
    case SENTINEL_DELETION:   return ctx.deletionLayer
    case SENTINEL_BACKGROUND: return ctx.backgroundLayer
    case SENTINEL_MENU:       return ctx.menuLayer
    default:                  return idToLayer.get(id) ?? null
  }
}

// Reconstructs the session in place. Returns the layer that should become
// selected (or null — caller falls back to its own default).
export async function deserialize(json: SaveFile, ctx: PersistenceContext): Promise<Layer | null> {
  if (typeof json.version !== 'number' || json.version > SAVE_FILE_VERSION) {
    throw new Error(`Unsupported save file version: ${json.version}`)
  }

  teardownSession(ctx)

  // Phase 1 — instantiate every layer (root is the existing singleton, id 0).
  const idToLayer = new Map<number, Layer>()
  idToLayer.set(0, ctx.root)
  for (const record of json.layers) {
    if (record.id === 0) continue
    const factory = LAYER_CLASSES[record.class]
    if (!factory) {
      console.warn(`Persistence: unknown layer class "${record.class}" (id ${record.id}) — skipped`)
      continue
    }
    idToLayer.set(record.id, factory())
  }

  // Phase 2 — restore per-layer state.
  for (const record of json.layers) {
    const layer = idToLayer.get(record.id)
    if (!layer) continue
    layer.debugName     = record.debugName
    layer.bounds        = { ...record.bounds }
    layer.isHiddenHelper = record.isHiddenHelper
    layer.helperBelow    = record.helperBelow
    const decoded = await decodeState(record.state)
    layer.deserializeState(decoded)
  }

  // Phase 2b — restore CollectionLayer ingested items (this._layers). These
  // layers are never part of stack/background/archive; itemIds is the only
  // reference to them.
  for (const record of json.layers) {
    const layer = idToLayer.get(record.id)
    if (!layer || !(layer instanceof CollectionLayer) || record.itemIds.length === 0) continue
    const items = record.itemIds.map(id => idToLayer.get(id)).filter((l): l is Layer => l !== undefined)
    layer.restoreItems(items)
  }

  // Phase 3 — wire the main stack, root to top.
  let top: Layer = ctx.root
  for (const id of json.stack) {
    if (id === 0) continue
    let layer: Layer | undefined
    switch (id) {
      case SENTINEL_MENU:     layer = ctx.menuLayer; break
      case SENTINEL_DELETION: layer = ctx.deletionLayer; break
      default:                layer = idToLayer.get(id)
    }
    if (!layer) {
      console.warn(`Persistence: stack references unknown layer id ${id} — skipped`)
      continue
    }
    layer.insertAbove(top)
    top = layer
  }

  // Phase 4 — restore hidden-helper links (positions are already correct
  // from phase 3; this just restores the helperHost/hiddenHelper pointers).
  for (const record of json.layers) {
    const layer = idToLayer.get(record.id)
    if (!layer) continue
    if (record.helperHostId !== null) {
      const h = idToLayer.get(record.helperHostId)
      if (h) layer.helperHost = h
    }
    if (record.hiddenHelperId !== null) {
      const h = idToLayer.get(record.hiddenHelperId)
      if (h) layer.hiddenHelper = h
    }
  }

  // Phase 5 — BackgroundLayer items and DeletionLayer archive.
  for (const id of json.background) {
    const layer = idToLayer.get(id)
    if (layer) ctx.backgroundLayer.add(layer)
  }
  for (const id of json.archive) {
    const layer = idToLayer.get(id)
    if (layer) ctx.deletionLayer.archive(layer)
  }
  if (json.archive.length > 0 && ctx.deletionLayer.outsideStack) {
    ctx.deletionLayer.insertAbove(ctx.root)
  }

  // Phase 6 — Clip<Shape> mask-tracker links.
  for (const record of json.layers) {
    const layer = idToLayer.get(record.id)
    if (!layer || record.hiddenHelperId === null) continue
    const helper = idToLayer.get(record.hiddenHelperId)
    if (helper instanceof MaskLayer && hasMaskTracker(layer)) layer.setMaskTracker(helper)
  }

  // Phase 7 — replay slot bindings. The saved graph is a DAG, so replaying
  // any subset of its edges in any order cannot create an intermediate cycle.
  for (const record of json.layers) {
    const layer = idToLayer.get(record.id)
    if (!layer) continue
    const slots = layer.slotList
    for (let i = 0; i < record.slots.length; i++) {
      const slotRecord = record.slots[i]!
      const slot = slots[i]
      if (!slot || slotRecord.state === SlotState.Unbound || slotRecord.sourceId === null) continue
      const source = resolveSource(slotRecord.sourceId, idToLayer, ctx)
      if (!source) continue
      const bl = BindingLayer.create(source, slot)
      if (bl && slotRecord.state === SlotState.SuspendedBound) bl.toggle()
    }
  }

  // Phase 8 — restore the singleton ClockLayer and re-establish
  // root.clockSlot (a raw bind, not a BindingLayer — see phase-7 skip above).
  ctx.clock.restoreState(json.clock.elapsed, json.clock.paused)
  ctx.root.setClock(ctx.clock)

  // Phase 9 — finish. Caller is responsible for refreshStack()/selection.
  ctx.root.forceDirty()

  return json.selectedId !== null ? (idToLayer.get(json.selectedId) ?? null) : null
}
