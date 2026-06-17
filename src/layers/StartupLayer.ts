import { Layer }           from '../core/Layer.js'
import { Node }            from '../core/Node.js'
import { ValueType }       from '../core/types.js'
import type { Ctx2D, Point } from '../core/types.js'

// ------------------------------------------------------------
// StartupLayer — first screen shown on launch
// ------------------------------------------------------------
//
// Renders two large square buttons centred in the full viewport.
// The StackWidget is hidden at startup, so centering uses the
// entire screen rather than just the content-area strip.
// Clicking "Menu" or "Tutorial" fires the corresponding callback
// provided at construction; main.ts is responsible for inserting
// the chosen layer, removing this layer, and calling refreshStack.
//
// On very narrow viewports (< 304 px) the buttons stack vertically.

const BTN_SZ  = 140   // side length of each square button (px)
const BTN_GAP = 24    // gap between the two buttons (px)
const BTN_R   = 16    // corner radius

// Minimum content-area width required for horizontal (side-by-side) layout.
const HORIZ_MIN = BTN_SZ * 2 + BTN_GAP  // 304 px

type BBox = { x: number; y: number; width: number; height: number }

export class StartupLayer extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set()

  // Pixel-pick falls through to root (white fill) in the blank areas;
  // block it so startup remains the selected layer until a button is clicked.
  override readonly blockPixelPick = true

  private readonly _onMenu:     () => void
  private readonly _onTutorial: () => void

  constructor(onMenu: () => void, onTutorial: () => void) {
    super()
    this.debugName  = 'Startup'
    this._onMenu     = onMenu
    this._onTutorial = onTutorial
  }

  protected recompute(): void {}

  // ----------------------------------------------------------
  // Rendering — buttons live in renderSelf so they are visible
  // regardless of whether this layer is selected.
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    const { menu, tutorial } = this._bounds()
    ctx.save()
    this._drawButton(ctx, menu,     'Menu')
    this._drawButton(ctx, tutorial, 'Tutorial')
    ctx.restore()
  }

  renderPanel(_ctx: Ctx2D): void {}

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    const { menu, tutorial } = this._bounds()
    if (this._hit(point, menu) || this._hit(point, tutorial)) return this
    return null
  }

  handlePointerDown(point: Point): boolean {
    const { menu, tutorial } = this._bounds()
    if (this._hit(point, menu))     { this._onMenu();     return true }
    if (this._hit(point, tutorial)) { this._onTutorial(); return true }
    return false
  }

  handlePointerUp(): void {}

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  // Compute button bounding boxes centred in the full viewport.
  // The StackWidget is hidden at startup so the entire screen is available.
  private _bounds(): { menu: BBox; tutorial: BBox } {
    const vw = Node.viewportWidth
    const vh = Node.viewportHeight
    const cx = Math.round(vw / 2)
    const cy = Math.round(vh / 2)

    if (vw < HORIZ_MIN) {
      // Very narrow viewport: stack buttons vertically, centred on screen.
      return {
        menu:     { x: cx - BTN_SZ / 2, y: cy - BTN_GAP / 2 - BTN_SZ, width: BTN_SZ, height: BTN_SZ },
        tutorial: { x: cx - BTN_SZ / 2, y: cy + BTN_GAP / 2,           width: BTN_SZ, height: BTN_SZ },
      }
    }

    // Horizontal layout: centre side by side in the full viewport.
    return {
      menu:     { x: cx - BTN_GAP / 2 - BTN_SZ, y: cy - BTN_SZ / 2, width: BTN_SZ, height: BTN_SZ },
      tutorial: { x: cx + BTN_GAP / 2,           y: cy - BTN_SZ / 2, width: BTN_SZ, height: BTN_SZ },
    }
  }

  private _hit(p: Point, b: BBox): boolean {
    return p.x >= b.x && p.x <= b.x + b.width &&
           p.y >= b.y && p.y <= b.y + b.height
  }

  private _drawButton(ctx: Ctx2D, b: BBox, label: string): void {
    const { x, y, width: w, height: h } = b

    // Background
    ctx.fillStyle = 'rgba(28, 28, 42, 0.90)'
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, BTN_R)
    ctx.fill()

    // Border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.roundRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5, BTN_R)
    ctx.stroke()

    // Subtle inner top highlight
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.roundRect(x + 1.5, y + 1.5, w - 3, h / 2, [BTN_R - 1, BTN_R - 1, 0, 0])
    ctx.stroke()

    // Label
    ctx.fillStyle    = 'rgba(255, 255, 255, 0.88)'
    ctx.font         = '15px monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, x + w / 2, y + h / 2)
  }
}
