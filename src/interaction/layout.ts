// ------------------------------------------------------------
// layout — shared responsive layout constants
// ------------------------------------------------------------
//
// The LayerStackWidget occupies a strip on the left of the canvas whose
// width scales with canvas width (see LayerStackWidget.ts). Canvas-space
// panels (the "canvas-space pill" convention in CLAUDE.md) must start to
// the right of that strip. These helpers are the single source of truth
// for that boundary so the widget and panel layouts stay in sync.

const WIDGET_FRAC   = 0.20   // strip width as a fraction of canvas width
const WIDGET_MIN    = 120    // floor — keeps cards usable on very narrow (phone) canvases
const WIDGET_MAX    = 280    // ceiling — matches the original fixed width on wide canvases
const WIDGET_MARGIN = 20     // gap between the strip's right edge and canvas-space content

const PANEL_DEFAULT_W = 260   // historical fixed width of a canvas-space pill
const PANEL_MARGIN    = 10    // gap between a pill's right edge and the canvas edge

// Total width of the LayerStackWidget strip for a given canvas width.
export function stackWidgetWidth(canvasWidth: number): number {
  return Math.round(Math.max(WIDGET_MIN, Math.min(WIDGET_MAX, canvasWidth * WIDGET_FRAC)))
}

// Left edge of the canvas-space panel area (just right of the strip).
export function contentLeft(canvasWidth: number): number {
  return stackWidgetWidth(canvasWidth) + WIDGET_MARGIN
}

// Width of a canvas-space pill starting at contentLeft(canvasWidth) — the
// historical fixed 260px, clamped so the pill's right edge stays within the
// canvas on narrow (phone) canvases.
export function panelWidth(canvasWidth: number): number {
  return Math.max(0, Math.min(PANEL_DEFAULT_W, canvasWidth - contentLeft(canvasWidth) - PANEL_MARGIN))
}
