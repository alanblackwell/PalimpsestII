import { Node } from '../core/Node.js'
import type { Layer } from '../core/Layer.js'
import type { Ctx2D } from '../core/types.js'
import { contentLeft } from '../interaction/layout.js'

// ------------------------------------------------------------
// Layer help text and overlay renderer
// ------------------------------------------------------------
//
// drawHelpOverlay(ctx, selected) renders a semi-transparent information
// panel over the current layer content.  It is called by the Evaluator
// (after all other UI) and by CaptureLayer's edit-capture composite.
//
// Node.helpVisible is toggled by the ? button in the LayerStackWidget
// name strip and cleared whenever the selected layer changes.

const PANEL_W    = 460
const PANEL_Y    = 50
const PAD        = 20
const LINE_H     = 19
const FONT       = '13px monospace'
const TITLE_FONT = 'bold 14px monospace'

type HelpEntry = { title: string; paragraphs: string[] }

// Map from constructor-name-minus-"Layer" to help content.
const HELP: Record<string, HelpEntry> = {
  Amount: {
    title: 'Amount layer',
    paragraphs: [
      'Produces a numeric value between 0 and 1, shown as a horizontal slider. Drag the thumb to set it, or drive it from a Point layer\'s x/y position via the x-position and y-position slots (bind both to average the two).',
      'Bind this layer to any Amount-typed slot on another layer (opacity, intensity, blend ratio, etc.) by dragging its card onto the target slot. The Calc button below the canvas creates a Math layer pre-wired to this layer\'s output.',
      'Dragging the slider while any input slot (amount, x, or y) is bound suspends that binding, letting you override the value manually. Click the ⏸ icon on a suspended slot row to resume it.',
    ],
  },
  AnimPath: {
    title: 'Animation path layer',
    paragraphs: [
      'Drives a Point around the perimeter of any shape (Rect, Ellipse, Path, Stroke) at a given phase [0, 1], producing a Point other layers can bind to. On creation, the shape slot auto-binds to the nearest perimeter-capable layer below, and a hidden Tempo layer is created and bound to the tempo slot to drive continuous playback.',
      'When a Tempo layer feeds the tempo slot, its BPM appears as a slider right here in the panel. The run-mode checkbox and the clockwise/counter-clockwise button pause playback or reverse direction without losing position — both can also be driven by bound Events.',
      'A one-time "Amount" button (bottom of canvas) creates an Amount layer bound to the path\'s y-position, for quickly deriving a scalar from the motion.',
    ],
  },
  Capture: {
    title: 'Capture layer',
    paragraphs: [
      'Captures the rendered composite of every layer below it as a still photo or recorded movie, cropped to a bound mask\'s bounding box if one is bound, or the viewport otherwise.',
      'Click the shutter/record button (the camera icon toggles photo/movie mode) — a manual click always fires and suspends any bound shutter Event. The cursor-drag icon includes control panels and the mouse pointer in the capture (for interaction demos); the stack icon additionally includes the layer-stack thumbnail strip.',
      'Save downloads the result as a file and Share opens the OS share sheet. A preview pane shows the last capture; recorded movies get play/pause and a scrub bar for review.',
    ],
  },
  ClipDrawing: {
    title: 'Clip drawing layer',
    paragraphs: [
      'Clips an image through a mask you paint freehand, combining Mask\'s drawing tools (✏ paint, ⌫ erase, shape slots, invert) with Clip\'s image-through-mask compositing. Clicking anywhere in idle mode starts painting immediately, without pressing ✏ first.',
      'Shape slots add geometric regions alongside freehand painting. [✕] instantly clears all paint/erase strokes; [↺] undoes one stroke, then on a second press clears everything and unbinds all shape slots (Cmd/Ctrl+Z also undoes one stroke). A second pill holds an invert toggle that flips white and transparent.',
      'The mask slot exposes a hidden mask-tracker helper — click the bound row to reveal and bind it elsewhere. The Move button wraps this layer in a Transform layer so it can be repositioned as a unit.',
    ],
  },
  ClipEllipse: {
    title: 'Clip ellipse layer',
    paragraphs: [
      'Renders an image clipped to an ellipse. Drag the centre handle to move it, the 8 edge/corner handles to resize (snapping to a circle when close to round), and the rotation handle to spin the clip region — the same handle set as a plain Ellipse shape.',
      'Bind an image to the image slot (auto-bound to the nearest image below on creation) via the slot row or by dragging a compatible layer card onto it. Scale, opacity, and stroke-width sliders are present, but the fill/outline toggle has no visible effect here — the clip always uses the shape\'s filled interior.',
      'The mask slot exposes the hidden mask-tracker helper — click the bound row to reveal it. The Move button wraps this layer in a Transform layer so the clipped result can be repositioned as a unit.',
    ],
  },
  ClipPath: {
    title: 'Clip path layer',
    paragraphs: [
      'Renders an image clipped to a freehand closed spline. Drag control points to reshape it, click the outline to add a point, or right-click a point to remove it. A size handle scales all points from the centroid and a rotate handle spins them; a spline-radius slider controls curve tightness.',
      'On creation, or as soon as an image becomes bound, the path is auto-traced from the image\'s alpha contour. Bind an image via the slot row or by dragging an image-producing layer card onto it — it also auto-binds to the nearest image below.',
      'The mask slot exposes the hidden mask-tracker helper — click the bound row to reveal it. The Move button wraps this layer in a Transform layer for repositioning the clipped result as a unit.',
    ],
  },
  ClipRect: {
    title: 'Clip rect layer',
    paragraphs: [
      'Renders an image clipped to a rectangle. Drag the centre handle to move, the 8 edge/corner handles to resize (snapping to a square when width and height are close), and the rotation handle to spin the clip region — the same handle set as a plain Rect shape.',
      'Bind an image to the image slot (auto-bound to the nearest image below on creation) via the slot row or by dragging a compatible layer card. Scale, opacity, and stroke-width sliders are present, but the fill/outline toggle has no visible effect on the clip, which always uses the shape\'s filled interior.',
      'The mask slot exposes the hidden mask-tracker helper for external binding — click the bound row to reveal it. The Move button wraps this layer in a Transform layer for repositioning as a unit.',
    ],
  },
  ClipText: {
    title: 'Clip text layer',
    paragraphs: [
      'Renders an image clipped to the silhouette of a text string — every Text layer control applies: hover the move handle to type directly, or click ✎ for a full edit dialog. Font, bold/italic, size, and justification are set from the panel, and move/scale/rotate handles (with 45° rotation snap) reposition the text.',
      'Bind an image to the image slot (auto-bound to the nearest image below on creation) — the rendered glyphs act as a cookie-cutter mask on it. Binding a Mask to the separate, pre-existing mask slot instead makes the text word-wrap inside that shape, reshaping the clip region to match.',
      'Because this is still a Text layer, it also carries Text\'s own Mask and Point convenience buttons in addition to its built-in clipping — unlike the other Clip-shape layers, it has no Move button of its own.',
    ],
  },
  Clock: {
    title: 'Clock layer',
    paragraphs: [
      'The global time source. Produces a steadily increasing Amount value (seconds elapsed) that drives animation throughout the stack.',
      'Press P, or click the on-canvas ▶/⏸ button, to pause or resume the clock; click ↺ to reset elapsed time to zero. There is only one Clock and it cannot be deleted — it is always evaluating.',
      'Bind the Clock to a Tempo layer\'s time slot to produce a cyclical phase value for animations.',
    ],
  },
  Collection: {
    title: 'Collection layer',
    paragraphs: [
      'Holds a sub-stack of layers, ingested by dragging their thumbnail cards from the stack widget onto the grid (or press C to collect the selected layer). With no index binding, all members composite together as one Image output.',
      'Bind a Count-producing layer (e.g. Index, driven by a bound Event) to the index slot to instead output a single selected member, chosen by count mod N — useful for driving a slideshow.',
      'Drag thumbnails within the grid to reorder them; double-click a thumbnail to eject it back into the main stack, directly above the Collection.',
    ],
  },
  Colour: {
    title: 'Colour layer',
    paragraphs: [
      'Produces a single RGBA colour value. The hue slider (outer ring) and saturation/value picker (inner square) set the colour interactively; the hex value and a swatch are shown below.',
      'Bind this layer to any Colour-typed slot by dragging its card onto the target slot. The Fill button creates a Fill layer pre-bound to this colour.',
      'Enable the sample pill to pick up colour from a bound image instead: bind an image and a point, and the colour becomes the average of pixels within the radius slider\'s reach around that point. Binding an image before a point auto-creates a Point layer for you. Dragging the picker while a slot is bound suspends that binding.',
    ],
  },
  Composite: {
    title: 'Composite layer',
    paragraphs: [
      'Blends two Image inputs — left and right — using one of 14 modes (multiply, screen, overlay, darken/lighten, add, difference, exclusion, hard/soft-light, colour burn/dodge, and hue-add), cycled with the ◀/▶ buttons or by clicking the mode name.',
      'Bind images via the left/right slot rows, or drop them directly onto the thumbnails in the centre-of-canvas widget; the ⇄ button swaps them. The mask slot restricts blending to a specific region. On creation the two nearest Image layers below are auto-bound and moved to Background.',
      'The amount slider between the thumbnails (bindable to an Amount) controls blend strength.',
    ],
  },
  Count: {
    title: 'Count layer',
    paragraphs: [
      'Maintains a non-negative integer counter, displayed as a large numeral. Use the [−] and [+] buttons to step it manually.',
      'Bind an Event layer to the (single) event slot: each new rising-edge pulse increments the counter by one, on top of any manual stepping.',
      'Click [↺] to reset the counter to zero and clear the last-seen event, so the next bound pulse is always detected as new.',
    ],
  },
  Deletion: {
    title: 'Deletion layer',
    paragraphs: [
      'Archive for layers removed from the stack via the Delete/Backspace key. Archived layers keep evaluating — so bindings that still point at them stay live — and are shown as live thumbnails; double-click a thumbnail to restore it above the Deletion layer.',
      'Click × on a thumbnail to permanently purge that layer and any bindings fed from it. The Deletion layer appears in the stack only while the archive is non-empty, and disappears again once it is.',
      'The Background toggle switches the same grid to show layers sent off-stack with the b key instead — a separate collection that keeps recomputing for live downstream bindings without cluttering the stack.',
    ],
  },
  Direction: {
    title: 'Direction layer',
    paragraphs: [
      'Produces an angle and magnitude (0–2π, 0–1) shown as a dial. Drag inside the ring to set both; drag the crosshair centre to move the dial; drag the outer rotate handle to adjust angle only. Position, a handle-target point, a line-source direction, and magnitude can each be overridden by binding a slot.',
      'Bind to any Direction-typed slot — typically rotation on Image, Shape, Text, or Transform layers. Snap points every 45° assist with cardinal directions; dwell on a snap point to engage fine-adjustment mode.',
      'A rotation-animation pill lets the dial spin continuously: toggle it on with the run button (or bind an Event), set speed with its slider (or bind an Amount), and flip direction with the clockwise/counter-clockwise button (or bind an Event). Binding a handle-target point overrides the animation each frame.',
    ],
  },
  Ellipse: {
    title: 'Ellipse layer',
    paragraphs: [
      'Renders a filled or outlined ellipse and produces a Mask, a Point (the centre), and an Image. Drag the centre handle to move it, the 8 edge/corner handles to resize (opposite side stays fixed, snapping to a circle when close), and the rotation handle to spin.',
      'Bind a Colour to the fill slot, toggle outline mode, or bind a Direction to the rotation slot. Separate opacity, scale, and stroke-width sliders (each bindable to an Amount) sit in the pills below. In artistic mode, fills render as torn paper and outlines as a hand-brushed stroke.',
      'Point / Animate / Mask buttons below the canvas add a Point layer pinned to one of this shape\'s reference points, an AnimPath layer that follows its perimeter, or a Mask layer seeded with this shape — separate from the shape\'s own Point output (its centre).',
    ],
  },
  Event: {
    title: 'Event layer',
    paragraphs: [
      'Generates a discrete event pulse. Use the ⚡ button to fire a single pulse manually, or press ▶ to fire repeatedly at the interval set by the rate slider — the slider runs its own internal timer even with nothing bound. Click ↺ to clear the last event and any proximity/collision calibration.',
      'Bind a Tempo layer to the tempo slot to drive the interval from a shared clock — the slider on the Event layer will then also control that Tempo\'s speed.',
      'Bind an AnimPath and a target Point to the proximity slots to fire once per cycle when the path makes its closest approach to the target.',
      'Bind two image-producing layers to the collision slots to fire whenever their visible pixels overlap. The event fires on the rising edge only — once per contact.',
      'Connect to shutter slots (Capture), reset slots (Count), toggle slots (AnimPath run mode), or any other Event-typed input.',
    ],
  },
  Fill: {
    title: 'Fill layer',
    paragraphs: [
      'Generates a solid fill or a two-colour gradient. Cycle between fill / linear / radial modes with the ◀/▶ buttons. Bind Colour layers to colour a / colour b (swap them with ⇄) — in gradient modes, binding only one colour fades it to transparent instead of mixing in a default.',
      'Bind a Point to the position slot for the gradient\'s centre, and a Direction to set the linear axis angle or the radial reach (via magnitude).',
      'Useful as a background or gradient backdrop for blending; opacity is adjustable via the slider below the slot rows. Combine with a Clip or Composite mask slot elsewhere in the stack to reveal only part of the fill.',
    ],
  },
  Filter: {
    title: 'Filter layer',
    paragraphs: [
      'Applies a chain of up to 16 image-processing effects to its Image input — blur, brightness, contrast, saturate, hue-rotate, invert, sepia, threshold, edges, solarise, pixelise, mosaic, drop-shadow, opacity, gradient-map, and false-colour.',
      'Every filter is shown as a pill you can enable independently; drag its ≡ handle to reorder — filters apply top-to-bottom. Each pill\'s intensity slider can be bound to an Amount, and an Event slot can toggle that filter on/off.',
      'Gradient-map: 0.5 is pass-through; lower values push toward a chrome palette, higher toward neon. Per-filter thumbnails preview the pipeline result after each enabled step.',
    ],
  },
  Flash: {
    title: 'Flash layer',
    paragraphs: [
      'Composites a bound Image over the full canvas for a brief window when it receives an Event, then removes it. Bind an Image to the image slot — the source is automatically moved to the background so it\'s only visible during the flash.',
      'Bind an Event to the trigger slot, or click the ⚡ button to fire it directly (this auto-creates a hidden Event source on first use). The duration slider (16 ms–4 s, logarithmic) sets how long the flash lasts.',
      'Below roughly 200 ms the flash is a fast local render only; at longer durations it also emits its own start/end Event pulses, bindable elsewhere, letting other layers toggle in sync with the flash. Stack above other layers so it overlays the composition.',
    ],
  },
  Image: {
    title: 'Image layer',
    paragraphs: [
      'Displays a still image loaded from a file. Click the folder button in the panel to open a file picker, or drag a file from the OS directly onto the canvas.',
      'Move, scale, and rotate using the canvas handles — dragging snaps to nearby layer edges, and rotation snaps to 45° increments (dwell to fine-tune). Bind a Direction to the rotation slot for continuous spin; the opacity slider below the slot rows can be bound to an Amount.',
      'On mobile the image is automatically scaled to fit the viewport when first loaded. One-shot Clip and Filter buttons at the bottom of the canvas quickly wrap the image in those layers.',
    ],
  },
  Line: {
    title: 'Line layer',
    paragraphs: [
      'Draws a straight line between two endpoints. Drag the circle handles to reposition start/end (snapping to 45° angles and to nearby shapes\' edges), toggle the ◀/▶ arrowheads, and use the Point/Mask buttons to spin off a tracking Point or seed a Mask layer.',
      'Width, colour, and opacity are all adjustable and bindable to Amount/Colour slots. Bind Point layers to the start/end slots to animate the endpoints, or bind a Direction to drive the line\'s angle and length directly, with either endpoint free to follow while the other stays anchored.',
      'Exposed as an Image, a Mask (covering just the visible stroke, not a filled interior), and a Direction (the line\'s own angle) — so it can feed filters, compositors, motion blur, or drive another layer\'s rotation.',
    ],
  },
  Mask: {
    title: 'Mask layer',
    paragraphs: [
      'Combines up to four shape inputs (Rect, Ellipse, Path, etc.) with freehand painted/erased strokes into a greyscale mask. Use ✏ (paint) to reveal areas and ⌫ (erase) to hide them — or just click/drag anywhere on the canvas in idle mode to start painting automatically. A slider sets brush size.',
      '[✕] instantly clears all freehand paint and erase strokes. [↺] undoes the last stroke on first press, then clears everything and unbinds all shape slots on a second press; Cmd/Ctrl+Z also undoes one stroke. Erase strokes are stored separately and subtract from the full mask, including bound shapes.',
      'A second pill holds an invert toggle: bind an Event to flip white and transparent automatically, or click the button to flip manually — which permanently takes over from any bound event source.',
    ],
  },
  Math: {
    title: 'Math layer',
    paragraphs: [
      'Passes a single Amount input through a reorderable pipeline of operations — scale, offset, power, invert, smooth, fold, quantize, min, max, sin — each independently switched on and tuned with its own slider or bound Amount/Event. Only reachable via an Amount layer\'s Calc button, not the main menu.',
      'Drag a pill\'s ≡ handle to reorder it in the chain; each pill\'s preview bar shows the running value after that step, and the output meter on the right shows the final result.',
      'Bind an Event to a row\'s toggle slot to switch that operation on or off remotely, or an Amount to its parameter slot to animate it — dragging a slider suspends whichever source is currently bound.',
    ],
  },
  Menu: {
    title: 'Menu layer',
    paragraphs: [
      'The layer creation menu, grouped into Shapes, Media, Values, and Control columns. Click any button to insert that layer type directly below the Menu in the stack — new shapes and text pick up the fill/outline, stroke width, and typography of the most recent shape below.',
      'Press M to move the Menu to the position of the currently selected layer. The palette/shapes icon (top right) toggles artistic mode (torn-paper fills, brush strokes) versus geometric mode (plain primitives, graph-paper grid). Load and Save buttons live at the bottom of the Control column.',
      'The Menu layer itself produces no visual output and is not exported by the Capture layer.',
    ],
  },
  MotionBlur: {
    title: 'Motion blur layer',
    paragraphs: [
      'Accumulates successive frames of its Image input into a persistent cache, creating motion-trail or long-exposure effects. The source image is auto-bound and sent to Background on creation.',
      'The fade slider controls how quickly old frames vanish (0 = full accumulation, 1 = only the latest frame visible). The delay slider controls how often the cache updates (0 = every frame, 1 = frozen).',
      'Bind an Event to the capture slot to force an immediate cache update on each pulse — combine with delay = 1 for fully manual, one-shot captures.',
    ],
  },
  Noise: {
    title: 'Noise layer',
    paragraphs: [
      'Generates an animated procedural texture in one of six styles — static/colour TV-snow, cracks, ripples, warp, or organic — cycled with the ◀/▶ buttons; the seed stepper reshuffles the pattern.',
      'Scale, speed, warp (detail/strength), and drift (Direction) sliders shape the pattern and animation; each can be bound to an Amount/Direction layer. Time is auto-bound to the Clock at creation.',
      'Exposes the result both as an Image (pipe into Composite, Filter, Mask, or Clip) and as an Amount — the value sampled from the texture at the position slot — useful for driving other layers from a noise field.',
    ],
  },
  Path: {
    title: 'Path layer',
    paragraphs: [
      'Renders a closed Catmull-Rom spline through a set of control points, producing a Mask (filled interior), a Point (centroid), and an Image. Drag any point to move it, click the outline to insert a new point on the curve, or right-click a point to delete it (minimum 3 points).',
      'A dedicated size handle scales all points from the centroid and a rotate handle spins them around it; a spline-radius slider (bindable to an Amount) controls how tightly the curve hugs the points. Bind a Colour to the fill slot, toggle outline mode, or bind a Direction to the rotation slot.',
      'Opacity, scale, and stroke-width each have their own slider/Amount slot. Point / Animate / Mask buttons below the canvas add a reference-point Point layer, an AnimPath layer following the spline, or a Mask layer seeded with this shape.',
    ],
  },
  Point: {
    title: 'Point layer',
    paragraphs: [
      'Produces an XY position on the canvas. Drag the crosshair to set it, bind a Point source to the main slot, or bind a shape/path layer to the shape slot to snap onto (and cycle through) its named reference points via the ◀/▶ spinner.',
      'Wander mode drives the point with a small simulation when unbound: cycle among five algorithms (drift, brownian, orbit, wave, track) with ◀/▶; amount and speed sliders (or bound Amount/Rate sources) control turn intensity and travel speed. Track mode instead follows the mouse pointer, with amount setting a wandering offset radius.',
      'Bind a Mask to the wander pill\'s mask slot to confine wandering inside that shape — the point bounces off the mask edge (or the canvas edge if unbound). The wander toggle button ≋ hands permanent manual control once touched, bypassing any bound Event trigger.',
    ],
  },
  Tempo: {
    title: 'Tempo layer',
    paragraphs: [
      'Converts a time source into a cyclical 0–1 phase value at a musical tempo. The slider controls speed in BPM, with conventional metronome markings from Larghissimo to Prestissimo.',
      'Bind the Clock (or any Amount source) to the time slot — new Tempo layers are auto-bound to the Clock on creation. The phase output drives Animate, Event, Noise, and any other layer with a tempo/rate slot.',
      'When an Animate or Event layer is bound to this Tempo, that layer\'s own speed slider also controls this Tempo\'s BPM — the "responds to" pill lists all such controllers.',
    ],
  },
  Rect: {
    title: 'Rect layer',
    paragraphs: [
      'Renders a filled or outlined rectangle and produces a Mask, a Point (the centre), and an Image. Drag the centre handle to move, and any of the 8 edge/corner handles to resize (opposite edge/corner stays fixed) — resizing snaps to a square when width and height are close, on both edge and corner drags.',
      'Bind a Colour to the fill slot, toggle outline mode, or bind a Direction to the rotation handle. Opacity, scale, and stroke-width each have their own slider pill and Amount slot. In artistic mode the fill renders as torn paper and the outline as a brushed stroke.',
      'Point / Animate / Mask buttons below the canvas add a reference-point-tracking Point layer, an AnimPath layer following this rectangle\'s perimeter, or a Mask layer seeded with this shape — separate from the rectangle\'s own Point output (its centre).',
    ],
  },
  Root: {
    title: 'Root layer',
    paragraphs: [
      'The bottom of the layer stack — always present and cannot be deleted. By default it fills the canvas white; bind a Colour layer to the colour slot to change the fill, or click the toggle button on the slot row to switch to a checkerboard indicating no fill.',
      'While Root is selected, a clock-face readout appears centred on the canvas: an hour hand sweeps once per 60 minutes (turning red on the second lap), a second hand sweeps once per minute with a fading trail, and elapsed time is shown numerically below the dial.',
      'The clock slot is a permanent link to the app\'s singleton Clock — click its row to select the Clock layer. All other layers sit above Root in the stack; Root\'s output is the base of every composition.',
    ],
  },
  Rotate: {
    title: 'Rotate layer',
    paragraphs: [
      'Legacy layer, no longer creatable from the menu — superseded by the Move (Transform) layer\'s rotation handle bound to an Angle layer. Rotates its Image input between a start and end angle, driven by a phase value rather than direct dragging.',
      'Bind Direction layers to the start/end slots and an Amount (from a Rate/Clock) to the phase slot; the angle sweeps start→end→start as a ping-pong triangle wave. The centre slot (Point) sets the pivot — none of these are draggable handles; bind sources or click the run/stop checkbox to pause.',
      'Existing saved sessions containing a Rotate layer continue to work; new compositions should use the Move layer instead.',
    ],
  },
  Select: {
    title: 'Select layer',
    paragraphs: [
      'Switches between two Image inputs, passing the currently-selected one through as its own output. Two live thumbnails appear on the canvas with a block arrow between them — click the arrow to flip which side is active.',
      'Bind separate images to the left and right slots, or drag a layer card straight onto a thumbnail. On creation, the two nearest Image layers below are auto-bound, one to each side.',
      'Bind an Event to the toggle slot to switch sides automatically on each pulse — operating the arrow manually always flips the selection, suspending that binding if one is active and handing control back to you.',
    ],
  },
  Sequencer: {
    title: 'Sequencer layer',
    paragraphs: [
      'A 2-D keyframe step-sequencer: stores 2–8 XY points (edit by dragging dots in the preview, or the [−]/[+] buttons) and outputs the current position as a Point plus the playhead position [0, 1] as an Amount.',
      'Bind an Amount to the rate slot for continuous playback (step, linear, or smooth interpolation between keyframes, cycled with ◀/▶); or bind an Event to advance one step per pulse when rate is unbound.',
      'Not currently reachable from the layer-creation menu — only present if loaded from a saved session that already contains one.',
    ],
  },
  Stroke: {
    title: 'Stroke layer',
    paragraphs: [
      'Draw a freehand line directly on the canvas; on release it\'s simplified into an editable Catmull-Rom curve. Press ✎ to redraw from scratch, or drag existing points to reshape it, click the curve to insert a point, or right-click a point to remove it.',
      'Bind Point layers to the start/end slots to pin either end to a moving target — dragging a free endpoint near another shape\'s edge or corner snaps onto it. Bringing the two endpoints together closes the curve automatically, converting it into a closed Path shape.',
      'Produces a Mask that follows the stroke band (not a filled interior), plus a Point and an Image. Colour, opacity, scale, stroke width, and spline tightness are all adjustable and bindable; Point / Animate / Mask buttons add related layers with one click.',
    ],
  },
  Text: {
    title: 'Text layer',
    paragraphs: [
      'Renders a text string. Hover near the move handle to type directly on the canvas, or click ✎ to open a multiline edit dialog with paste support. Font (built-in and Google fonts), bold/italic, and size ± are set from the panel; drag the move/scale/rotate handles to reposition, resize, or spin the text (rotation snaps to 45°).',
      'Bind a Colour to the fill, a Direction to rotation, or an Amount to opacity or line spacing. Left/center/right/justify buttons control horizontal alignment; binding a Mask makes the text flow and word-wrap inside that shape instead, with vertical-justify buttons and an auto-fit font size.',
      'Produces a Mask of the rendered glyph silhouette and an Image of the coloured text, usable with Clip or Mask layers for cutout effects. Point / Mask buttons below the canvas add a tracking Point or seed a Mask layer with this text\'s shape.',
    ],
  },
  Tile: {
    title: 'Tile layer',
    paragraphs: [
      'Tiles or fits its Image input across the canvas. The source\'s non-transparent content is auto-cropped to a bounding box, then either repeated (tile mode) or scaled to cover the canvas, centred (fit mode) — pick a mode with the two big preview buttons, each showing a live thumbnail of what it currently produces.',
      'In tile mode, the margin slider (below the slot rows, bindable like opacity) sets the gap between adjacent tiles in pixels; negative values (the default) overlap tiles slightly to avoid hairline seams.',
      'Useful for creating repeating patterns or background textures from any image source; the source image is auto-bound and moved to Background on creation.',
    ],
  },
  Trace: {
    title: 'Trace layer',
    paragraphs: [
      'Detects a closed contour from an Image (optionally constrained by a bound Mask), producing the same Point / Mask / Image outputs as Rect, Ellipse, or Path — usable anywhere a shape is accepted. The Point output is a phase position along the traced perimeter, like the other shape layers.',
      'Adjust detection with the rays, smoothing, resolution, radial-bias, circularity, and gradient-mode sliders, then click DETECT to re-run. Drag the resulting control points, or the centre/size/rotate handles, to refine the shape by hand.',
      'Bind a previous shape to the prior slot to seed detection near a known region (useful frame-to-frame). Once 3 or more points are detected, one-shot Path and Clip buttons promote the result to a Path layer or wrap it in a Clip layer.',
    ],
  },
  TrackRect: {
    title: 'Track rectangle layer',
    paragraphs: [
      'Tracks a coloured region by building a hue-histogram model from the pixels inside this rectangle in the bound image, then following the best-matching area frame by frame. Move/resize the rectangle over the target first, then press Capture to (re-)build the colour model from the current frame.',
      'The ▶/⏸ button pauses and resumes tracking (also bindable to an Event); the smooth slider averages the raw tracked position over 1–100 frames to reduce jitter. A frozen copy of the captured frame is shown behind the handles in edit mode so you can see what the tracker last saw.',
      'Outputs a Point (the smoothed tracked centre) and a Mask (the rectangle\'s own shape). Use the Ellipse / Path / Draw buttons to swap to a different region shape without losing the image binding, downstream bindings, or the tracker.',
    ],
  },
  TrackEllipse: {
    title: 'Track ellipse layer',
    paragraphs: [
      'Tracks a coloured region by building a hue-histogram model from the pixels inside this ellipse in the bound image, then following the best-matching area frame by frame. Move/resize the ellipse over the target first, then press Capture to (re-)build the colour model from the current frame. This is the shape created by the Video layer\'s Track button.',
      'The ▶/⏸ button pauses and resumes tracking (also bindable to an Event); the smooth slider averages the raw tracked position over 1–100 frames to reduce jitter. A frozen copy of the captured frame is shown behind the handles in edit mode so you can see what the tracker last saw.',
      'Outputs a Point (the smoothed tracked centre) and a Mask (the ellipse\'s own shape). Use the Rect / Path / Draw buttons to swap to a different region shape without losing the image binding, downstream bindings, or the tracker.',
    ],
  },
  TrackPath: {
    title: 'Track path layer',
    paragraphs: [
      'Tracks a coloured region by building a hue-histogram model from the pixels inside this freehand closed spline in the bound image, then following the best-matching area frame by frame. Shape the outline over the target, then press Capture to (re-)build the colour model from the current frame.',
      'The ▶/⏸ button pauses and resumes tracking (also bindable to an Event); the smooth slider averages the raw tracked position over 1–100 frames to reduce jitter. A frozen copy of the captured frame is shown behind the handles in edit mode so you can see what the tracker last saw.',
      'Outputs a Point (the smoothed tracked centre) and a Mask (the spline\'s filled interior). Use the Rect / Ellipse / Draw buttons to swap to a different region shape without losing the image binding, downstream bindings, or the tracker.',
    ],
  },
  TrackDrawing: {
    title: 'Track drawing layer',
    paragraphs: [
      'Tracks a coloured region defined by a freehand mask — paint (✏) and erase (⌫) the area to track, or bind shape slots, exactly as in a Mask layer. Press Capture to build a colour model from the pixels inside the current mask in the bound image.',
      'The ▶/⏸ button pauses and resumes tracking (also bindable to an Event); the smooth slider averages the raw tracked position over 1–100 frames to reduce jitter. A frozen copy of the captured frame is shown behind the mask controls in edit mode so you can see what the tracker last saw.',
      'Outputs a Point (the smoothed tracked centre) and a Mask (the painted/shape region, as usual for Mask layers). Use the Rect / Ellipse / Path buttons to swap to a geometric region shape without losing the image binding, downstream bindings, or the tracker.',
    ],
  },
  Transform: {
    title: 'Transform layer',
    paragraphs: [
      'Applies move, scale, and rotate transforms to its Image input. Drag the canvas handles to adjust each interactively — dragging snaps to nearby layer edges and rotation snaps every 45° (dwell to fine-tune).',
      'Translate, scale, rotation, and a separate rotation-centre (pivot) point each accept bound values for animation. An opacity slider (bindable to Amount) sits below the slot rows.',
      'The ↔ reflect button mirrors the image through an axis; binding a Direction to the reflect slot sets the axis angle and auto-enables reflect, while pressing ↔ again suspends that binding.',
    ],
  },
  Tutorial: {
    title: 'Tutorial layer',
    paragraphs: [
      'An interactive guided tour of Palimpsest. Navigate pages with the ◀ ▶ arrows or the ← → arrow keys.',
      'Each page includes buttons that create example layers directly into your stack so you can try each concept immediately; the final page is a full reference table of keyboard shortcuts.',
      'You can keep the Tutorial open while working — it does not affect the composition. Delete it when you are done.',
    ],
  },
  Video: {
    title: 'Video layer',
    paragraphs: [
      'A unified video source: choose camera 🎥, screen share ⊞, or a video file 📁 from the button row. Camera/screen permission is requested only when you select that source; file playback adds a scrub bar with a seek-preview thumbnail.',
      'Move, scale, and rotate the displayed video with the canvas handles (snapping to nearby edges and 45° angles); the Fit/Fill button toggles letterbox vs. cover, and Mirror flips horizontally — mirror is auto-detected on camera start using face/skin detection. The enable-toggle button freezes the stream or pauses file playback.',
      'Exposes the current frame as an Image — bind to Composite, Filter, Clip, or Motion Blur for real-time effects. If a camera stream stalls (e.g. after the tab is backgrounded), a restart button appears; the one-shot Track button adds a companion colour-tracking layer.',
    ],
  },
  Warp: {
    title: 'Warp layer',
    paragraphs: [
      'Distorts its Image input around up to five draggable control handles. Drag a handle directly on the canvas to displace the image locally — the whole image warps smoothly around all active handles, with the canvas edges held fixed.',
      'Bind a Point layer (e.g. AnimPath) to a handle slot to animate that handle, or bind a shape (Rect/Ellipse/Path) to the shape slot — the warp then follows the shape\'s perimeter as it moves or deforms, in addition to or instead of the point handles.',
      'The source image binds to the image slot (auto-bound and sent to Background on creation). Unbound handles have no effect; only handles you\'ve touched or bound contribute to the distortion.',
    ],
  },
}

