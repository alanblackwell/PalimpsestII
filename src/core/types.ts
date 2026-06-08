// ------------------------------------------------------------
// Value type vocabulary
// Every node in the dataflow graph satisfies one or more of these.
// ------------------------------------------------------------

export enum ValueType {
  Image      = 'Image',
  Mask       = 'Mask',
  Colour     = 'Colour',
  Amount     = 'Amount',   // scalar [0, 1]
  Direction  = 'Direction', // 2D vector: angle + magnitude
  Point      = 'Point',    // 2D location
  Rate       = 'Rate',     // temporal frequency
  Count      = 'Count',    // non-negative integer
  Event      = 'Event',    // discrete trigger
  Collection = 'Collection',
}

// ------------------------------------------------------------
// Concrete value representations
// ------------------------------------------------------------

export interface Colour {
  r: number  // [0, 1]
  g: number
  b: number
  a: number
}

export type Amount = number  // [0, 1]

export interface Direction {
  angle: number      // radians
  magnitude: number  // [0, 1] conventionally
}

export interface Point {
  x: number
  y: number
}

export type Rate = number   // cycles per second
export type Count = number  // non-negative integer

// An Event has no payload; it is a discrete pulse.
// The value is the timestamp of the most recent trigger (or null if never triggered).
export type EventValue = number | null

// Image value — a decoded bitmap ready for drawImage().
// null when no image has been loaded yet.
export type ImageValue = ImageBitmap | null

// Mask value — a greyscale OffscreenCanvas (white = included, black = excluded).
// null before the first recompute.
export type MaskValue = OffscreenCanvas | null

// ------------------------------------------------------------
// Rendering context
// The visible canvas uses CanvasRenderingContext2D; off-screen
// caches use OffscreenCanvasRenderingContext2D. Both share the
// same drawing API, so we use a union throughout.
// ------------------------------------------------------------

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

// ------------------------------------------------------------
// Geometry
// ------------------------------------------------------------

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export function emptyBoundingBox(): BoundingBox {
  return { x: 0, y: 0, width: 0, height: 0 }
}

export function boundingBoxContains(box: BoundingBox, p: Point): boolean {
  return p.x >= box.x && p.x < box.x + box.width
      && p.y >= box.y && p.y < box.y + box.height
}

// ------------------------------------------------------------
// Typed value accessor interfaces
// Layers that produce a specific value type implement the
// corresponding interface. Consuming layers cast slot.source
// to the interface to read the value without importing the
// concrete class (avoids tight coupling between layer types).
// ------------------------------------------------------------

export interface AmountSource    { getAmount():    Amount     }
export interface ColourSource    { getColour():    Colour     }
export interface PointSource     { getPoint():     Point      }
export interface DirectionSource { getDirection(): Direction  }
export interface RateSource      { getRate():      Rate       }
export interface CountSource     { getCount():     Count      }
export interface EventSource     { getEventTime(): EventValue }
export interface ImageSource     { getImage():     ImageValue }
export interface MaskSource      { getMask():      MaskValue  }

// ------------------------------------------------------------
// Parameter slot states
// ------------------------------------------------------------

export enum SlotState {
  Unbound         = 'Unbound',
  Bound           = 'Bound',
  SuspendedBound  = 'SuspendedBound',
}
