import { Layer } from '../core/Layer.js'
import { ValueType, type Ctx2D } from '../core/types.js'

// ------------------------------------------------------------
// RootLayer — the immovable bottom of the layer stack
// ------------------------------------------------------------
//
// Every stack has exactly one RootLayer at its base. It has no
// layerBelow, produces no typed value (types = empty set), and
// renders a neutral checkerboard background that signals "this
// area contains no image content yet" — the same convention used
// by image-editing applications.
//
// The RootLayer's bounds should cover the full canvas. Update
// them when the canvas is resized:
//
//   root.resize(width, height)
//
// All other layers should be inserted above the RootLayer via
// insertAbove(root) or insertAbove(someLayerAlreadyAboveRoot).

// Checkerboard cell size in pixels.
const CELL = 16

// The two alternating cell colours.
const COLOUR_A = '#3c3c3c'
const COLOUR_B = '#2d2d2d'

export class RootLayer extends Layer {
  // The root produces no value — nothing can bind to it as a source.
  readonly types: ReadonlySet<ValueType> = new Set()

  constructor(width = 0, height = 0) {
    super()
    this.bounds    = { x: 0, y: 0, width, height }
    this.debugName = 'RootLayer'
  }

  // Update bounds to match the canvas dimensions (call from ResizeObserver
  // or the window resize handler).
  resize(width: number, height: number): void {
    this.bounds = { x: 0, y: 0, width, height }
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    // No inputs; nothing to recompute.
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    const { width, height } = this.bounds
    if (width <= 0 || height <= 0) return

    // Draw the checkerboard by filling alternating cells.
    // Two passes: first fill the whole area with one colour, then
    // paint every other cell with the second colour.
    ctx.save()

    ctx.fillStyle = COLOUR_A
    ctx.fillRect(0, 0, width, height)

    ctx.fillStyle = COLOUR_B
    const cols = Math.ceil(width  / CELL)
    const rows = Math.ceil(height / CELL)
    for (let row = 0; row < rows; row++) {
      for (let col = (row % 2); col < cols; col += 2) {
        ctx.fillRect(col * CELL, row * CELL, CELL, CELL)
      }
    }

    ctx.restore()
  }
}
