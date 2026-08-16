import { Node } from '../core/Node.js'
import { Layer } from '../core/Layer.js'
import { SlotState } from '../core/types.js'

import { CollectionLayer } from '../layers/CollectionLayer.js'
import { BindingLayer }    from '../layers/BindingLayer.js'
import { MaskLayer, settleMaskTrackerPair } from '../layers/MaskLayer.js'

import {
  SAVE_FILE_VERSION,
  SENTINEL_MENU, SENTINEL_CLOCK, SENTINEL_DELETION, SENTINEL_BACKGROUND,
  LAYER_CLASSES,
  encodeState, decodeState, resolveSource,
  type PersistenceContext, type LayerRecord, type SlotRecord,
} from './Persistence.js'

// ------------------------------------------------------------
// CollectionExport — save/load a single CollectionLayer's contents (plus
// any external layers its items depend on via slot bindings) as a
// standalone file, independent of the rest of the session.
// ------------------------------------------------------------
//
// Deliberately a much smaller sibling of Persistence.ts's SaveFile: reuses
// LayerRecord/SlotRecord unchanged, but has no stack/background/archive/
// clock/audioRhythm — none of that applies to a subgraph export. See
// /Users/alan/.claude/plans/crispy-finding-marshmallow.md for the design.

export interface CollectionSaveFile {
  version: number
  kind: 'palimpsest-collection'
  // Canvas size at export time — same field/purpose as SaveFile.canvas in
  // Persistence.ts. Not consumed on import (kept for parity/future use).
  canvas: { width: number; height: number }
  // Actual browser-window size at export time — same field/purpose as
  // SaveFile.viewport; this, not `canvas` above, is what ImageLayer's
  // reload-time letterbox rescale and its debug overlay compare against
  // the current window size.
  viewport: { width: number; height: number }
  // id (within `layers`) of the exported CollectionLayer's own record.
  rootId: number
  layers: LayerRecord[]
}

// ------------------------------------------------------------
// Save
// ------------------------------------------------------------

