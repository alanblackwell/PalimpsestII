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
      'Produces a single numeric value between 0 and 1, shown as a horizontal slider. Drag the thumb to set the value.',
      'Bind this layer to any Amount-typed slot on another layer (opacity, intensity, blend ratio, etc.) by dragging its card onto the target slot.',
      'Dragging the slider while its output slot is bound suspends the binding, letting you override the value manually. Click ↺ to restore the last bound value.',
    ],
  },
  AnimPath: {
    title: 'Animation path layer',
    paragraphs: [
      'Drives a Point around the perimeter of any shape (Rect, Ellipse, Path) over time, producing a Point value that other layers can bind to.',
      'The path shape comes from the shape slot; speed comes from the rate slot. Both are created automatically when you add this layer.',
      'The tempo slider sets the starting position around the path (0 = beginning, 1 = full cycle). Bind a Tempo layer to the tempo slot to control speed.',
    ],
  },
  Capture: {
    title: 'Capture layer',
    paragraphs: [
      'Captures the rendered composite of every layer below it as a still photo or recorded movie.',
      'Click the shutter button (●) to take a photo. Toggle movie mode with the film-strip button, then use the same button to start/stop recording.',
      'Edit-capture mode (pencil icon) includes control panels and the mouse cursor in the capture — useful for recording interaction demonstrations.',
    ],
  },
  ClipDrawing: {
    title: 'Clip drawing layer',
    paragraphs: [
      'Clips an image through a mask that you paint freehand, combining the drawing tools of Mask with the image-through-mask compositing of the Clip layers.',
      'Use the ✏ (paint) and ⌫ (erase) tools to define the revealed area. Bind an image to the image slot to composite.',
      'Shape slots let you add geometric regions in addition to freehand painting. The erasure mask (erase strokes) is separate from the paint mask and can be undone independently.',
    ],
  },
  ClipEllipse: {
    title: 'Clip ellipse layer',
    paragraphs: [
      'Renders an image clipped to an ellipse shape — drag the centre handle to move it, and the edge handles to resize.',
      'Bind an image to the image slot using the slot row or by dragging a compatible layer card onto it.',
      'The mask slot exposes the hidden mask-tracker helper. Click the bound slot row to reveal and adjust it directly.',
    ],
  },
  ClipPath: {
    title: 'Clip path layer',
    paragraphs: [
      'Renders an image clipped to a freehand closed spline. Control points are draggable on the canvas; click the path to add new points.',
      'On creation the path is auto-traced from the image\'s alpha contour if an image is already bound.',
      'Bind an image to the image slot using the slot row or by dragging an image-producing layer card onto it.',
    ],
  },
  ClipRect: {
    title: 'Clip rect layer',
    paragraphs: [
      'Renders an image clipped to a rectangle — drag the centre handle to move it, and the edge or corner handles to resize.',
      'Bind an image to the image slot using the slot row or by dragging a compatible layer card.',
      'The mask slot exposes the hidden mask-tracker helper for external binding.',
    ],
  },
  ClipText: {
    title: 'Clip text layer',
    paragraphs: [
      'Renders an image clipped to the silhouette of a text string. Double-click the text on the canvas to edit it; drag to reposition.',
      'Font size, style, and rotation are controlled from the panel. Bind a Direction layer to the rotation slot for animated spinning.',
      'Bind an image to the image slot — the text shape acts as a cookie-cutter mask on the image.',
    ],
  },
  Clock: {
    title: 'Clock layer',
    paragraphs: [
      'The global time source. Produces a steadily increasing Amount value (seconds elapsed) that drives animation throughout the stack.',
      'Press P to pause or resume the clock. There is only one Clock and it cannot be deleted — it is always evaluating.',
      'Bind the Clock to a Tempo layer\'s time slot to produce a cyclical phase value for animations.',
    ],
  },
  Collection: {
    title: 'Collection layer',
    paragraphs: [
      'Holds a set of layers and cycles between them, producing whichever member is currently active as an Image output.',
      'Press C to send the selected layer into the collection. Use the sequencer controls to step through members manually or via an Event slot.',
      'Bind the output to any Image slot to swap between collected images in real time.',
    ],
  },
  Colour: {
    title: 'Colour layer',
    paragraphs: [
      'Produces a single RGBA colour value. The hue slider (outer ring) and saturation/value picker (inner square) set the colour interactively.',
      'Bind this layer to any Colour-typed slot (shape fill colour, text colour, etc.) by dragging its card onto the target slot.',
      'Dragging the picker while bound suspends the binding, letting you override manually.',
    ],
  },
  Composite: {
    title: 'Composite layer',
    paragraphs: [
      'Blends two Image inputs together using a chosen compositing mode (multiply, screen, overlay, difference, and more).',
      'Bind an image to the base slot and another to the blend slot. The mask slot restricts blending to a specific region.',
      'The opacity slider (Amount slot) controls the blend strength.',
    ],
  },
  Count: {
    title: 'Count layer',
    paragraphs: [
      'Maintains an integer counter that increments on each rising-edge Event it receives. Displays the current count as a large numeral.',
      'Bind an Event layer to the increment slot. Each event pulse advances the counter by one.',
      'Use the reset button to zero the counter, or bind a separate Event to the reset slot.',
    ],
  },
  Deletion: {
    title: 'Deletion layer',
    paragraphs: [
      'Holds layers that have been deleted (sent here via the Delete key or the × button on thumbnails). Double-click a thumbnail to restore a layer.',
      'Click × on a thumbnail to permanently destroy that layer. The Deletion layer disappears automatically when the archive is empty.',
      'Toggle the Background view to see and manage layers that have been sent to the Background collection.',
    ],
  },
  Direction: {
    title: 'Direction layer',
    paragraphs: [
      'Produces an angle value (0–2π) shown as a dial on the canvas. Drag the dial handle to set the direction.',
      'Bind to any Direction-typed slot — typically the rotation slot on Image, Shape, Text, or Transform layers.',
      'Snap points every 45° assist with setting cardinal directions. Dwell on a snap point to engage fine-adjustment mode.',
    ],
  },
  Ellipse: {
    title: 'Ellipse layer',
    paragraphs: [
      'Renders a filled or outlined ellipse and produces both a Mask and a Point (the centre). Drag the centre handle to move it, edge handles to resize.',
      'Bind a Colour to the fill colour slot, or toggle outline mode in the panel. The rotation slot accepts a Direction for spinning.',
      'The Point output is the ellipse centre — useful for anchoring an Animation Path.',
    ],
  },
  Event: {
    title: 'Event layer',
    paragraphs: [
      'Generates a discrete event pulse. Use the ⚡ button to fire a single pulse manually, or press ▶ to fire repeatedly at the interval set by the rate slider.',
      'Bind a Tempo layer to the tempo slot to drive the interval from a shared clock — the slider on the Event layer will then also control that Tempo\'s speed.',
      'Bind an AnimPath and a target Point to the proximity slots to fire once per cycle when the path makes its closest approach to the target.',
      'Bind two image-producing layers to the collision slots to fire whenever their visible pixels overlap. The event fires on the rising edge only — once per contact.',
      'Connect to shutter slots (Capture), reset slots (Count), toggle slots (AnimPath run mode), or any other Event-typed input.',
    ],
  },
  Fill: {
    title: 'Fill layer',
    paragraphs: [
      'Renders a solid-colour full-canvas fill. Bind a Colour layer to the colour slot to make the fill colour dynamic.',
      'Useful as the background of a composition or as a base for blending. Supports opacity via the Amount slot.',
      'In combination with a Mask, it reveals or hides parts of underlying content.',
    ],
  },
  Filter: {
    title: 'Filter layer',
    paragraphs: [
      'Applies image-processing effects to the Image bound to its input slot: blur, sharpen, edge detect, gradient-map colour grading, and more.',
      'Select the filter type from the panel menu. Numeric parameters are shown as sliders and can be bound to Amount layers for animation.',
      'Gradient-map: 0.5 is pass-through; lower values push toward a chrome palette, higher toward neon.',
    ],
  },
  Flash: {
    title: 'Flash layer',
    paragraphs: [
      'Produces a brief full-canvas white flash when it receives an Event, then fades back to transparent over a configurable duration.',
      'Bind an Event to the trigger slot to fire the flash on demand. The fade Amount slot controls how quickly it dies away.',
      'Stack above other layers so the flash overlays the composition.',
    ],
  },
  Image: {
    title: 'Image layer',
    paragraphs: [
      'Displays a still image loaded from a file. Click the folder button in the panel to open a file picker, or drag a file from the OS directly onto the canvas.',
      'Move, scale, and rotate using the canvas handles. Bind a Direction to the rotation slot for continuous spin.',
      '"Fit on load" automatically scales the image to fill the canvas when first loaded.',
    ],
  },
  Line: {
    title: 'Line layer',
    paragraphs: [
      'Draws a straight line between two endpoints. Drag the circle handles on the canvas to position start and end points.',
      'Line thickness and colour are set in the panel. Bind Point layers to the start/end slots to animate the endpoints.',
      'The line is also exposed as an Image so it can be fed into filters, compositors, or motion blur.',
    ],
  },
  Mask: {
    title: 'Mask layer',
    paragraphs: [
      'Combines up to four shape inputs (Rect, Ellipse, Path) with freehand painted/erased strokes to produce a greyscale mask.',
      'Use ✏ (paint) to reveal areas and ⌫ (erase) to hide them. Erase strokes are stored separately and subtract from the full mask including shape slots.',
      'Press ↺ once to undo the last stroke; press again to clear all freehand painting and unbind all shape slots. Cmd/Ctrl+Z also undoes one stroke.',
    ],
  },
  Math: {
    title: 'Math layer',
    paragraphs: [
      'Applies a mathematical operation to one or two Amount inputs and produces an Amount output.',
      'Operations include add, subtract, multiply, divide, min, max, absolute value, and trigonometric functions.',
      'Use it to combine, scale, or remap values before feeding them to another layer\'s slots.',
    ],
  },
  Media: {
    title: 'Media layer',
    paragraphs: [
      'Plays back a video file loaded from disk. Use the file button to load a video; playback controls appear in the panel.',
      'Scrub, loop, and play/pause the video. Bind a Tempo or Clock to the position slot for synchronised playback.',
      'Exposes the current video frame as an Image, so it can feed into Composite, Filter, Clip, or Motion Blur layers.',
    ],
  },
  Menu: {
    title: 'Menu layer',
    paragraphs: [
      'The layer creation menu. Click any button to insert that layer type directly below the Menu in the stack.',
      'Press M to move the Menu to the position of the currently selected layer.',
      'The Menu layer itself produces no visual output and is not exported by the Capture layer.',
    ],
  },
  MotionBlur: {
    title: 'Motion blur layer',
    paragraphs: [
      'Accumulates successive frames of its Image input into a persistent cache, creating motion-trail or long-exposure effects.',
      'The fade slider controls how quickly old frames vanish (0 = full accumulation, 1 = only the latest frame visible).',
      'The delay slider controls how often the cache is updated (0 = every frame, 1 = frozen).',
    ],
  },
  Noise: {
    title: 'Noise layer',
    paragraphs: [
      'Generates animated Perlin-noise textures. Scale, octaves, speed, and colour are all adjustable in the panel.',
      'Bind a Clock to the time slot (auto-bound at creation) for continuous animation.',
      'Exposes the result as an Image — pipe into Composite, Filter, Mask, or Clip layers for procedural effects.',
    ],
  },
  Path: {
    title: 'Path layer',
    paragraphs: [
      'Renders a freehand closed spline from a set of control points. Drag existing points on the canvas; click the outline to insert new ones.',
      'Produces a Mask (filled spline area) and a Point (centroid). Bind a Colour to the fill slot or toggle outline mode.',
      'The rotation slot accepts a Direction for rotation around the centroid.',
    ],
  },
  Point: {
    title: 'Point layer',
    paragraphs: [
      'Produces an XY position on the canvas. Drag the crosshair to set it, or bind a Point from another source.',
      'Wander mode adds Brownian-motion drift. The wander toggle button ≋ switches between fixed and wandering modes.',
      'Bind to any Point-typed slot — shape centres, animation path origins, transformation pivots, etc.',
    ],
  },
  Tempo: {
    title: 'Tempo layer',
    paragraphs: [
      'Converts the global Clock into a cyclical 0–1 phase value at a musical tempo. The slider controls speed in BPM, with conventional metronome markings from Larghissimo to Prestissimo.',
      'The time slot is auto-bound to the Clock at creation. The phase output drives Animate, Event, Noise, and any other layer with a tempo slot.',
      'When a Tempo layer is bound to an Animate or Event layer, the slider on that layer also controls this Tempo\'s BPM — the "responds to" pill lists all such controllers.',
    ],
  },
  Rect: {
    title: 'Rect layer',
    paragraphs: [
      'Renders a filled or outlined rectangle and produces both a Mask and a Point (the centre). Drag the centre handle to move, edge/corner handles to resize.',
      'Hold near a corner to snap width and height to a square. Bind a Colour to the fill slot, or toggle outline mode in the panel.',
      'The Point output is the rectangle centre — useful for Animation Path anchoring.',
    ],
  },
  Root: {
    title: 'Root layer',
    paragraphs: [
      'The bottom of the layer stack — always present and cannot be deleted. It renders a checkerboard background to indicate transparency.',
      'The clock slot row shows the global Clock time and can be clicked to select the Clock layer.',
      'All other layers sit above Root in the stack; Root\'s output is the base of every composition.',
    ],
  },
  Rotate: {
    title: 'Rotate layer',
    paragraphs: [
      'Rotates its Image input by a fixed or bound angle around the canvas centre.',
      'Drag the rotation dial handle on the canvas, or bind a Direction layer to the angle slot for continuous animation.',
      'The anchor point can be dragged to rotate around a different centre.',
    ],
  },
  Select: {
    title: 'Select layer',
    paragraphs: [
      'Extracts pixels from an Image input that fall within a specified colour range, producing a Mask.',
      'Drag the colour-picker handle onto the image to sample a target colour. The tolerance slider broadens or narrows the selection.',
      'Bind the Mask output to a Clip or Mask layer to isolate coloured regions for compositing.',
    ],
  },
  Sequencer: {
    title: 'Sequencer layer',
    paragraphs: [
      'Steps through a sequence of Event outputs, firing each in turn when it receives an input Event pulse.',
      'Bind an Event to the input slot and connect each output to separate targets — useful for ordered playback or stepped animations.',
      'The step count and current position are shown in the panel.',
    ],
  },
  Stroke: {
    title: 'Stroke layer',
    paragraphs: [
      'Records freehand brush strokes drawn directly on the canvas. Switch between paint and erase modes in the panel.',
      'Brush size, opacity, and colour are adjustable. The strokes are stored as an Image and can be bound to Image slots elsewhere.',
      'Drag the transform handles to move, scale, or rotate the entire stroke canvas.',
    ],
  },
  Text: {
    title: 'Text layer',
    paragraphs: [
      'Renders a text string on the canvas. Double-click the text to enter edit mode and type new content.',
      'Font, size, colour (via Colour slot), and rotation (via Direction slot) are adjustable in the panel.',
      'Produces a Mask of the text silhouette, usable with Clip or Mask layers for cutout effects.',
    ],
  },
  Tile: {
    title: 'Tile layer',
    paragraphs: [
      'Tiles or fits its Image input across the canvas, repeating it to cover the full area.',
      'Scale and offset sliders control the tiling frequency and position. Fit mode scales the image to fill the canvas exactly.',
      'Useful for creating repeating patterns or background textures from any image source.',
    ],
  },
  Trace: {
    title: 'Trace layer',
    paragraphs: [
      'Records the recent path of a Point input, drawing a fading line trail as the point moves.',
      'The trail length and fade speed are adjustable in the panel. Bind a Point (e.g. from AnimPath or PointLayer) to the point slot.',
      'The resulting trail is exposed as an Image and can be fed into other layers.',
    ],
  },
  Transform: {
    title: 'Transform layer',
    paragraphs: [
      'Applies move, scale, and rotate transforms to its Image input. Drag the canvas handles to adjust each transform interactively.',
      'Individual translate, scale, and rotation slots accept bound values for animation. The reflect button mirrors the image.',
      'The Direction slot sets the reflection axis angle when reflect mode is active.',
    ],
  },
  Tutorial: {
    title: 'Tutorial layer',
    paragraphs: [
      'An interactive guided tour of Palimpsest. Navigate pages with the ◀ ▶ arrows or the ← → arrow keys.',
      'Each page includes buttons that create example layers directly into your stack so you can try each concept immediately.',
      'You can keep the Tutorial open while working — it does not affect the composition. Delete it when you are done.',
    ],
  },
  Video: {
    title: 'Video layer',
    paragraphs: [
      'Captures live video from a camera attached to your device. Grant camera permission when prompted.',
      'Select between available cameras using the device selector in the panel. The mirror toggle flips the image horizontally.',
      'Exposes the live frame as an Image — bind to Composite, Filter, Clip, or Motion Blur for real-time effects.',
    ],
  },
  Warp: {
    title: 'Warp layer',
    paragraphs: [
      'Distorts its Image input using a displacement map — another Image whose colour channels encode the warp direction.',
      'Bind an image to the source slot and a noise or gradient image to the warp slot. The strength slider controls distortion amount.',
      'Animate the warp map (e.g. with a Noise layer driven by Clock) for fluid, organic motion effects.',
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