function _wrapText(ctx: Ctx2D, text: string, maxW: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const test = current ? `${current} ${word}` : word
    if (ctx.measureText(test).width > maxW && current !== '') {
      lines.push(current)
      current = word
    } else {
      current = test
    }
  }
  if (current) lines.push(current)
  return lines
}

export function getHelpEntry(layer: Layer): HelpEntry | null {
  const className = layer.constructor.name.replace(/Layer$/, '')
  return HELP[className] ?? null
}

export function drawHelpOverlay(ctx: Ctx2D, selected: Layer | null): void {
  if (!Node.helpVisible || selected === null) return
  const entry = getHelpEntry(selected)
  if (entry === null) return

  const panX = contentLeft(Math.min(Node.canvasWidth, Node.viewportWidth))

  ctx.save()
  ctx.font = FONT
  const textW    = PANEL_W - PAD * 2
  const paras    = entry.paragraphs.map(p => _wrapText(ctx, p, textW))
  let panH = PAD + 22 + PAD / 2   // title + gap
  for (let i = 0; i < paras.length; i++) {
    panH += paras[i]!.length * LINE_H
    if (i < paras.length - 1) panH += LINE_H * 0.5
  }
  panH += PAD

  // Background
  ctx.globalAlpha = 1
  ctx.fillStyle   = 'rgba(20,22,35,0.70)'
  ctx.beginPath()
  ctx.roundRect(panX, PANEL_Y, PANEL_W, panH, 10)
  ctx.fill()

  // Accent stripe
  ctx.fillStyle = 'rgba(180,190,230,0.55)'
  ctx.beginPath()
  ctx.roundRect(panX, PANEL_Y, 4, panH, [4, 0, 0, 4])
  ctx.fill()

  // All text with drop-shadow for contrast over complex imagery
  ctx.shadowColor   = 'rgba(0,0,0,0.90)'
  ctx.shadowBlur    = 4
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 1
  ctx.textAlign    = 'left'
  ctx.textBaseline = 'top'

  // Title
  let cy = PANEL_Y + PAD
  ctx.font      = TITLE_FONT
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.fillText(entry.title, panX + PAD, cy)
  cy += 22 + PAD / 2

  // Body
  ctx.font      = FONT
  ctx.fillStyle = 'rgba(255,255,255,0.88)'
  for (let i = 0; i < paras.length; i++) {
    for (const line of paras[i]!) {
      ctx.fillText(line, panX + PAD, cy)
      cy += LINE_H
    }
    if (i < paras.length - 1) cy += LINE_H * 0.5
  }

  ctx.restore()
}