export async function serializeCollection(
  collection: CollectionLayer, ctx: PersistenceContext,
): Promise<CollectionSaveFile> {
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

  const rootId = visit(collection)

  // Build LayerRecords. `order` grows while this runs — every slot source,
  // hiddenHelper, and nested-collection item not yet visited gets added to
  // the closure via refId()/visit() as its owning record is built, exactly
  // like Persistence.serialize's main record-building loop.
  const layers: LayerRecord[] = []
  for (let i = 0; i < order.length; i++) {
    const layer = order[i]!
    const state = await encodeState(layer.serializeState())

    // A MaskLayer's clipRegionSlot (Clip<Shape> mask-tracker link) is a raw
    // bind, re-derived on load from hiddenHelperId (see phase 6 below)
    // rather than replayed generically in phase 7 — same exclusion as
    // Persistence.serialize().
    const clipRegionSlot = (layer instanceof MaskLayer) ? layer.clipRegionSlot : null
    const slots: SlotRecord[] = layer.slotList.map(slot => {
      if (slot === clipRegionSlot) return { state: SlotState.Unbound, sourceId: null }
      return { state: slot.state, sourceId: refId(slot.source) }
    })

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

  return {
    version:  SAVE_FILE_VERSION,
    kind:     'palimpsest-collection',
    canvas:   { width: Node.canvasWidth,  height: Node.canvasHeight },
    viewport: { width: Node.viewportWidth, height: Node.viewportHeight },
    rootId,
    layers,
  }
}

// ------------------------------------------------------------
// Load
// ------------------------------------------------------------

export interface CollectionImportResult {
  // Freshly instantiated CollectionLayer for the exported record — NOT
  // wired into the stack, and its own items are NOT yet ingested (see
  // itemLayers below). The caller decides where it/its items land: a
  // brand-new stack member (root kept), or merged into an existing
  // CollectionLayer (root discarded — caller must graph.unregister it).
  root: CollectionLayer
  // The root's own top-level items, already fully restored/rewired
  // (state, helpers, bindings) — just not yet ingested anywhere.
  itemLayers: Layer[]
  // Everything else in the closure: layers that exist only because some
  // item (or a dependency of one) needed them as a slot source, or as a
  // required mask-tracker helper. Caller should park these in the global
  // BackgroundLayer — kept evaluating, never rendered, no stack thumbnail.
  backgroundLayers: Layer[]
}

export async function deserializeCollection(
  json: CollectionSaveFile, ctx: PersistenceContext,
): Promise<CollectionImportResult> {
  // Recorded before per-layer state restore (phase 2) so ImageLayer's
  // reload-time letterbox rescale (see ImageLayer.deserializeState) can
  // read it while restoring manualPosition/manualScale. Files from before
  // this field existed have no `viewport` — null skips the rescale/debug
  // overlay entirely rather than computing off `undefined`.
  if (json.viewport === undefined) {
    console.warn('CollectionExport: save file predates the viewport field — letterbox rescale/debug overlay skipped for this load')
  }
  Node.lastLoadedViewport = json.viewport ?? null

  // Phase 1 — instantiate every layer.
  const idToLayer = new Map<number, Layer>()
  for (const record of json.layers) {
    const factory = LAYER_CLASSES[record.class]
    if (!factory) {
      console.warn(`CollectionExport: unknown layer class "${record.class}" (id ${record.id}) — skipped`)
      continue
    }
    idToLayer.set(record.id, factory())
  }

  const root = idToLayer.get(json.rootId)
  if (!(root instanceof CollectionLayer)) {
    throw new Error('CollectionExport: root record is not a CollectionLayer')
  }

  // Phase 2 — restore per-layer state. debugName is deliberately NOT
  // restored from the record — every layer in a collection import gets a
  // fresh name via the same incrementing counter a newly-created layer
  // uses, since the persisted name is almost always identical to some
  // already-live layer's name (the whole file was built from a live
  // session), which reads as confusing duplication rather than useful
  // identity. debugName has no functional effect anywhere else in the
  // codebase (purely a display label / brush-texture hash seed), so this
  // is safe.
  for (const record of json.layers) {
    const layer = idToLayer.get(record.id)
    if (!layer) continue
    Layer.assignDebugName(layer)
    layer.bounds         = { ...record.bounds }
    layer.isHiddenHelper = record.isHiddenHelper
    layer.helperBelow    = record.helperBelow
    const decoded = await decodeState(record.state)
    layer.deserializeState(decoded)
  }

  // Phase 2b — restore nested CollectionLayer ingested items, for every
  // CollectionLayer in the closure EXCEPT the root — the root's own items
  // are handed back via itemLayers, since only the caller knows whether
  // they belong in this freshly-built root or in some other, existing
  // CollectionLayer (the merge case).
  for (const record of json.layers) {
    if (record.id === json.rootId) continue
    const layer = idToLayer.get(record.id)
    if (!layer || !(layer instanceof CollectionLayer) || record.itemIds.length === 0) continue
    const items = record.itemIds.map(id => idToLayer.get(id)).filter((l): l is Layer => l !== undefined)
    layer.restoreItems(items)
  }

  // Phase 4 — restore hidden-helper links.
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

  // Phase 6 — Clip<Shape> mask-tracker links: re-derive the raw
  // clipRegionSlot bind from hiddenHelperId — same as Persistence.deserialize().
  for (const record of json.layers) {
    const layer = idToLayer.get(record.id)
    if (!layer || record.hiddenHelperId === null) continue
    const helper = idToLayer.get(record.hiddenHelperId)
    if (helper instanceof MaskLayer) {
      helper.clipRegionSlot.bind(layer)
      settleMaskTrackerPair(layer, helper)
    }
  }

  // Phase 7 — replay slot bindings. Sentinels resolve against the live ctx
  // singletons, same as a full-session load — a dependency bound straight
  // to the singleton Clock reattaches to the real clock, not a duplicate.
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

  // Ownership closure: root -> its own itemIds (recursively, through any
  // nested collections) -> each owned layer's hiddenHelper (recursively).
  // Anything left over only exists because something needed it as a slot
  // source or an orphaned-but-required mask-tracker helper — that's the
  // backgroundLayers set.
  const rootRecord = json.layers.find(r => r.id === json.rootId)!
  const itemLayers = rootRecord.itemIds
    .map(id => idToLayer.get(id))
    .filter((l): l is Layer => l !== undefined)

  const owned = new Set<Layer>([root])
  const toWalk: Layer[] = [...itemLayers]
  while (toWalk.length > 0) {
    const l = toWalk.pop()!
    if (owned.has(l)) continue
    owned.add(l)
    if (l.hiddenHelper !== null) toWalk.push(l.hiddenHelper)
    if (l instanceof CollectionLayer) for (const item of l.items) toWalk.push(item)
  }

  const backgroundLayers = [...idToLayer.values()].filter(l => !owned.has(l))

  return { root, itemLayers, backgroundLayers }
}
