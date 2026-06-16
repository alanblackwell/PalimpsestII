import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ValueType }     from '../core/types.js'
import type { Ctx2D, Point } from '../core/types.js'
import { EllipseLayer }  from './EllipseLayer.js'
import { RectLayer }     from './RectLayer.js'
import { TextLayer }     from './TextLayer.js'
import { ImageLayer }    from './ImageLayer.js'
import { VideoLayer }    from './VideoLayer.js'
import { AmountLayer }   from './AmountLayer.js'
import { ColourLayer }   from './ColourLayer.js'
import { PointLayer }    from './PointLayer.js'
import { MaskLayer }     from './MaskLayer.js'
import { AnimPathLayer } from './AnimPathLayer.js'

// ------------------------------------------------------------
// TutorialLayer — guided tour with text + layer-creation buttons
// ------------------------------------------------------------

const PANEL_X  = 300
const PANEL_Y  = 50
const PANEL_W  = 460
const PAD      = 20
const BTN_W    = 120
const BTN_H    = 34
const BTN_GAP  = 8
const BTN_COLS = 3
const NAV_SZ   = 34   // prev/next arrow button size
const LINE_H   = 19   // line height for body text
const FONT     = '13px monospace'
const TITLE_FONT = 'bold 14px monospace'

type TutBtnDef = { label: string; colour: string; factory: () => Layer }
type TutPage   = { title: string; paragraphs: string[]; buttons: TutBtnDef[] }

function rndColour() {
  const h = Math.random() * 360
  const s = 0.5 + Math.random() * 0.5
  const v = 0.45 + Math.random() * 0.35
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c
  let r = 0, g = 0, b = 0
  if      (h < 60)  { r = c; g = x }
  else if (h < 120) { r = x; g = c }
  else if (h < 180) {        g = c; b = x }
  else if (h < 240) {        g = x; b = c }
  else if (h < 300) { r = x;        b = c }
  else              { r = c;        b = x }
  return { r: r + m, g: g + m, b: b + m, a: 1 }
}

const PAGES: TutPage[] = [
  {
    title: 'Welcome to Palimpsest',
    paragraphs: [
      'Layers are stacked in the panel on the left. The currently selected layer is highlighted — click any layer card to select it.',
      'Use the Up / Down arrow keys to move a layer in the stack. Press Delete to remove the selected layer (it goes to the Deleted tray). Drag a layer card to reorder it.',
      'Try creating a shape below. Each button adds a new layer just below the Tutorial layer — you can create several and then move and adjust them.',
    ],
    buttons: [
      {
        label: 'Ellipse',
        colour: '#e8a04a',
        factory: () => new EllipseLayer(
          Node.viewportWidth  * (0.35 + Math.random() * 0.30),
          Node.viewportHeight * (0.30 + Math.random() * 0.40),
          Node.viewportWidth  * (0.15 + Math.random() * 0.20),
          Node.viewportHeight * (0.12 + Math.random() * 0.18),
          rndColour(),
        ),
      },
      {
        label: 'Rect',
        colour: '#e8a04a',
        factory: () => new RectLayer(
          Node.viewportWidth  * (0.35 + Math.random() * 0.30),
          Node.viewportHeight * (0.30 + Math.random() * 0.40),
          Node.viewportWidth  * (0.15 + Math.random() * 0.20),
          Node.viewportHeight * (0.12 + Math.random() * 0.18),
          rndColour(),
        ),
      },
      {
        label: 'Text',
        colour: '#888888',
        factory: () => new TextLayer(),
      },
    ],
  },
  {
    title: 'Images and Video',
    paragraphs: [
      'An Image layer displays a still image loaded from a file. Once added, click its layer card to select it, then use the file button in the panel to load an image.',
      'You can also add an image at any time by dragging a file directly from your desktop and dropping it onto the canvas — a new Image layer is created automatically.',
      'A Video layer captures live input from a camera connected to your device. Add one below and grant camera permission when prompted.',
    ],
    buttons: [
      {
        label: 'Image',
        colour: '#7ecf7e',
        factory: () => new ImageLayer(),
      },
      {
        label: 'Video',
        colour: '#7ecf7e',
        factory: () => new VideoLayer(),
      },
    ],
  },
  {
    title: 'Values and Binding',
    paragraphs: [
      'Every layer has parameter slots — shown as dots on its card in the stack panel. A value layer feeds its value into any compatible slot on another layer.',
      'To bind: drag from a value layer\'s card in the stack to a slot dot on a consumer layer. The slot glows green when a compatible drag is in progress. You can also click an empty slot row in the panel to create and bind a default value layer automatically.',
      'Colour sets a shape\'s fill colour. Amount controls a numeric value such as opacity or intensity. Point sets a position on the canvas. Try creating a shape from page 1 first, then add one of these and drag it onto a slot.',
    ],
    buttons: [
      {
        label: 'Colour',
        colour: '#e8944a',
        factory: () => new ColourLayer(rndColour()),
      },
      {
        label: 'Amount',
        colour: '#4a8fe8',
        factory: () => new AmountLayer(Math.random()),
      },
      {
        label: 'Point',
        colour: '#cf7ecf',
        factory: () => new PointLayer({
          x: Node.viewportWidth  * (0.25 + Math.random() * 0.50),
          y: Node.viewportHeight * (0.25 + Math.random() * 0.50),
        }),
      },
    ],
  },
  {
    title: 'Masks and Animation Paths',
    paragraphs: [
      'A Mask layer uses any shape — Ellipse, Rect, or a drawn path — to cut a hole or reveal area in layers above it. Add a Mask, then bind a shape to one of its shape slots by dragging.',
      'An Animation Path moves a Point around the perimeter of any shape over time. It needs a shape (for the path) and a Rate or Clock (for speed). When you add one, both are created automatically if not already present.',
      'Try adding a shape from page 1, then add a Mask or AnimPath and see how it binds to the shape below.',
    ],
    buttons: [
      {
        label: 'Mask',
        colour: '#cfcf7e',
        factory: () => new MaskLayer(),
      },
      {
        label: 'AnimPath',
        colour: '#cf7ecf',
        factory: () => new AnimPathLayer(
          Node.canvasWidth  / 2,
          Node.canvasHeight / 2,
        ),
      },
    ],
  },
]

type BBox = { x: number; y: number; width: number; height: number }

export class TutorialLayer extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set()

  override readonly blockPixelPick = true

  private _page = 0
  private _onAdded: ((layer: Layer) => void) | null = null

  // Stored during renderPanel for hit testing
  private _btnBounds: BBox[] = []
  private _prevBounds: BBox | null = null
  private _nextBounds: BBox | null = null

  constructor() {
    super()
    this.debugName = 'Tutorial'
  }

  setOnAdded(fn: (layer: Layer) => void): void {
    this._onAdded = fn
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { page: this._page }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.page === 'number') this._page = state.page
  }

  protected recompute(): void {}

  renderSelf(_ctx: Ctx2D): void {}

  renderPanel(ctx: Ctx2D): void {
    this._drawStripPill(ctx)
    this._drawTutorialPanel(ctx)
  }

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    for (const b of this._btnBounds) {
      if (this._hit(point, b)) return this
    }
    if (this._prevBounds && this._hit(point, this._prevBounds)) return this
    if (this._nextBounds && this._hit(point, this._nextBounds)) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    // Navigation
    if (this._prevBounds && this._hit(point, this._prevBounds)) {
      if (this._page > 0) { this._page--; Node.scheduleFrame?.() }
      return true
    }
    if (this._nextBounds && this._hit(point, this._nextBounds)) {
      if (this._page < PAGES.length - 1) { this._page++; Node.scheduleFrame?.() }
      return true
    }

    // Layer-creation buttons
    const page = PAGES[this._page]!
    for (let i = 0; i < this._btnBounds.length; i++) {
      if (this._hit(point, this._btnBounds[i]!)) {
        const btn = page.buttons[i]!
        const newLayer = btn.factory()
        Layer.assignDebugName(newLayer)
        newLayer.bounds = { ...this.bounds }
        this._onAdded?.(newLayer)
        return true
      }
    }
    return false
  }

  handlePointerUp(): void {}

  // ----------------------------------------------------------
  // Drawing
  // ----------------------------------------------------------

  private _drawStripPill(ctx: Ctx2D): void {
    const b = this.bounds
    if (b.width <= 0 || b.height <= 0) return
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, Math.min(b.height / 2, 8))
    ctx.fill()
    ctx.fillStyle = '#a0a4b8'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, 4, b.height, [4, 0, 0, 4])
    ctx.fill()
    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Tutorial', b.x + 12, b.y + b.height / 2)
    ctx.restore()
  }

  private _drawTutorialPanel(ctx: Ctx2D): void {
    const page = PAGES[this._page]!
    ctx.save()

    // Measure text to determine panel height
    ctx.font = FONT
    const textW = PANEL_W - PAD * 2

    const wrappedParas = page.paragraphs.map(p => this._wrapText(ctx, p, textW))
    const textLines    = wrappedParas.reduce((n, lines) => n + lines.length, 0)
    const paraGaps     = page.paragraphs.length - 1

    const btnRows = Math.ceil(page.buttons.length / BTN_COLS)
    const btnH    = btnRows * BTN_H + (btnRows - 1) * BTN_GAP

    // Title + para text + gap + buttons + gap + nav
    const titleH  = 22
    const contentH = titleH + PAD / 2 + textLines * LINE_H + paraGaps * (LINE_H * 0.5) +
                     (page.buttons.length > 0 ? PAD + btnH : 0) + PAD + NAV_SZ + PAD
    const panH = Math.max(contentH, 120)

    // Panel background
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(PANEL_X, PANEL_Y, PANEL_W, panH, 10)
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = '#a0a4b8'
    ctx.beginPath()
    ctx.roundRect(PANEL_X, PANEL_Y, 4, panH, [4, 0, 0, 4])
    ctx.fill()

    let cy = PANEL_Y + PAD

    // Title
    ctx.font         = TITLE_FONT
    ctx.fillStyle    = 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(page.title, PANEL_X + PAD, cy)
    cy += titleH + PAD / 2

    // Body paragraphs
    ctx.font      = FONT
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    for (let pi = 0; pi < wrappedParas.length; pi++) {
      for (const line of wrappedParas[pi]!) {
        ctx.fillText(line, PANEL_X + PAD, cy)
        cy += LINE_H
      }
      if (pi < wrappedParas.length - 1) cy += LINE_H * 0.5
    }

    // Layer-creation buttons
    this._btnBounds = []
    if (page.buttons.length > 0) {
      cy += PAD
      for (let i = 0; i < page.buttons.length; i++) {
        const btn = page.buttons[i]!
        const col = i % BTN_COLS
        const row = Math.floor(i / BTN_COLS)
        const bx  = PANEL_X + PAD + col * (BTN_W + BTN_GAP)
        const by  = cy + row * (BTN_H + BTN_GAP)
        this._btnBounds.push({ x: bx, y: by, width: BTN_W, height: BTN_H })

        // Button bg
        ctx.fillStyle = 'rgba(255,255,255,0.07)'
        ctx.beginPath()
        ctx.roundRect(bx, by, BTN_W, BTN_H, 5)
        ctx.fill()

        // Colour stripe
        ctx.fillStyle = btn.colour + 'cc'
        ctx.beginPath()
        ctx.roundRect(bx, by, 3, BTN_H, [5, 0, 0, 5])
        ctx.fill()

        // Label
        ctx.fillStyle    = 'rgba(255,255,255,0.85)'
        ctx.font         = '11px monospace'
        ctx.textAlign    = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(btn.label, bx + 10, by + BTN_H / 2)
      }
      cy += btnH
    }

    // Navigation arrows
    const navY = PANEL_Y + panH - PAD - NAV_SZ
    this._prevBounds = null
    this._nextBounds = null

    if (this._page > 0) {
      const pb: BBox = { x: PANEL_X + PAD, y: navY, width: NAV_SZ, height: NAV_SZ }
      this._prevBounds = pb
      this._drawNavBtn(ctx, pb, '◀')
    }

    if (this._page < PAGES.length - 1) {
      const nb: BBox = { x: PANEL_X + PANEL_W - PAD - NAV_SZ, y: navY, width: NAV_SZ, height: NAV_SZ }
      this._nextBounds = nb
      this._drawNavBtn(ctx, nb, '▶')
    }

    // Page indicator (only if more than one page)
    if (PAGES.length > 1) {
      ctx.font         = '11px monospace'
      ctx.fillStyle    = 'rgba(255,255,255,0.45)'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(`${this._page + 1} / ${PAGES.length}`, PANEL_X + PANEL_W / 2, navY + NAV_SZ / 2)
    }

    ctx.restore()
  }

  private _drawNavBtn(ctx: Ctx2D, b: BBox, symbol: string): void {
    ctx.fillStyle = 'rgba(255,255,255,0.10)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 6)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.20)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.roundRect(b.x + 0.5, b.y + 0.5, b.width - 1, b.height - 1, 6)
    ctx.stroke()
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
    ctx.font         = '14px monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(symbol, b.x + b.width / 2, b.y + b.height / 2)
  }

  private _wrapText(ctx: Ctx2D, text: string, maxW: number): string[] {
    const words  = text.split(' ')
    const lines: string[] = []
    let   line   = ''
    for (const word of words) {
      const test = line ? line + ' ' + word : word
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line)
        line = word
      } else {
        line = test
      }
    }
    if (line) lines.push(line)
    return lines
  }

  private _hit(p: Point, b: BBox): boolean {
    return p.x >= b.x && p.x <= b.x + b.width &&
           p.y >= b.y && p.y <= b.y + b.height
  }
}
