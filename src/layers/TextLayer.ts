import { Layer } from '../core/Layer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  SlotState,
  boundingBoxContains,
  type Colour,          type ColourSource,
  type Point,           type PointSource,
  type Amount,          type AmountSource,
  type MaskValue, type MaskSource,
  type ImageValue, type ImageSource,
  type Direction,       type DirectionSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'
import { AngleSnapper } from '../interaction/AngleSnapper.js'
import { collectSnapEdges, snapPointToEdges, drawSnapGuides, EDGE_SNAP_THRESHOLD } from '../interaction/EdgeSnapper.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'
import { drawIcon } from '../ui/icons.js'

// ------------------------------------------------------------
// TextLayer — renders a string onto the canvas
// ------------------------------------------------------------
//
// Input slots:
//   positionSlot  (Point)  — anchor for unmasked text.
//   colourSlot    (Colour) — text fill colour.
//   sizeSlot      (Amount) — maps [0,1] → [MIN_SIZE, MAX_SIZE] px.
//   maskSlot      (Mask)   — when bound, text flows within the mask
//                            shape (scanline word-wrap).
//
// Typography controls (in-canvas panel):
//   Font family cycle button · [B] bold · [I] italic · [−] size [+]
//
// Text editing:
//   [✎] opens a multiline overlay dialog with a Paste button.

const ACCENT       = '#c8c8e8'
const DIR_ACCENT   = '#7ecfcf'
const AM_COL       = '#4a8fe8'   // Amount type accent
const MIN_SIZE     = 12
const MAX_SIZE     = 120
const DEFAULT_SIZE = 48

// Panel button geometry
const BTN   = 20
const BTN_M = 6

// Controls-row geometry (below the main pill)
const CTRL_H   = 28
const CTRL_GAP = 4    // gap between pill bottom and controls row

// Maximum border-pad between mask edge and text (slider range 0–BORDER_PAD_MAX px)
const BORDER_PAD_MAX = 100

// Curated typeface list.  System fonts work offline; Google fonts need internet.
type FontEntry = { name: string; category: string; google: boolean }

const FONTS: FontEntry[] = [
  // System fonts — available offline on most platforms
  { name: 'system-ui',       category: 'System',   google: false },
  { name: 'Arial',           category: 'System',   google: false },
  { name: 'Helvetica Neue',  category: 'System',   google: false },
  { name: 'Verdana',         category: 'System',   google: false },
  { name: 'Trebuchet MS',    category: 'System',   google: false },
  { name: 'Gill Sans',       category: 'System',   google: false },
  { name: 'Futura',          category: 'System',   google: false },
  { name: 'Avenir',          category: 'System',   google: false },
  { name: 'Optima',          category: 'System',   google: false },
  { name: 'Georgia',         category: 'System',   google: false },
  { name: 'Palatino',        category: 'System',   google: false },
  { name: 'Baskerville',     category: 'System',   google: false },
  { name: 'Didot',           category: 'System',   google: false },
  { name: 'Times New Roman', category: 'System',   google: false },
  { name: 'Garamond',        category: 'System',   google: false },
  { name: 'Copperplate',     category: 'System',   google: false },
  { name: 'Courier New',     category: 'System',   google: false },
  { name: 'Menlo',           category: 'System',   google: false },
  { name: 'Monaco',          category: 'System',   google: false },
  { name: 'Consolas',        category: 'System',   google: false },
  // Google Fonts — loaded on demand from fonts.googleapis.com
  { name: 'Inter',           category: 'Google',   google: true  },
  { name: 'Roboto',          category: 'Google',   google: true  },
  { name: 'Open Sans',       category: 'Google',   google: true  },
  { name: 'Lato',            category: 'Google',   google: true  },
  { name: 'Montserrat',      category: 'Google',   google: true  },
  { name: 'Raleway',         category: 'Google',   google: true  },
  { name: 'Poppins',         category: 'Google',   google: true  },
  { name: 'Nunito',          category: 'Google',   google: true  },
  { name: 'Playfair Display',category: 'Google',   google: true  },
  { name: 'Merriweather',    category: 'Google',   google: true  },
  { name: 'Lora',            category: 'Google',   google: true  },
  { name: 'EB Garamond',     category: 'Google',   google: true  },
  { name: 'Cormorant Garamond', category: 'Google',google: true  },
  { name: 'Oswald',          category: 'Google',   google: true  },
  { name: 'Bebas Neue',      category: 'Google',   google: true  },
  { name: 'Anton',           category: 'Google',   google: true  },
  { name: 'JetBrains Mono',  category: 'Google',   google: true  },
  { name: 'Fira Code',       category: 'Google',   google: true  },
  { name: 'Source Code Pro', category: 'Google',   google: true  },
  { name: 'Dancing Script',  category: 'Google',   google: true  },
  { name: 'Caveat',          category: 'Google',   google: true  },
  { name: 'Pacifico',        category: 'Google',   google: true  },
  { name: 'Lobster',         category: 'Google',   google: true  },
]

// A scanline entry: first opaque x, span width (in px).
type Scanline = { x: number; w: number } | null

// Transform handle geometry (matches ImageLayer/ClipLayer conventions)
const HANDLE_R   = 7    // circle handle radius (px)
const HANDLE_SZ  = 6    // square handle half-size (px)
const ROT_ARM    = 85   // rotate handle arm length from centre (px)
const HANDLE_HIT = 14   // pointer hit-test radius (px)
const SCALE_OFFSET_FACTOR = 1.6  // scale-handle distance, relative to font size

const ROT_SNAP_ANGLES: readonly number[] = Array.from({ length: 8 }, (_, i) => i * Math.PI / 4)
const ROT_SNAP_THRESHOLD = Math.PI / 12
const ROT_SNAP_DWELL_MS  = 700
const ROT_SNAP_COL = '#7ecfcf'

// Direct in-place text editing
const EDIT_REGION_R = 50   // hover radius around the move handle (px)
const CURSOR_GAP    = 3    // gap between baseline and cursor triangle (px)
const CURSOR_W      = 5    // cursor triangle half-width (px)
const CURSOR_H      = 8    // cursor triangle height (px)

// Unmasked word-wrap: horizontal padding from each canvas edge (px)
const WRAP_PAD = 12

// Default text colour when colourSlot is unbound — light grey, so text
// remains visible against both light and dark backgrounds in display mode.
const DEFAULT_COLOUR: Colour = { r: 0.83, g: 0.83, b: 0.83, a: 1 }

// Word pool for generating placeholder text — the classic cod-Latin
// "Lorem ipsum" passage, split into individual words.
const LOREM_WORDS = (
  'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod ' +
  'tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim ' +
  'veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea ' +
  'commodo consequat Duis aute irure dolor in reprehenderit in voluptate ' +
  'velit esse cillum dolore eu fugiat nulla pariatur Excepteur sint occaecat ' +
  'cupidatat non proident sunt in culpa qui officia deserunt mollit anim id ' +
  'est laborum Sed ut perspiciatis unde omnis iste natus error sit voluptatem ' +
  'accusantium doloremque laudantium totam rem aperiam eaque ipsa quae ab illo ' +
  'inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo ' +
  'Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit'
).split(' ')

// A short run of two or three consecutive words from LOREM_WORDS, used as
// placeholder text for newly-created TextLayers.
function randomDefaultText(): string {
  const n = 2 + Math.floor(Math.random() * 2)   // 2 or 3 words
  const start = Math.floor(Math.random() * (LOREM_WORDS.length - n))
  return LOREM_WORDS.slice(start, start + n).join(' ')
}

type DragState =
  | { type: 'move';   startMouse: Point; startPos: Point }
  | { type: 'scale';  startDist: number; startSize: number; center: Point }
  | { type: 'rotate'; startAngle: number; startRot: number; center: Point }

function ptDist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export class TextLayer extends Layer implements MaskSource, ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Mask, ValueType.Image])

  private readonly _positionSlot: ParameterSlot
  private readonly _colourSlot:   ParameterSlot
  private readonly _sizeSlot:     ParameterSlot
  private readonly _maskSlot:     ParameterSlot
  private readonly _rotationSlot: ParameterSlot
  private readonly _opacitySlot:  ParameterSlot

  // Persisted text content
  private _text: string = ''

  // Typography (manual, persisted across recomputes)
  private _fontFamily:        string                   = Node.defaultFontFamily
  private _bold:              boolean                  = Node.defaultBold
  private _italic:            boolean                  = Node.defaultItalic
  private _manualSize:        number                   = Node.defaultTextSize
  private _justify:           'left' | 'center' | 'right' | 'justify' = Node.defaultJustify
  private _vJustify:          'top' | 'center' | 'bottom' | 'justify' = Node.defaultVJustify
  private _manualLineSpacing: number                   = Node.defaultLineSpacing
  private _maskBorderPad:    number                   = 15
  // Local rectangle mask — set on first paste into a fresh layer, bypasses the mask slot.
  private _localMaskRect: { x: number; y: number; w: number; h: number } | null = null
  // Auto-fit size computed at paste time; separate from _manualSize so MenuLayer doesn't
  // inherit the reduced value as the default for subsequent layers.
  private _localMaskFittedSize: number | null = null

  // Resolved each recompute (from slot or manual)
  private _lineSpacing: number = Node.defaultLineSpacing

  private _lineSpacingSliderDrag = false
  private _borderPadSliderDrag   = false
  private readonly _lineSpacingSlot: ParameterSlot

  // Resolved values (overwritten each recompute)
  private _position: Point  = { x: 400, y: 300 }
  private _colour:   Colour = DEFAULT_COLOUR
  private _size:     number = DEFAULT_SIZE

  // Scanline data sampled from the mask (null = no mask / not yet sampled)
  private _maskRows: Scanline[] | null = null
  // Bounding box of the sampled mask (unrotated frame), updated alongside _maskRows.
  private _maskBBox: { minX: number; maxX: number; minY: number; maxY: number } | null = null
  // Tight bbox of the actual rendered text content within the mask (unrotated frame).
  // Updated every recompute() when _maskRows is set.
  private _textContentBBox: typeof this._maskBBox = null
  // Cached copies retained when the mask slot is suspended.
  private _cachedMaskRows: Scanline[] | null = null
  private _cachedMaskBBox: typeof this._maskBBox = null

  // White-on-transparent silhouette of the rendered text, rebuilt every
  // recompute() — used as this layer's own MaskSource output (getMask()),
  // so a TextLayer can be dropped onto a MaskLayer shape slot.
  private _maskCanvas: OffscreenCanvas

  // The rendered text at its actual colour/typography, rebuilt every
  // recompute() — used as this layer's own ImageSource output (getImage()),
  // so a TextLayer can be dropped onto a Filter/Composite image slot.
  private _imageCanvas: OffscreenCanvas

  // Mask convenience button
  private _addMaskDone  = false
  private _onAddMask: (() => void) | null = null
  setOnAddMask(fn: () => void): void { this._onAddMask = fn }

  private _addPointDone = false
  private _onAddPoint: (() => void) | null = null
  setOnAddPoint(fn: () => void): void { this._onAddPoint = fn }

  // Direct-manipulation state (persist across recompute when slots unbound)
  private _rotation:       number       = 0
  private _manualPosition: Point | null = null
  private _drag:           DragState | null = null

  private readonly _rotSnapper = new AngleSnapper(ROT_SNAP_ANGLES, ROT_SNAP_THRESHOLD, ROT_SNAP_DWELL_MS)
  private _snapSnapped  = false
  private _snapProgress = 0
  private _rotDwellTimer: ReturnType<typeof setInterval> | null = null

  // Edge snap guide lines
  private _edgeSnapX: number | null = null
  private _edgeSnapY: number | null = null
  // Last known text half-extents for position-snap offsets (updated each recompute).
  private _textHalfW = 50
  private _textHalfH = 20

  // Opacity — computed each recompute from slot; 1.0 when unbound
  private _opacity = 1.0

  // Direct in-place text editing — ephemeral UI state, not persisted.
  private _cursorPos:        number  = 0
  private _hoverActive:      boolean = false   // mouse hovering the edit region
  private _dragHoverActive:  boolean = false   // OS text drag hovering this layer
  private _isDefaultText:    boolean = true    // true until the user provides real content

  constructor(text?: string, colour?: Colour) {
    super()
    if (colour !== undefined) this._colour = colour
    this._maskCanvas   = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)
    this._imageCanvas  = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)
    this._isDefaultText = text === undefined
    this._text         = text ?? randomDefaultText()
    this._cursorPos    = this._text.length
    this._manualPosition = this._randomPosition()
    this._positionSlot    = new ParameterSlot(ValueType.Point,     this)
    this._colourSlot      = new ParameterSlot(ValueType.Colour,    this)
    this._sizeSlot        = new ParameterSlot(ValueType.Amount,    this, 'scale')
    this._maskSlot        = new ParameterSlot(ValueType.Mask,      this, 'mask')
    this._rotationSlot    = new ParameterSlot(ValueType.Direction, this, 'rotation')
    this._opacitySlot     = new ParameterSlot(ValueType.Amount,    this, 'opacity')
    this._lineSpacingSlot = new ParameterSlot(ValueType.Amount,    this, 'line spacing')
    this.slots.push(this._positionSlot, this._colourSlot, this._sizeSlot, this._maskSlot, this._rotationSlot, this._opacitySlot, this._lineSpacingSlot)
    this.debugName = 'TextLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get positionSlot(): ParameterSlot { return this._positionSlot }
  get colourSlot():   ParameterSlot { return this._colourSlot   }
  get sizeSlot():     ParameterSlot { return this._sizeSlot     }
  get maskSlot():     ParameterSlot { return this._maskSlot     }
  get rotationSlot(): ParameterSlot { return this._rotationSlot }
  get opacitySlot():  ParameterSlot { return this._opacitySlot  }

  get fontFamily():        string                       { return this._fontFamily        }
  get bold():              boolean                      { return this._bold              }
  get italic():            boolean                      { return this._italic            }
  get manualSize():        number                       { return this._manualSize        }
  get justify():  'left' | 'center' | 'right' | 'justify'  { return this._justify  }
  get vJustify(): 'top'  | 'center' | 'bottom' | 'justify' { return this._vJustify }
  get manualLineSpacing(): number                       { return this._manualLineSpacing }
  get lineSpacingSlot():   ParameterSlot                { return this._lineSpacingSlot   }

  setJustify(newJustify: 'left' | 'center' | 'right' | 'justify'): void {
    const old = this._justify
    if (old === newJustify) return

    // Without a binding, shift _manualPosition so text stays in place visually.
    // 'justify' shares 'left' semantics: anchor is the left edge of the text block.
    if (!this._positionSlot.isActive && this._manualPosition !== null) {
      const ax = this._manualPosition.x
      const hw = this._textHalfW
      const cx = old === 'center' ? ax
               : (old === 'left' || old === 'justify') ? ax + hw
               : ax - hw   // 'right'
      const newAx = newJustify === 'center' ? cx
                  : (newJustify === 'left' || newJustify === 'justify') ? cx - hw
                  : cx + hw   // 'right'
      this._manualPosition = { x: newAx, y: this._manualPosition.y }
    }

    this._justify = newJustify
    Node.defaultJustify = newJustify
    this.markDirty()
  }

  setVJustify(v: 'top' | 'center' | 'bottom' | 'justify'): void {
    if (this._vJustify === v) return
    this._vJustify = v
    Node.defaultVJustify = v
    this.markDirty()
  }

  // Seed a newly-created layer (via slot-click-to-create) with the value
  // currently shown by the corresponding manual control, so the binding
  // starts as a no-op.
  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | Colour | null {
    if (slot === this._colourSlot)   return this._colour
    if (slot === this._positionSlot) return this._manualPosition ?? this._position
    if (slot === this._sizeSlot) {
      const size = this._localMaskFittedSize ?? this._manualSize
      return Math.max(0, Math.min(1, (size - MIN_SIZE) / (MAX_SIZE - MIN_SIZE)))
    }
    if (slot === this._rotationSlot)    return { angle: this._rotation, magnitude: 1 }
    if (slot === this._opacitySlot)     return this._opacity
    if (slot === this._lineSpacingSlot) return (this._manualLineSpacing + 1) / 4
    return null
  }

  // ----------------------------------------------------------
  // MaskSource
  // ----------------------------------------------------------

  getMask(): MaskValue { return this._maskCanvas }

  // ── Reference points (for PointLayer shape binding and endpoint snap) ──

  // 9-point grid (TL, T, TR, R, BR, B, BL, L, C) from the text content bbox
  // (masked) or from the text half-extents about _position (unmasked). Rotation-aware.
  getRefPoints(): Point[] {
    let raw: Point[]
    const bb = this._maskBBox
    if (bb !== null) {
      const mx = (bb.minX + bb.maxX) / 2, my = (bb.minY + bb.maxY) / 2
      raw = [
        { x: bb.minX, y: bb.minY }, { x: mx, y: bb.minY }, { x: bb.maxX, y: bb.minY },
        { x: bb.maxX, y: my      },
        { x: bb.maxX, y: bb.maxY }, { x: mx, y: bb.maxY }, { x: bb.minX, y: bb.maxY },
        { x: bb.minX, y: my      },
        { x: mx,      y: my      },
      ]
    } else {
      const { x, y } = this._position
      const hw = this._textHalfW, hh = this._textHalfH
      raw = [
        { x: x - hw, y: y - hh }, { x,     y: y - hh }, { x: x + hw, y: y - hh },
        { x: x + hw, y          },
        { x: x + hw, y: y + hh }, { x,     y: y + hh }, { x: x - hw, y: y + hh },
        { x: x - hw, y          },
        { x,         y          },
      ]
    }
    if (this._rotation === 0) return raw
    const cx = Node.canvasWidth / 2, cy = Node.canvasHeight / 2
    const cos = Math.cos(this._rotation), sin = Math.sin(this._rotation)
    return raw.map(({ x, y }) => {
      const dx = x - cx, dy = y - cy
      return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
    })
  }

  override getSnapBounds() {
    const bb = this._maskBBox
    if (bb !== null) {
      if (this._rotation === 0) return { minX: bb.minX, maxX: bb.maxX, minY: bb.minY, maxY: bb.maxY }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const p of this.getRefPoints()) {
        if (p.x < minX) minX = p.x;  if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y;  if (p.y > maxY) maxY = p.y
      }
      return { minX, maxX, minY, maxY }
    }
    // Unmasked: AABB derived from text half-extents
    const { x, y } = this._position
    const cosA = Math.cos(this._rotation), sinA = Math.sin(this._rotation)
    const hw = this._textHalfW, hh = this._textHalfH
    const extX = Math.abs(hw * cosA) + Math.abs(hh * sinA)
    const extY = Math.abs(hw * sinA) + Math.abs(hh * cosA)
    return { minX: x - extX, maxX: x + extX, minY: y - extY, maxY: y + extY }
  }


  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._imageCanvas }

  // ----------------------------------------------------------
  // Text content
  // ----------------------------------------------------------

  get text(): string { return this._text }

  // ----------------------------------------------------------
  // Typography helpers
  // ----------------------------------------------------------

  openFontPicker(): void {
    loadGoogleFonts()

    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;' +
      'display:flex;align-items:center;justify-content:center;'

    const picker = document.createElement('div')
    picker.style.cssText =
      'background:#1e1e2e;border-radius:10px;width:500px;max-height:70vh;' +
      'display:flex;flex-direction:column;overflow:hidden;' +
      'box-shadow:0 8px 32px rgba(0,0,0,0.7);'

    // Header
    const header = document.createElement('div')
    header.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;' +
      'padding:12px 16px;background:#16161e;border-bottom:1px solid #2a2a3a;flex-shrink:0;'
    const headerTitle = document.createElement('span')
    headerTitle.style.cssText = 'color:#aaa;font:11px monospace;letter-spacing:0.06em;'
    headerTitle.textContent   = 'CHOOSE TYPEFACE'
    const closeBtn = makeDialogBtn('×', '#3a3a4a')
    closeBtn.style.padding = '1px 8px'
    header.append(headerTitle, closeBtn)

    // Note
    const note = document.createElement('div')
    note.style.cssText =
      'padding:6px 16px;background:#181820;color:#555;font:10px monospace;' +
      'border-bottom:1px solid #22223a;flex-shrink:0;'
    note.textContent = 'Google Fonts section loads from fonts.googleapis.com (requires internet)'

    // Scrollable list
    const list = document.createElement('div')
    list.style.cssText = 'overflow-y:auto;padding:6px 0;'

    let lastCat = ''
    for (const font of FONTS) {
      if (font.category !== lastCat) {
        lastCat = font.category
        const sep = document.createElement('div')
        sep.style.cssText =
          'padding:10px 16px 4px;color:#555;font:10px monospace;letter-spacing:0.08em;'
        sep.textContent = font.category === 'Google'
          ? '── Google Fonts ──────────────────'
          : '── System Fonts ──────────────────'
        list.appendChild(sep)
      }

      const isSelected = font.name === this._fontFamily
      const item = document.createElement('div')
      item.style.cssText =
        `padding:9px 16px 7px;cursor:pointer;` +
        `border-left:3px solid ${isSelected ? ACCENT : 'transparent'};` +
        `background:${isSelected ? 'rgba(200,200,232,0.10)' : 'transparent'};`
      item.onmouseover = () => {
        item.style.background = isSelected ? 'rgba(200,200,232,0.18)' : 'rgba(255,255,255,0.05)'
      }
      item.onmouseout = () => {
        item.style.background = isSelected ? 'rgba(200,200,232,0.10)' : 'transparent'
      }

      const nameEl = document.createElement('div')
      nameEl.style.cssText =
        `font-family:"${font.name}",sans-serif;font-size:20px;color:#e0e0e0;line-height:1.2;`
      nameEl.textContent = font.name

      const sampleEl = document.createElement('div')
      sampleEl.style.cssText =
        `font-family:"${font.name}",sans-serif;font-size:12px;color:#666;margin-top:2px;`
      sampleEl.textContent = 'The quick brown fox jumps over the lazy dog  0123456789'

      item.append(nameEl, sampleEl)
      item.onclick = () => {
        this._fontFamily = font.name
        this.markDirty()
        document.body.removeChild(overlay)
      }
      list.appendChild(item)
    }

    closeBtn.onclick = () => document.body.removeChild(overlay)
    overlay.onclick  = (e) => { if (e.target === overlay) document.body.removeChild(overlay) }

    picker.append(header, note, list)
    overlay.append(picker)
    document.body.appendChild(overlay)

    // Scroll to currently-selected font
    requestAnimationFrame(() => {
      const selected = list.querySelector<HTMLElement>(`[style*="${ACCENT}"]`)
      selected?.scrollIntoView({ block: 'center' })
    })
  }

  toggleBold(): void   { this._bold   = !this._bold;   this.markDirty() }
  toggleItalic(): void { this._italic = !this._italic; this.markDirty() }

  adjustSize(delta: number): void {
    if (this._maskSlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this._maskSlot)?.toggle()
      this._manualSize = Math.round(this._size)  // seed from auto-fitted size
    } else if (this._localMaskFittedSize !== null) {
      this._manualSize = Math.round(this._localMaskFittedSize)
      this._localMaskFittedSize = null  // user takes over from here
    }
    this._manualSize = Math.max(MIN_SIZE, Math.min(MAX_SIZE, this._manualSize + delta))
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Text editing dialog
  // ----------------------------------------------------------

  openEditDialog(): void {
    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;' +
      'display:flex;align-items:center;justify-content:center;'

    const panel = document.createElement('div')
    panel.style.cssText =
      'background:#1e1e2e;border-radius:10px;padding:18px;width:440px;' +
      'display:flex;flex-direction:column;gap:10px;' +
      'font:12px monospace;color:#ccc;box-shadow:0 8px 32px rgba(0,0,0,0.6);'

    const title = document.createElement('div')
    title.textContent = 'Edit text  (Ctrl+Enter to confirm)'
    title.style.cssText = 'color:#888;font-size:10px;letter-spacing:0.05em;'

    const textarea = document.createElement('textarea')
    textarea.value = this._text
    textarea.rows  = 8
    textarea.style.cssText =
      'width:100%;box-sizing:border-box;resize:vertical;' +
      'background:#13131f;color:#e0e0e0;border:1px solid #334;' +
      'border-radius:6px;padding:10px;font:14px monospace;outline:none;' +
      'min-height:80px;line-height:1.5;'

    const btnRow = document.createElement('div')
    btnRow.style.cssText =
      'display:flex;gap:8px;justify-content:space-between;align-items:center;'

    const pasteBtn  = makeDialogBtn('Paste',  '#2a3a5a')
    const cancelBtn = makeDialogBtn('Cancel', '#3a3a4a')
    const okBtn     = makeDialogBtn('OK',     '#1e4a2a')

    const close = (accept: boolean) => {
      if (accept) {
        this._text = textarea.value
        this._cursorPos = Math.min(this._cursorPos, this._text.length)
        this._isDefaultText = false
        this.markDirty()
      }
      document.body.removeChild(overlay)
    }

    // Track whether the user has edited the textarea since opening — if not,
    // the unedited default text is cleared before pasting over it.
    let textEdited = false
    textarea.addEventListener('input', () => { textEdited = true })

    pasteBtn.onclick = async () => {
      try {
        const clip = await navigator.clipboard.readText()
        if (!textEdited) {
          textarea.value = ''
          textarea.selectionStart = textarea.selectionEnd = 0
        }
        const s = textarea.selectionStart, e = textarea.selectionEnd
        textarea.value =
          textarea.value.slice(0, s) + clip + textarea.value.slice(e)
        textarea.selectionStart = textarea.selectionEnd = s + clip.length
        textEdited = true
        textarea.focus()
      } catch { /* clipboard access denied */ }
    }

    cancelBtn.onclick = () => close(false)
    okBtn.onclick     = () => close(true)

    overlay.onclick = (ev) => { if (ev.target === overlay) close(false) }

    textarea.onkeydown = (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault()
        close(true)
      }
      if (ev.key === 'Escape') close(false)
    }

    const leftBtns = document.createElement('div')
    leftBtns.style.cssText = 'display:flex;gap:8px;'
    leftBtns.append(pasteBtn)

    const rightBtns = document.createElement('div')
    rightBtns.style.cssText = 'display:flex;gap:8px;'
    rightBtns.append(cancelBtn, okBtn)

    btnRow.append(leftBtns, rightBtns)
    panel.append(title, textarea, btnRow)
    overlay.append(panel)
    document.body.appendChild(overlay)

    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    })
  }

  // ----------------------------------------------------------
  // Direct in-place text editing
  // ----------------------------------------------------------
  //
  // Hovering the mouse within EDIT_REGION_R of the move handle (or an OS
  // text drag hovering this layer) makes this layer the keyboard-edit
  // target: InteractionSystem routes all keydown/paste events here instead
  // of running its normal shortcut chain.

  // Duck-typed by InteractionSystem — true while keyboard/paste input
  // should be routed to this layer instead of global shortcuts.
  isTextEditActive(): boolean {
    return this._hoverActive || this._dragHoverActive
  }

  // Forces edit-hover for an OS text drag, independent of the mouse position
  // (HTML5 drag events don't update Node.pointerCanvas).
  setExternalDragHover(active: boolean): void {
    this._dragHoverActive = active
  }

  // Recomputed every renderPanel frame from the live pointer position.
  private _updateEditHover(): void {
    const mouse = Node.pointerCanvas
    const hp = this._handlePos()
    this._hoverActive = mouse !== null && ptDist(mouse, hp.move) <= EDIT_REGION_R
  }

  // Duck-typed by InteractionSystem — handles a keydown while
  // isTextEditActive() is true. Returns true if consumed (preventDefault).
  handleTextEditKey(e: KeyboardEvent): boolean {
    const key = e.key
    if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this._insertText(key)
      return true
    }
    switch (key) {
      case 'Enter':      this._insertText('\n');  return true
      case 'Backspace':  this._deleteBackward();  return true
      case 'Delete':     this._deleteForward();   return true
      case 'ArrowLeft':  this._moveCursor(-1, 0); return true
      case 'ArrowRight': this._moveCursor(1, 0);  return true
      case 'ArrowUp':    this._moveCursor(0, -1); return true
      case 'ArrowDown':  this._moveCursor(0, 1);  return true
      case 'Home':       this._moveCursorToLineEdge(-1); return true
      case 'End':        this._moveCursorToLineEdge(1);  return true
      default: return false
    }
  }

  // Duck-typed by InteractionSystem — handles a paste while
  // isTextEditActive() is true. If only the default text is present, the
  // pasted text replaces it rather than being inserted.
  pasteTextAtCursor(text: string): void {
    if (!text) return
    const needsMask = this._isDefaultText && this._localMaskRect === null && !this._maskSlot.isActive
    if (needsMask) this._initLocalMask()
    this._insertText(text)
    if (needsMask) this._fitSizeToLocalMask()
  }

  private _fitSizeToLocalMask(): void {
    if (this._cachedMaskRows === null) return
    const ctx = this._imageCanvas.getContext('2d')!
    const fitted = this._autoFitSize(this._cachedMaskRows, ctx)
    // Store in _localMaskFittedSize, NOT _manualSize, so MenuLayer doesn't inherit it.
    this._localMaskFittedSize = Math.min(this._manualSize, fitted)
  }

  private _initLocalMask(): void {
    const vw = Node.viewportWidth
    const vh = Node.viewportHeight
    const mw = Math.round(vw * 0.5)
    const mh = Math.round(vh * 0.5)
    this._localMaskRect = {
      x: Math.round((vw - mw) / 2),
      y: Math.round((vh - mh) / 2),
      w: mw,
      h: mh,
    }
    this._applyLocalMask()
    this._justify  = 'center'
    this._vJustify = 'center'
    Node.defaultJustify  = 'center'
    Node.defaultVJustify = 'center'
  }

  private _applyLocalMask(): void {
    if (this._localMaskRect === null) return
    const { x, y, w, h: rectH } = this._localMaskRect
    const ch = Node.canvasHeight
    this._cachedMaskRows = Array.from({ length: ch }, (_, row) =>
      (row >= y && row < y + rectH) ? { x, w } : null
    )
    this._cachedMaskBBox = { minX: x, maxX: x + w, minY: y, maxY: y + rectH }
  }

  private _insertText(s: string): void {
    if (this._isDefaultText) {
      this._text          = s
      this._cursorPos     = s.length
      this._isDefaultText = false
    } else {
      this._text = this._text.slice(0, this._cursorPos) + s + this._text.slice(this._cursorPos)
      this._cursorPos += s.length
    }
    this.markDirty()
  }

  private _deleteBackward(): void {
    if (this._isDefaultText) {
      this._text          = ''
      this._cursorPos     = 0
      this._isDefaultText = false
      this.markDirty()
      return
    }
    if (this._cursorPos === 0) return
    this._text = this._text.slice(0, this._cursorPos - 1) + this._text.slice(this._cursorPos)
    this._cursorPos--
    this.markDirty()
  }

  private _deleteForward(): void {
    if (this._isDefaultText) {
      this._text          = ''
      this._cursorPos     = 0
      this._isDefaultText = false
      this.markDirty()
      return
    }
    if (this._cursorPos >= this._text.length) return
    this._text = this._text.slice(0, this._cursorPos) + this._text.slice(this._cursorPos + 1)
    this.markDirty()
  }

  private _moveCursor(dx: number, dy: number): void {
    if (dx !== 0) {
      this._cursorPos = Math.max(0, Math.min(this._text.length, this._cursorPos + dx))
    } else if (dy !== 0) {
      const lines = this._text.split('\n')
      const { line, col } = this._cursorLineCol(lines)
      const targetLine = Math.max(0, Math.min(lines.length - 1, line + dy))
      const targetCol  = Math.min(col, lines[targetLine]!.length)
      this._cursorPos  = this._lineColToIndex(lines, targetLine, targetCol)
    }
    this.markDirty()
  }

  private _moveCursorToLineEdge(dir: -1 | 1): void {
    const lines = this._text.split('\n')
    const { line } = this._cursorLineCol(lines)
    const targetCol = dir < 0 ? 0 : lines[line]!.length
    this._cursorPos = this._lineColToIndex(lines, line, targetCol)
    this.markDirty()
  }

  // Cursor position as (line, column) within `_text.split('\n')`.
  private _cursorLineCol(lines: string[]): { line: number; col: number } {
    let remaining = this._cursorPos
    for (let i = 0; i < lines.length; i++) {
      const len = lines[i]!.length
      if (remaining <= len || i === lines.length - 1) return { line: i, col: remaining }
      remaining -= len + 1   // +1 for the '\n'
    }
    return { line: 0, col: 0 }
  }

  private _lineColToIndex(lines: string[], line: number, col: number): number {
    let idx = 0
    for (let i = 0; i < line; i++) idx += lines[i]!.length + 1
    return idx + col
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      text:              this._text,
      isDefaultText:     this._isDefaultText,
      fontFamily:        this._fontFamily,
      bold:              this._bold,
      italic:            this._italic,
      manualSize:        this._manualSize,
      manualPosition:    this._manualPosition,
      rotation:          this._rotation,
      colour:            this._colour,
      addMaskDone:       this._addMaskDone,
      addPointDone:      this._addPointDone,
      justify:           this._justify,
      vJustify:          this._vJustify,
      manualLineSpacing: this._manualLineSpacing,
      maskBorderPad:     this._maskBorderPad,
      localMaskRect:        this._localMaskRect,
      localMaskFittedSize:  this._localMaskFittedSize,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.text === 'string')       this._text       = state.text
    if (typeof state.fontFamily === 'string') this._fontFamily = state.fontFamily
    if (typeof state.bold === 'boolean')      this._bold       = state.bold
    if (typeof state.italic === 'boolean')    this._italic     = state.italic
    if (typeof state.manualSize === 'number') this._manualSize = state.manualSize
    if (typeof state.rotation === 'number')   this._rotation   = state.rotation
    if (state.colour && typeof state.colour === 'object')   this._colour = state.colour as Colour
    if (state.manualPosition && typeof state.manualPosition === 'object') {
      this._manualPosition = state.manualPosition as Point
    } else {
      // Older saves predate randomised initial placement — fall back to the
      // canvas-centre default rather than the constructor's random position.
      this._manualPosition = null
    }
    this._cursorPos     = this._text.length
    this._isDefaultText = typeof state.isDefaultText === 'boolean'
      ? state.isDefaultText
      : (this._text === 'Hello')
    if (typeof state.addMaskDone  === 'boolean') this._addMaskDone  = state.addMaskDone
    if (typeof state.addPointDone === 'boolean') this._addPointDone = state.addPointDone
    if (state.justify === 'left' || state.justify === 'center' || state.justify === 'right' || state.justify === 'justify') {
      this._justify = state.justify
    }
    if (state.vJustify === 'top' || state.vJustify === 'center' || state.vJustify === 'bottom' || state.vJustify === 'justify') {
      this._vJustify = state.vJustify
    }
    if (typeof state.manualLineSpacing === 'number') this._manualLineSpacing = state.manualLineSpacing
    if (typeof state.maskBorderPad     === 'number') this._maskBorderPad     = state.maskBorderPad
    if (state.localMaskRect && typeof state.localMaskRect === 'object') {
      const r = state.localMaskRect as Record<string, unknown>
      if (typeof r.x === 'number' && typeof r.y === 'number' &&
          typeof r.w === 'number' && typeof r.h === 'number') {
        this._localMaskRect = { x: r.x, y: r.y, w: r.w, h: r.h }
      }
    }
    if (typeof state.localMaskFittedSize === 'number') this._localMaskFittedSize = state.localMaskFittedSize
  }

  protected recompute(): void {
    this._opacity = this._opacitySlot.isActive
      ? (this._opacitySlot.source as AmountSource).getAmount() as Amount
      : 1.0

    this._position = this._positionSlot.isActive
      ? (this._positionSlot.source as PointSource).getPoint()
      : (this._manualPosition ?? { x: Node.canvasWidth / 2, y: Node.canvasHeight / 2 })

    if (this._colourSlot.isActive) {
      this._colour = (this._colourSlot.source as ColourSource).getColour()
    }

    if (this._sizeSlot.isActive) {
      const t = (this._sizeSlot.source as AmountSource).getAmount() as Amount
      this._size = MIN_SIZE + t * (MAX_SIZE - MIN_SIZE)
    } else {
      this._size = this._manualSize
    }

    if (this._rotationSlot.isActive) {
      this._rotation = (this._rotationSlot.source as DirectionSource).getDirection().angle
    }

    if (this._lineSpacingSlot.isActive) {
      const t = (this._lineSpacingSlot.source as AmountSource).getAmount() as Amount
      this._lineSpacing = -1 + t * 4
    } else {
      this._lineSpacing = this._manualLineSpacing
    }

    if (this._maskSlot.isActive) {
      const mask = (this._maskSlot.source as MaskSource).getMask()
      if (mask !== null) {
        this._sampleMask(mask as OffscreenCanvas)
        this._cachedMaskRows = this._maskRows
        this._cachedMaskBBox = this._maskBBox
        // Auto-fit: find the largest font size where all text fits the mask.
        const mctx = this._maskCanvas.getContext('2d')!
        this._size = this._autoFitSize(this._maskRows!, mctx)
      } else {
        this._maskRows = null
        this._maskBBox = null
      }
    } else if (this._maskSlot.state === SlotState.SuspendedBound && this._cachedMaskRows !== null) {
      // Mask binding suspended by the user (manual size override); keep the
      // cached scanlines so text continues to flow within the shape.
      this._maskRows = this._cachedMaskRows
      this._maskBBox = this._cachedMaskBBox
    } else if (this._localMaskRect !== null) {
      // Local rectangle mask (no slot needed); regenerate if canvas has been resized.
      if (this._cachedMaskRows === null || this._cachedMaskRows.length !== Node.canvasHeight) {
        this._applyLocalMask()
      }
      this._maskRows = this._cachedMaskRows
      this._maskBBox = this._cachedMaskBBox
      // Use the auto-fit size when active; _manualSize is kept at the original value
      // so MenuLayer does not inherit the reduced size as a default.
      if (!this._sizeSlot.isActive && this._localMaskFittedSize !== null) {
        this._size = this._localMaskFittedSize
      }
    } else {
      this._maskRows = null
      this._maskBBox = null
      this._cachedMaskRows = null
      this._cachedMaskBBox = null
    }

    this._updateMaskCanvas()
    this._updateImageCanvas()

    // Tight bbox of placed text lines (unrotated frame); used for ref points.
    this._textContentBBox = this._maskRows !== null ? this._computeTextBBoxInMask() : null

    // Update text half-extents used for getSnapBounds and position-handle snap.
    // Use the actual word-wrapped lines (not raw paragraphs) so long text that
    // wraps to the canvas width doesn't produce an oversized _textHalfW.
    if (this._maskRows === null) {
      const mc = this._maskCanvas.getContext('2d')
      if (mc) {
        mc.font = this._fontString()
        const wrapped = this._wrapLines(mc)
        const spc = Math.max(0, this._lineSpacing)
        this._textHalfH = (this._size + spc * (wrapped.length - 1) * this._size) / 2
        let maxW = 1
        for (const l of wrapped) maxW = Math.max(maxW, mc.measureText(l.text).width)
        this._textHalfW = maxW / 2
      }
    } else {
      this._textHalfW = Node.canvasWidth  / 4
      this._textHalfH = Node.canvasHeight / 4
    }
  }

  // Rebuild _maskCanvas: a white-on-transparent silhouette of the rendered
  // text, in the same layout (masked word-wrap or unmasked centred lines)
  // as renderSelf — so this layer's own mask output tracks what's drawn.
  private _updateMaskCanvas(): void {
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    if (this._maskCanvas.width !== w || this._maskCanvas.height !== h) {
      this._maskCanvas = new OffscreenCanvas(w, h)
    }

    const ctx = this._maskCanvas.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    if (!this._text) return

    ctx.save()
    ctx.font      = this._fontString()
    ctx.fillStyle = '#ffffff'

    if (this._maskRows !== null) {
      this._renderMasked(ctx)
    } else {
      this._renderUnmasked(ctx)
    }

    ctx.restore()
  }

  // Rebuild _imageCanvas: the rendered text at its actual colour/typography,
  // in the same layout (masked word-wrap or unmasked centred lines) as
  // renderSelf — so this layer's own image output tracks what's drawn.
  private _updateImageCanvas(): void {
    const w = Node.canvasWidth
    const h = Node.canvasHeight
    if (this._imageCanvas.width !== w || this._imageCanvas.height !== h) {
      this._imageCanvas = new OffscreenCanvas(w, h)
    }

    const ctx = this._imageCanvas.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    this._renderCanvas(ctx, false)
  }

  // Sample the mask OffscreenCanvas into per-row x-extents for text flow.
  //
  // When rotated, the mask is first counter-rotated (-_rotation, about the
  // canvas centre) into a temp canvas before sampling. The resulting rows
  // describe the mask as seen from the text's own (unrotated) frame; drawing
  // wrapped text at these row coordinates with a forward rotation transform
  // (see _renderMasked) places it back inside the true mask outline, rotated
  // by _rotation.
  private _sampleMask(mask: OffscreenCanvas): void {
    const w = mask.width, h = mask.height
    const tmp  = new OffscreenCanvas(w, h)
    const tctx = tmp.getContext('2d')!
    if (this._rotation !== 0) {
      tctx.translate(w / 2, h / 2)
      tctx.rotate(-this._rotation)
      tctx.translate(-w / 2, -h / 2)
    }
    tctx.drawImage(mask as CanvasImageSource, 0, 0)
    const { data } = tctx.getImageData(0, 0, w, h)

    let bMinX = w, bMaxX = -1, bMinY = h, bMaxY = -1
    this._maskRows = Array.from({ length: h }, (_, y) => {
      let minX = w, maxX = -1
      const base = y * w * 4
      for (let x = 0; x < w; x++) {
        if ((data[base + x * 4 + 3] ?? 0) > 128) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
        }
      }
      if (maxX >= 0) {
        if (y   < bMinY) bMinY = y
        if (y   > bMaxY) bMaxY = y
        if (minX < bMinX) bMinX = minX
        if (maxX > bMaxX) bMaxX = maxX
      }
      return maxX >= 0 ? { x: minX, w: maxX - minX + 1 } : null
    })
    this._maskBBox = bMaxY >= 0
      ? { minX: bMinX, maxX: bMaxX + 1, minY: bMinY, maxY: bMaxY }
      : null
  }

  // Binary-search for the largest integer font size [MIN_SIZE, MAX_SIZE] at
  // which all of _text fits within the mask scanlines.  Returns MIN_SIZE if
  // even the smallest size overflows (text is not hidden, just not auto-fit).
  private _autoFitSize(rows: Scanline[], ctx: OffscreenCanvasRenderingContext2D): number {
    let lo = MIN_SIZE, hi = MAX_SIZE, best = MIN_SIZE
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this._textFitsInMask(mid, rows, ctx)) { best = mid; lo = mid + 1 }
      else hi = mid - 1
    }
    return best
  }

  // Returns true if all words in _text can be placed by the masked greedy
  // word-wrap algorithm at the given font size.  Mirrors _renderMasked without
  // drawing — used by _autoFitSize to evaluate candidate sizes.
  private _textFitsInMask(size: number, rows: Scanline[], ctx: OffscreenCanvasRenderingContext2D): boolean {
    const lineH = Math.max(1, Math.ceil(this._lineSpacing * size))
    const h     = rows.length
    const pad   = this._maskBorderPad

    ctx.font = this._fontString(size)

    let startY = 0
    while (startY < h && !rows[startY]) startY++
    if (startY >= h) return true   // empty mask — trivially fits

    let endY = h - 1
    while (endY > startY && !rows[endY]) endY--
    const innerBottom = Math.max(startY, endY - pad)

    const queue = this._buildWordQueue()

    let y = startY + pad + size
    let qi = 0

    while (qi < queue.length && y < innerBottom) {
      const rowY     = Math.min(h - 1, Math.floor(y))
      const scanline = rows[rowY]
      if (!scanline || scanline.w <= pad * 2) { y += lineH; continue }

      const avail = scanline.w - pad * 2
      let line = ''
      while (qi < queue.length) {
        const word = queue[qi]!
        if (word === null) { qi++; break }
        const test = line ? `${line} ${word}` : word
        if (ctx.measureText(test).width <= avail) { line = test; qi++ }
        else { if (!line) qi++; break }   // force-place oversized single word
      }
      y += lineH
    }

    while (qi < queue.length && queue[qi] === null) qi++
    return qi >= queue.length
  }

  // ----------------------------------------------------------
  // Panel layout
  // ----------------------------------------------------------

  private get _ctrlY():         number  { return 50 + this.bounds.height + CTRL_GAP }
  private get _alignY():        number  { return this._ctrlY + CTRL_H + CTRL_GAP }
  private get _spacingY():      number  { return this._alignY + CTRL_H + CTRL_GAP }
  private get _hasMaskLayout(): boolean { return this._maskRows !== null || this._cachedMaskRows !== null }

  override get panelBottom(): number { return this._spacingY + CTRL_H + CTRL_GAP }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (!this._addMaskDone && this._onAddMask !== null) {
      const { x, y, w, h } = this._maskBtnRect()
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h) {
        this._addMaskDone = true
        this._onAddMask()
        return true
      }
    }
    if (!this._addPointDone && this._onAddPoint !== null) {
      const { x, y, w, h } = this._ptBtnRect()
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h) {
        this._addPointDone = true
        this._onAddPoint()
        return true
      }
    }

    // Transform handles take priority over pill controls
    const hp = this._handlePos()

    // Rotate handle — suspends rotationSlot binding (if any), then rotates
    // the text (and, when masked, re-derives the scanline wrap from the
    // counter-rotated mask).
    if (ptDist(point, hp.rotate) <= HANDLE_HIT) {
      if (this._rotationSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._rotationSlot)?.toggle()
      }
      this._rotSnapper.reset()
      this._drag = {
        type:       'rotate',
        center:     { ...hp.move },
        startAngle: Math.atan2(point.y - hp.move.y, point.x - hp.move.x),
        startRot:   this._rotation,
      }
      return true
    }

    // Scale handle — only when sizeSlot is unbound; adjusts the manual font size.
    // If the mask is currently auto-fitting, suspend it and seed from auto-fitted size.
    if (!this._sizeSlot.isActive && ptDist(point, hp.scale) <= HANDLE_HIT) {
      if (this._maskSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this._maskSlot)?.toggle()
        this._manualSize = Math.round(this._size)
      } else if (this._localMaskFittedSize !== null) {
        this._manualSize = Math.round(this._localMaskFittedSize)
        this._localMaskFittedSize = null  // user takes over from here
      }
      this._drag = {
        type:       'scale',
        center:     { ...hp.move },
        startDist:  Math.max(1, ptDist(point, hp.move)),
        startSize:  this._manualSize,
      }
      return true
    }

    // Move handle — only when positionSlot is unbound and no mask layout is active
    // (_maskRows set means text is flowing within the shape; move has no effect).
    if (!this._positionSlot.isActive && this._maskRows === null
        && ptDist(point, hp.move) <= HANDLE_HIT) {
      this._drag = {
        type:       'move',
        startMouse: { ...point },
        startPos:   { ...this._position },
      }
      return true
    }

    // Pill controls — checked after handles
    if (boundingBoxContains(this._editBtnBounds(), point)) {
      this.openEditDialog()
      return true
    }
    if (boundingBoxContains(this._ctrlPanelBounds(), point)) {
      if (boundingBoxContains(this._fontBtnBounds(), point)) {
        this.openFontPicker()
        return true
      }
      if (boundingBoxContains(this._boldBtnBounds(), point)) {
        this.toggleBold()
        return true
      }
      if (boundingBoxContains(this._italicBtnBounds(), point)) {
        this.toggleItalic()
        return true
      }
      if (boundingBoxContains(this._sizeMinusBounds(), point)) {
        this.adjustSize(-4)
        return true
      }
      if (boundingBoxContains(this._sizePlusBounds(), point)) {
        this.adjustSize(+4)
        return true
      }
      return false
    }

    if (boundingBoxContains(this._alignPillBounds(), point)) {
      if (boundingBoxContains(this._paraJustifyL(), point)) { this.setJustify('left');    return true }
      if (boundingBoxContains(this._paraJustifyC(), point)) { this.setJustify('center');  return true }
      if (boundingBoxContains(this._paraJustifyR(), point)) { this.setJustify('right');   return true }
      if (boundingBoxContains(this._paraJustifyJ(), point)) { this.setJustify('justify'); return true }
      if (this._hasMaskLayout) {
        if (boundingBoxContains(this._vJustifyT(), point)) { this.setVJustify('top');     return true }
        if (boundingBoxContains(this._vJustifyC(), point)) { this.setVJustify('center');  return true }
        if (boundingBoxContains(this._vJustifyB(), point)) { this.setVJustify('bottom');  return true }
        if (boundingBoxContains(this._vJustifyJ(), point)) { this.setVJustify('justify'); return true }
      }
      return false
    }

    if (boundingBoxContains(this._spacingPillBounds(), point)) {
      const divX = contentLeft(Node.canvasWidth) + 132
      if (point.x < divX) {
        this._lineSpacingSliderDrag = true
        this._setLineSpacingFromPointer(point.x)
      } else {
        this._borderPadSliderDrag = true
        this._setBorderPadFromPointer(point.x)
      }
      return true
    }

    return false
  }

  private _setLineSpacingFromPointer(px: number): void {
    if (this._lineSpacingSlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this._lineSpacingSlot)?.toggle()
    }
    const g      = this._lineSliderGeom()
    const thumbR = 5
    const lo     = g.sld0 + thumbR
    const hi     = Math.max(lo + 1, g.sldR - thumbR)
    const v      = Math.max(0, Math.min(1, (px - lo) / (hi - lo)))
    this._manualLineSpacing = -1 + v * 4
    Node.defaultLineSpacing = this._manualLineSpacing
    this.markDirty()
  }

  private _setBorderPadFromPointer(px: number): void {
    const g      = this._padSliderGeom()
    const thumbR = 5
    const lo     = g.sld0 + thumbR
    const hi     = Math.max(lo + 1, g.sldR - thumbR)
    const v      = Math.max(0, Math.min(1, (px - lo) / (hi - lo)))
    this._maskBorderPad = Math.round(v * BORDER_PAD_MAX)
    this.markDirty()
  }

  startCenterDrag(point: Point): boolean {
    if (this._maskSlot.isActive) return false
    if (this._positionSlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this._positionSlot)?.toggle()
    }
    this._drag = {
      type:       'move',
      startMouse: { ...point },
      startPos:   { ...this._position },
    }
    this.markDirty()
    return true
  }

  handlePointerMove(point: Point): void {
    if (this._lineSpacingSliderDrag) {
      this._setLineSpacingFromPointer(point.x)
      return
    }
    if (this._borderPadSliderDrag) {
      this._setBorderPadFromPointer(point.x)
      return
    }
    if (this._drag === null) return

    if (this._drag.type === 'move') {
      const rawPos = {
        x: this._drag.startPos.x + point.x - this._drag.startMouse.x,
        y: this._drag.startPos.y + point.y - this._drag.startMouse.y,
      }
      const edges = collectSnapEdges(this, 3)
      if (edges.xs.length > 0 || edges.ys.length > 0) {
        const snapped = snapPointToEdges(rawPos, edges, EDGE_SNAP_THRESHOLD,
          [-this._textHalfW, 0, this._textHalfW],
          [-this._textHalfH, 0, this._textHalfH],
        )
        this._manualPosition = { x: snapped.x, y: snapped.y }
        this._edgeSnapX = snapped.snapLineX; this._edgeSnapY = snapped.snapLineY
      } else {
        this._manualPosition = rawPos
        this._edgeSnapX = null; this._edgeSnapY = null
      }
    } else if (this._drag.type === 'scale') {
      const d = Math.max(1, ptDist(point, this._drag.center))
      const s = this._drag.startSize * (d / this._drag.startDist)
      this._manualSize = Math.max(MIN_SIZE, Math.min(MAX_SIZE, s))
    } else {
      // rotate
      const angle  = Math.atan2(point.y - this._drag.center.y, point.x - this._drag.center.x)
      const rawRot = this._drag.startRot + (angle - this._drag.startAngle)
      this._applySnapRotation(rawRot)
    }
    this.markDirty()
  }

  handlePointerUp(): void {
    this._lineSpacingSliderDrag = false
    this._borderPadSliderDrag   = false
    this._drag = null
    this._clearRotDwellTimer()
    this._edgeSnapX = null; this._edgeSnapY = null
  }

  private _applySnapRotation(raw: number): void {
    const result = this._rotSnapper.update(raw)
    this._rotation     = result.angle
    this._snapSnapped  = result.snapped
    this._snapProgress = result.progress
    if (result.snapped && this._rotDwellTimer === null) {
      this._rotDwellTimer = setInterval(() => {
        const r = this._rotSnapper.update(this._rotation)
        this._snapSnapped  = r.snapped
        this._snapProgress = r.progress
        this.markDirty()
        if (this._rotSnapper.isRefining) this._clearRotDwellTimer()
      }, 16)
    } else if (!result.snapped) {
      this._clearRotDwellTimer()
    }
  }

  private _clearRotDwellTimer(): void {
    if (this._rotDwellTimer !== null) {
      clearInterval(this._rotDwellTimer)
      this._rotDwellTimer = null
    }
    this._snapSnapped  = false
    this._snapProgress = 0
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    if (this._drag !== null) return this
    if (!this._addMaskDone && this._onAddMask !== null) {
      const { x, y, w, h } = this._maskBtnRect()
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h) return this
    }
    if (!this._addPointDone && this._onAddPoint !== null) {
      const { x, y, w, h } = this._ptBtnRect()
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h) return this
    }
    // Handles take priority over pill controls
    const hp = this._handlePos()
    if (ptDist(point, hp.rotate) <= HANDLE_HIT) return this
    if (!this._sizeSlot.isActive && ptDist(point, hp.scale) <= HANDLE_HIT) return this
    if (!this._positionSlot.isActive && this._maskRows === null
        && ptDist(point, hp.move) <= HANDLE_HIT) return this
    if (boundingBoxContains(this.canvasBounds, point)) return this
    if (boundingBoxContains(this._ctrlPanelBounds(), point)) return this
    if (boundingBoxContains(this._alignPillBounds(), point)) return this
    if (boundingBoxContains(this._spacingPillBounds(), point)) return this
    return null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    // Only draw the text's own drop shadow when this layer is the current
    // (selected) one — matching the depth-based shadow the Evaluator applies
    // to every layer's renderSelf.
    this._renderCanvas(ctx, Node.currentLayer === this)
  }

  renderPanel(ctx: Ctx2D): void {
    this._updateEditHover()
    this._renderPanelImpl(ctx)
    this._renderControls(ctx)
    this._renderAlignControls(ctx)
    this._renderSpacingControls(ctx)
  }

  // The _lineSpacingSlot is excluded from the standard slot group and rendered
  // inline inside the paragraph pill (via _slotBounds registration below).
  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const standard = this.slots.filter(s => s !== this._lineSpacingSlot)
    this.renderSlotGroup(ctx, standard, this.panelBottom)
    // Register the spacing pill as the drop-target for the line-spacing slot.
    const pb = this._spacingPillBounds()
    this._slotBounds.set(this._lineSpacingSlot, pb)
    // If a compatible drag is in progress, highlight the pill as a drop target.
    const drag = Node.bindDrag
    if (drag.active && drag.source !== null && drag.source.types.has(ValueType.Amount)) {
      ctx.save()
      ctx.strokeStyle = 'rgba(50,200,70,0.85)'
      ctx.lineWidth   = 1.5
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.roundRect(pb.x + 0.5, pb.y + 0.5, pb.width - 1, pb.height - 1, Math.min(pb.height / 2, 6))
      ctx.stroke()
      ctx.restore()
    }
  }

  override renderOverlay(ctx: Ctx2D): void {
    this._renderHandles(ctx)
    this._renderEditOverlay(ctx)
    drawSnapGuides(ctx, this._edgeSnapX, this._edgeSnapY, Node.canvasWidth, Node.canvasHeight)
    this._renderMaskBtn(ctx)
    this._renderPtBtn(ctx)
  }

  private _textBtnRect(which: 'mask' | 'point') {
    const POINT_W = 55, MASK_W = 60, BTN_H = 30, GAP = 14, SEP = 8
    const left = contentLeft(Node.canvasWidth)
    const y    = Node.viewportHeight - BTN_H - GAP
    const showP = !this._addPointDone && this._onAddPoint !== null
    const showM = !this._addMaskDone  && this._onAddMask  !== null
    if (showP && showM) {
      const total  = POINT_W + SEP + MASK_W
      const startX = left + Math.max(0, (Node.viewportWidth - left - total) / 2)
      return which === 'point'
        ? { x: startX,                 y, w: POINT_W, h: BTN_H }
        : { x: startX + POINT_W + SEP, y, w: MASK_W,  h: BTN_H }
    }
    const w = which === 'point' ? POINT_W : MASK_W
    return { x: left + Math.max(0, (Node.viewportWidth - left - w) / 2), y, w, h: BTN_H }
  }
  private _maskBtnRect()  { return this._textBtnRect('mask') }
  private _ptBtnRect()    { return this._textBtnRect('point') }

  private _renderConvBtn(ctx: Ctx2D, which: 'mask' | 'point'): void {
    const done     = which === 'mask' ? this._addMaskDone  : this._addPointDone
    const callback = which === 'mask' ? this._onAddMask    : this._onAddPoint
    if (done || callback === null) return
    const { x, y, w, h } = this._textBtnRect(which)
    const midY  = y + h / 2
    const col   = which === 'mask'  ? '#cfcf7ecc' : '#cf7ecfcc'
    const label = which === 'mask'  ? 'Mask'       : 'Point'
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 5); ctx.fill()
    ctx.fillStyle = col
    ctx.beginPath(); ctx.roundRect(x, y, 3, h, [5, 0, 0, 5]); ctx.fill()
    ctx.save()
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.font = '11px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText(label, x + 10, midY)
    ctx.restore()
    ctx.restore()
  }
  private _renderMaskBtn(ctx: Ctx2D)  { this._renderConvBtn(ctx, 'mask')  }
  private _renderPtBtn(ctx: Ctx2D)    { this._renderConvBtn(ctx, 'point') }

  // ── Main pill ─────────────────────────────────────────────────

  private _renderPanelImpl(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds
    if (width <= 0 || height <= 0) return
    const midY = y + height / 2

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // "T" glyph
    ctx.font = 'bold 13px monospace'
    ctx.fillStyle = ACCENT
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('T', x + 10, midY)

    // Text preview
    const editB  = this._editBtnBounds()
    const prevR  = editB.x - 8
    const prevL  = x + 26
    ctx.font      = '11px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.80)'
    ctx.fillText(this._truncate(ctx, `"${this._text}"`, prevR - prevL - 72), prevL, midY)

    // Slot indicators (right-to-left: rot, mask, sz, col, pos, α)
    const slots = [
      { slot: this._positionSlot, label: 'pos',  accent: ACCENT },
      { slot: this._colourSlot,   label: 'col',  accent: ACCENT },
      { slot: this._sizeSlot,     label: 'sz',   accent: ACCENT },
      { slot: this._maskSlot,     label: 'mask', accent: ACCENT },
      { slot: this._rotationSlot, label: 'rot',  accent: DIR_ACCENT },
      { slot: this._opacitySlot,  label: 'α',    accent: AM_COL },
    ]
    let dx = editB.x - 6
    ctx.font = '9px monospace'
    for (let i = slots.length - 1; i >= 0; i--) {
      const { slot, label, accent } = slots[i]!
      const active = slot.isActive
      ctx.fillStyle    = active ? accent : 'rgba(255,255,255,0.22)'
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(active ? '●' : '○', dx, midY)
      dx -= 12
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText(label, dx, midY)
      dx -= ctx.measureText(label).width + 6
    }

    this._drawBtn(ctx, editB, '✎', 'rgba(255,255,255,0.60)')

    ctx.restore()
  }

  // ── Font controls row ─────────────────────────────────────────

  private _renderControls(ctx: Ctx2D): void {
    const { x, y, w, h } = this._ctrlDims()
    if (w <= 0 || h <= 0) return
    const midY = y + h / 2

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, Math.min(h / 2, 6))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, h, [4, 0, 0, 4])
    ctx.fill()

    // Font picker button — shows current font name truncated to fit
    const fb = this._fontBtnBounds()
    ctx.fillStyle = 'rgba(255,255,255,0.10)'
    ctx.beginPath()
    ctx.roundRect(fb.x, fb.y, fb.width, fb.height, 3)
    ctx.fill()
    // Small dropdown chevron
    ctx.font      = '8px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.40)'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText('▾', fb.x + fb.width - 4, midY)
    // Font name in its own typeface (nice preview)
    ctx.save()
    ctx.font         = `11px "${this._fontFamily}",sans-serif`
    ctx.fillStyle    = 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      this._truncate(ctx, this._fontFamily, fb.width - 16),
      fb.x + 5, midY,
    )
    ctx.restore()

    // Bold / Italic toggles
    const bb = this._boldBtnBounds()
    const ib = this._italicBtnBounds()
    this._drawToggleBtn(ctx, bb, 'B', this._bold,   midY, 'bold 11px monospace')
    this._drawToggleBtn(ctx, ib, 'I', this._italic, midY, 'italic 11px monospace')

    // Thin divider
    const divX = ib.x + ib.width + 4
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(divX, y + 4)
    ctx.lineTo(divX, y + h - 4)
    ctx.stroke()

    // Size -/value/+
    const sm = this._sizeMinusBounds()
    const sp = this._sizePlusBounds()
    this._drawBtn(ctx, sm, '−', 'rgba(255,255,255,0.60)')
    this._drawBtn(ctx, sp, '+', 'rgba(255,255,255,0.60)')

    const szLabel = `${Math.round(this._size)}px`
    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(szLabel, sm.x + sm.width + (sp.x - sm.x - sm.width) / 2, midY)

    ctx.restore()
  }

  // ── Combined alignment pill (H-justify + V-justify) ──────────

  private _renderAlignControls(ctx: Ctx2D): void {
    const { x, y, width, height } = this._alignPillBounds()
    if (width <= 0 || height <= 0) return
    const midY      = y + height / 2
    const maskActive = this._hasMaskLayout

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 6))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // H-justify buttons (always active)
    type JBtn = { b: { x: number; y: number; width: number; height: number }; val: 'left' | 'center' | 'right' | 'justify' }
    const hBtns: JBtn[] = [
      { b: this._paraJustifyL(), val: 'left'    },
      { b: this._paraJustifyC(), val: 'center'  },
      { b: this._paraJustifyR(), val: 'right'   },
      { b: this._paraJustifyJ(), val: 'justify' },
    ]
    const hIconNames = ['text-align-left', 'text-align-center', 'text-align-right', 'text-align-justify'] as const
    for (let i = 0; i < 4; i++) {
      const { b, val } = hBtns[i]!
      const active = this._justify === val
      if (active) {
        ctx.fillStyle = ACCENT + '33'
        ctx.beginPath()
        ctx.roundRect(b.x, b.y, b.width, b.height, 3)
        ctx.fill()
      }
      ctx.fillStyle = active ? ACCENT : 'rgba(255,255,255,0.55)'
      drawIcon(ctx, hIconNames[i]!, b.x + b.width / 2, midY, 14)
    }

    // Divider between H and V
    const divX = x + 96
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(divX, y + 4)
    ctx.lineTo(divX, y + height - 4)
    ctx.stroke()

    // V-justify buttons (dimmed when no mask is active)
    type VBtn = { b: { x: number; y: number; width: number; height: number }; val: 'top' | 'center' | 'bottom' | 'justify' }
    const vBtns: VBtn[] = [
      { b: this._vJustifyT(), val: 'top'     },
      { b: this._vJustifyC(), val: 'center'  },
      { b: this._vJustifyB(), val: 'bottom'  },
      { b: this._vJustifyJ(), val: 'justify' },
    ]
    const vIconNames = ['text-valign-top', 'text-valign-center', 'text-valign-bottom', 'text-valign-justify'] as const
    for (let i = 0; i < 4; i++) {
      const { b, val } = vBtns[i]!
      const active = maskActive && this._vJustify === val
      if (active) {
        ctx.fillStyle = ACCENT + '33'
        ctx.beginPath()
        ctx.roundRect(b.x, b.y, b.width, b.height, 3)
        ctx.fill()
      }
      ctx.globalAlpha = maskActive ? 1.0 : 0.30
      ctx.fillStyle   = active ? ACCENT : 'rgba(255,255,255,0.55)'
      drawIcon(ctx, vIconNames[i]!, b.x + b.width / 2, midY, 14)
      ctx.globalAlpha = 1.0
    }

    ctx.restore()
  }

  // ── Spacing pill (line-spacing + border-pad) ──────────────────

  private _renderSpacingControls(ctx: Ctx2D): void {
    const { x, y, width, height } = this._spacingPillBounds()
    if (width <= 0 || height <= 0) return
    const midY  = y + height / 2
    const thumbR = 5

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 6))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // ── Line-spacing slider (left half) ─────────────────────────
    const lg      = this._lineSliderGeom()
    const lActive = this._lineSpacingSlot.isActive
    const lColour = lActive ? AM_COL : ACCENT
    const lv01    = Math.max(0, Math.min(1, (this._lineSpacing + 1) / 4))
    const lo_l    = lg.sld0 + thumbR
    const hi_l    = Math.max(lo_l + 1, lg.sldR - thumbR)
    const thumbX_l = lo_l + lv01 * (hi_l - lo_l)

    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.62)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('line', lg.labelX, midY)

    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth   = 3
    ctx.beginPath(); ctx.moveTo(lo_l, midY); ctx.lineTo(hi_l, midY); ctx.stroke()

    ctx.strokeStyle = lColour
    ctx.lineWidth   = 3
    ctx.beginPath(); ctx.moveTo(lo_l, midY); ctx.lineTo(thumbX_l, midY); ctx.stroke()

    ctx.fillStyle = lColour
    ctx.beginPath(); ctx.arc(thumbX_l, midY, thumbR, 0, Math.PI * 2); ctx.fill()

    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.textAlign = 'right'
    ctx.fillText(this._lineSpacing.toFixed(2), lg.valueRight, midY)

    ctx.font      = '9px monospace'
    ctx.fillStyle = lActive ? AM_COL : 'rgba(255,255,255,0.22)'
    ctx.textAlign = 'right'
    ctx.fillText(lActive ? '●' : '○', lg.indX, midY)

    // Divider between line spacing and border pad
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(x + 132, y + 4)
    ctx.lineTo(x + 132, y + height - 4)
    ctx.stroke()

    // ── Border-pad slider (right half) ──────────────────────────
    const pg    = this._padSliderGeom()
    const pv01  = Math.max(0, Math.min(1, this._maskBorderPad / BORDER_PAD_MAX))
    const lo_p  = pg.sld0 + thumbR
    const hi_p  = Math.max(lo_p + 1, pg.sldR - thumbR)
    const thumbX_p = lo_p + pv01 * (hi_p - lo_p)

    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.62)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('pad', pg.labelX, midY)

    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth   = 3
    ctx.beginPath(); ctx.moveTo(lo_p, midY); ctx.lineTo(hi_p, midY); ctx.stroke()

    ctx.strokeStyle = ACCENT
    ctx.lineWidth   = 3
    ctx.beginPath(); ctx.moveTo(lo_p, midY); ctx.lineTo(thumbX_p, midY); ctx.stroke()

    ctx.fillStyle = ACCENT
    ctx.beginPath(); ctx.arc(thumbX_p, midY, thumbR, 0, Math.PI * 2); ctx.fill()

    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.textAlign = 'right'
    ctx.fillText(`${this._maskBorderPad}`, pg.valueRight, midY)

    ctx.restore()
  }

  // ── Canvas rendering ─────────────────────────────────────────

  private _renderCanvas(ctx: Ctx2D, withShadow = true): void {
    if (!this._text) return
    const c = this._colour
    const css = `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${c.a.toFixed(2)})`

    ctx.save()
    ctx.globalAlpha  = Math.max(0, Math.min(1, this._opacity))
    ctx.font         = this._fontString()
    ctx.fillStyle    = css
    if (withShadow) {
      ctx.shadowColor   = 'rgba(0,0,0,0.70)'
      ctx.shadowBlur    = 6
      ctx.shadowOffsetX = 1
      ctx.shadowOffsetY = 1
    }

    if (this._maskRows !== null) {
      this._renderMasked(ctx)
    } else {
      this._renderUnmasked(ctx)
    }

    ctx.restore()
  }

  // Unmasked: word-wrap to fit the canvas width (the default boundary when
  // no mask is set), render lines anchored at _position, rotated about it.
  // For 'left'/'center'/'right', _position is the respective edge/centre anchor.
  // For 'justify', _position is the left edge; non-last-paragraph lines are
  // stretched to fill maxWidth by distributing space between words.
  private _renderUnmasked(ctx: Ctx2D): void {
    const { x: px, y: py } = this._position
    const lines    = this._wrapLines(ctx)
    const lineH    = Math.max(0, this._lineSpacing) * this._size
    const totalH   = (lines.length - 1) * lineH
    const maxWidth = Math.max(1, Node.canvasWidth - WRAP_PAD * 2)

    ctx.save()
    ctx.translate(px, py)
    ctx.rotate(this._rotation)
    ctx.textBaseline = 'middle'

    if (this._justify === 'justify') {
      ctx.textAlign = 'left'
      let y = -totalH / 2
      for (const line of lines) {
        if (line.isParaEnd) {
          ctx.fillText(line.text, 0, y)
        } else {
          _fillJustified(ctx, line.text, 0, y, maxWidth)
        }
        y += lineH
      }
    } else {
      ctx.textAlign = this._justify
      let y = -totalH / 2
      for (const line of lines) {
        ctx.fillText(line.text, 0, y)
        y += lineH
      }
    }
    ctx.restore()
  }

  // Word-wrap _text to fit within the canvas width (minus WRAP_PAD on each
  // side), preserving '\n' as hard breaks. Each returned line carries the
  // index into _text where its text begins, so the cursor (an index into
  // _text) can be mapped back to a wrapped line + column for rendering.
  // isParaEnd marks the last wrapped line of each paragraph — used by full
  // justification to leave the final line ragged rather than stretched.
  private _wrapLines(ctx: Ctx2D): { text: string; start: number; isParaEnd: boolean }[] {
    const maxWidth = Math.max(1, Node.canvasWidth - WRAP_PAD * 2)
    const lines: { text: string; start: number; isParaEnd: boolean }[] = []

    let paraOffset = 0
    for (const para of this._text.split('\n')) {
      const tokens = para.split(/(\s+)/).filter(t => t.length > 0)

      let line = ''
      let lineStart = paraOffset
      let consumed  = 0
      let pendingWs = ''

      for (const tok of tokens) {
        if (/^\s+$/.test(tok)) { pendingWs += tok; consumed += tok.length; continue }

        if (line.length > 0 && ctx.measureText(line + pendingWs + tok).width > maxWidth) {
          lines.push({ text: line, start: lineStart, isParaEnd: false })
          line      = tok
          lineStart = paraOffset + consumed
        } else {
          line = line.length > 0 ? line + pendingWs + tok : pendingWs + tok
        }
        consumed += tok.length
        pendingWs = ''
      }
      lines.push({ text: line, start: lineStart, isParaEnd: true })

      paraOffset += para.length + 1   // +1 for the '\n'
    }
    return lines
  }

  // Compute the tight bounding box of the actual text lines placed within the mask
  // (unrotated frame — same coordinate space as _maskBBox / _maskRows).
  // Mirrors _renderMasked's layout without drawing; uses _maskCanvas context
  // for measureText (font has been set by the just-completed _updateMaskCanvas call).
  private _computeTextBBoxInMask(): typeof this._maskBBox {
    const rows    = this._maskRows!
    const lineH   = Math.max(1, Math.ceil(this._lineSpacing * this._size))
    const h       = rows.length
    const pad     = this._maskBorderPad

    let startY = 0
    while (startY < h && !rows[startY]) startY++
    if (startY >= h) return null

    let endY = h - 1
    while (endY > startY && !rows[endY]) endY--

    const innerTop    = startY + pad
    const innerBottom = Math.max(innerTop, endY - pad)

    const ctx = this._maskCanvas.getContext('2d')!
    ctx.font = this._fontString()

    let y0 = innerTop + this._size
    let effectiveLineH = lineH

    if (this._vJustify !== 'top') {
      const count = this._countMaskedLines(rows, y0, lineH, ctx, innerBottom)
      if (count > 0) {
        const textSpan  = (count - 1) * lineH
        const available = innerBottom - y0
        if      (this._vJustify === 'center') y0 += Math.max(0, (available - textSpan) / 2)
        else if (this._vJustify === 'bottom') y0 += Math.max(0, available - textSpan)
        else if (this._vJustify === 'justify' && count > 1)
          effectiveLineH = Math.max(lineH, available / (count - 1))
      }
    }

    const queue = this._buildWordQueue()
    let y = y0, qi = 0
    let firstBaseline: number | null = null, lastBaseline = y0
    let minX = Infinity, maxX = -Infinity

    while (qi < queue.length && y < innerBottom) {
      const rowY = Math.min(h - 1, Math.floor(y))
      const sl   = rows[rowY]
      if (!sl || sl.w <= pad * 2) { y += effectiveLineH; continue }

      const xStart = sl.x + pad, xEnd = sl.x + sl.w - pad, avail = sl.w - pad * 2

      let line = ''
      while (qi < queue.length) {
        const word = queue[qi]!
        if (word === null) { qi++; break }
        const test = line ? `${line} ${word}` : word
        if (ctx.measureText(test).width <= avail) { line = test; qi++ }
        else { if (!line) qi++; break }
      }

      if (line) {
        if (firstBaseline === null) firstBaseline = y
        lastBaseline = y
        const lineW      = ctx.measureText(line).width
        const isParaEnd  = qi >= queue.length || queue[qi] === null
        let lx: number, rx: number
        if (this._justify === 'center') {
          lx = (xStart + xEnd) / 2 - lineW / 2;  rx = lx + lineW
        } else if (this._justify === 'right') {
          rx = xEnd;  lx = rx - lineW
        } else if (this._justify === 'justify' && !isParaEnd) {
          lx = xStart;  rx = xEnd        // full-justify spans the whole scanline
        } else {
          lx = xStart;  rx = lx + lineW
        }
        if (lx < minX) minX = lx
        if (rx > maxX) maxX = rx
      }
      y += effectiveLineH
    }

    if (firstBaseline === null) return null
    return {
      minX,
      maxX,
      minY: Math.round(firstBaseline  - this._size * 0.80),  // approx cap-height top
      maxY: Math.round(lastBaseline   + this._size * 0.25),  // approx descender bottom
    }
  }

  // Build the flat word queue used by masked layout; null marks a paragraph break.
  private _buildWordQueue(): (string | null)[] {
    const queue: (string | null)[] = []
    for (const para of this._text.split('\n')) {
      for (const w of para.split(/\s+/).filter(Boolean)) queue.push(w)
      queue.push(null)
    }
    return queue
  }

  // Dry-run of the masked greedy word-wrap starting at baseline y0 with the
  // given lineH.  Returns the number of visual lines placed (for vertical
  // alignment offset and vertical-justify line-spacing computation).
  private _countMaskedLines(rows: Scanline[], y0: number, lineH: number, ctx: Ctx2D, innerBottom: number): number {
    const h = rows.length, pad = this._maskBorderPad
    const queue = this._buildWordQueue()
    let y = y0, qi = 0, count = 0
    while (qi < queue.length && y < innerBottom) {
      const rowY = Math.min(h - 1, Math.floor(y))
      const sl   = rows[rowY]
      if (!sl || sl.w <= pad * 2) { y += lineH; continue }
      const avail = sl.w - pad * 2
      let line = ''
      while (qi < queue.length) {
        const word = queue[qi]!
        if (word === null) { qi++; break }
        const test = line ? `${line} ${word}` : word
        if (ctx.measureText(test).width <= avail) { line = test; qi++ }
        else { if (!line) qi++; break }
      }
      if (line) count++
      y += lineH
    }
    return count
  }

  // Masked: flow text into the mask shape using per-scanline word-wrap.
  //
  // _maskRows were sampled from the mask counter-rotated by -_rotation about
  // the canvas centre (see _sampleMask). Rendering at those row coordinates
  // under a forward rotation by _rotation (about the same centre) places the
  // wrapped text back inside the true mask outline, rotated as a whole.
  //
  // _vJustify controls vertical placement:
  //   'top'     — baseline of first line just inside the top of the mask (current default)
  //   'center'  — text block centred in the mask's vertical extent
  //   'bottom'  — last line's baseline near the bottom of the mask
  //   'justify' — line spacing adjusted so first→last baseline span fills the mask height
  private _renderMasked(ctx: Ctx2D): void {
    const rows  = this._maskRows!
    const lineH = Math.max(1, Math.ceil(this._lineSpacing * this._size))
    const h     = rows.length
    const pad   = this._maskBorderPad

    let startY = 0
    while (startY < h && !rows[startY]) startY++
    if (startY >= h) return

    let endY = h - 1
    while (endY > startY && !rows[endY]) endY--

    const innerTop    = startY + pad
    const innerBottom = Math.max(innerTop, endY - pad)

    // First baseline (top-aligned origin, inset by pad from the mask edge)
    let y0 = innerTop + this._size
    let effectiveLineH = lineH

    if (this._vJustify !== 'top') {
      const count = this._countMaskedLines(rows, y0, lineH, ctx, innerBottom)
      if (count > 0) {
        const textSpan  = (count - 1) * lineH   // first → last baseline distance
        const available = innerBottom - y0       // padded space below first baseline
        if (this._vJustify === 'center') {
          y0 += Math.max(0, (available - textSpan) / 2)
        } else if (this._vJustify === 'bottom') {
          y0 += Math.max(0, available - textSpan)
        } else if (this._vJustify === 'justify' && count > 1) {
          effectiveLineH = Math.max(lineH, available / (count - 1))
        }
      }
    }

    ctx.save()
    if (this._rotation !== 0) {
      const cx = Node.canvasWidth / 2, cy = Node.canvasHeight / 2
      ctx.translate(cx, cy)
      ctx.rotate(this._rotation)
      ctx.translate(-cx, -cy)
    }

    ctx.textAlign    = this._justify === 'justify' ? 'left' : this._justify
    ctx.textBaseline = 'alphabetic'

    const queue = this._buildWordQueue()
    let y = y0, qi = 0

    while (qi < queue.length && y < innerBottom) {
      const rowY     = Math.min(h - 1, Math.floor(y))
      const scanline = rows[rowY]

      if (!scanline || scanline.w <= pad * 2) { y += effectiveLineH; continue }

      const xStart = scanline.x + pad
      const xEnd   = scanline.x + scanline.w - pad
      const avail  = scanline.w - pad * 2

      let line = ''
      while (qi < queue.length) {
        const word = queue[qi]!
        if (word === null) { qi++; break }
        const test = line ? `${line} ${word}` : word
        if (ctx.measureText(test).width <= avail) { line = test; qi++ }
        else { if (!line) qi++; break }
      }

      if (line) {
        if (this._justify === 'justify') {
          const isParaEnd = qi >= queue.length || queue[qi] === null
          if (isParaEnd) ctx.fillText(line, xStart, y)
          else _fillJustified(ctx, line, xStart, y, avail)
        } else {
          const xDraw = this._justify === 'center' ? (xStart + xEnd) / 2
                      : this._justify === 'right'  ? xEnd
                      :                              xStart
          ctx.fillText(line, xDraw, y)
        }
      }
      y += effectiveLineH
    }

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Geometry helpers
  // ----------------------------------------------------------

  private _ctrlDims() {
    return { x: contentLeft(Node.canvasWidth), y: this._ctrlY, w: panelWidth(Node.canvasWidth), h: CTRL_H }
  }

  private _ctrlPanelBounds() {
    const { x, y, w, h } = this._ctrlDims()
    return { x, y, width: w, height: h }
  }

  private _editBtnBounds() {
    const { x, y, width, height } = this.canvasBounds
    return { x: x + width - BTN_M - BTN, y: y + (height - BTN) / 2, width: BTN, height: BTN }
  }

  // Controls row sub-bounds (all centred vertically in the row).
  private _ctrlBtn(offsetX: number, w: number) {
    const y   = this._ctrlY
    const bh  = CTRL_H - 8
    return { x: contentLeft(Node.canvasWidth) + offsetX, y: y + 4, width: w, height: bh }
  }

  //  6          84        108       130  (divider)  134       162      192
  //  [font name ▾ ]  [B]   [I]       |  [−]  size  [+]
  private _fontBtnBounds()   { return this._ctrlBtn(6,   84) }
  private _boldBtnBounds()   { return this._ctrlBtn(94,  20) }
  private _italicBtnBounds() { return this._ctrlBtn(118, 20) }
  private _sizeMinusBounds() { return this._ctrlBtn(146, 20) }
  private _sizePlusBounds()  { return this._ctrlBtn(192, 20) }

  // Alignment pill helpers — H+V justify buttons in one row.
  //  H:  8 [L]  30 [C]  52 [R]  74 [J]  | 96 divider |  V: 100 [T]  122 [C]  144 [B]  166 [J]
  private _alignBtn(offsetX: number, w: number) {
    const bh = CTRL_H - 8
    return { x: contentLeft(Node.canvasWidth) + offsetX, y: this._alignY + 4, width: w, height: bh }
  }
  private _paraJustifyL()  { return this._alignBtn(8,   20) }
  private _paraJustifyC()  { return this._alignBtn(30,  20) }
  private _paraJustifyR()  { return this._alignBtn(52,  20) }
  private _paraJustifyJ()  { return this._alignBtn(74,  20) }
  private _vJustifyT()     { return this._alignBtn(100, 20) }
  private _vJustifyC()     { return this._alignBtn(122, 20) }
  private _vJustifyB()     { return this._alignBtn(144, 20) }
  private _vJustifyJ()     { return this._alignBtn(166, 20) }
  private _alignPillBounds() {
    return { x: contentLeft(Node.canvasWidth), y: this._alignY,
             width: panelWidth(Node.canvasWidth), height: CTRL_H }
  }

  // Spacing pill helpers — line-spacing slider (left) + border-pad slider (right).
  //  "line" sld0..sldR [●] value [○] | 132 divider | "pad" sld0..sldR [●] value
  private _spacingPillBounds() {
    return { x: contentLeft(Node.canvasWidth), y: this._spacingY,
             width: panelWidth(Node.canvasWidth), height: CTRL_H }
  }
  private _lineSliderGeom() {
    const x = contentLeft(Node.canvasWidth)
    return {
      midY:       this._spacingY + CTRL_H / 2,
      labelX:     x + 6,
      sld0:       x + 36,
      sldR:       x + 100,
      valueRight: x + 126,
      indX:       x + 130,
    }
  }
  private _padSliderGeom() {
    const x = contentLeft(Node.canvasWidth)
    return {
      midY:       this._spacingY + CTRL_H / 2,
      labelX:     x + 136,
      sld0:       x + 160,
      sldR:       x + 228,
      valueRight: x + 252,
    }
  }

  // ----------------------------------------------------------
  // Transform handles
  // ----------------------------------------------------------

  // When masked, handles pivot about the canvas centre — the same point
  // _sampleMask/_renderMasked rotate about. Unmasked, they pivot about
  // _position (which manual move can reposition).
  private _handlePos() {
    const masked = this._maskRows !== null
    const center = masked
      ? { x: Node.canvasWidth / 2, y: Node.canvasHeight / 2 }
      : this._position
    const cos = Math.cos(this._rotation)
    const sin = Math.sin(this._rotation)
    const so  = this._size * SCALE_OFFSET_FACTOR

    // Move handle: when masked, shows the alignment anchor (h-justify × v-justify
    // corner/edge/centre of the mask bounding box), rotated into canvas space.
    let move: Point
    if (masked && this._textContentBBox !== null) {
      const bb  = this._textContentBBox
      const ax  = this._justify === 'left'   ? bb.minX
                : this._justify === 'right'  ? bb.maxX
                : (bb.minX + bb.maxX) / 2          // centre or full-justify
      const ay  = this._vJustify === 'top'    ? bb.minY
                : this._vJustify === 'bottom' ? bb.maxY
                : (bb.minY + bb.maxY) / 2          // centre or full-justify
      if (this._rotation !== 0) {
        const cx = Node.canvasWidth / 2, cy = Node.canvasHeight / 2
        const dx = ax - cx, dy = ay - cy
        move = { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
      } else {
        move = { x: ax, y: ay }
      }
    } else {
      move = { x: this._position.x, y: this._position.y }
    }

    return {
      center,
      move,
      // Scale and rotate handles are always relative to `move` (the alignment
      // anchor when masked, equal to _position when unmasked).
      scale: {
        x: move.x + so * cos - so * sin,
        y: move.y + so * sin + so * cos,
      },
      rotate: {
        x: move.x + ROT_ARM * sin,
        y: move.y - ROT_ARM * cos,
      },
    }
  }

  private _renderHandles(ctx: Ctx2D): void {
    const hp     = this._handlePos()
    const masked = this._maskRows !== null

    ctx.save()
    ctx.setLineDash([])

    // Dashed arm lines
    ctx.strokeStyle = 'rgba(255,255,255,0.38)'
    ctx.lineWidth   = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(hp.move.x, hp.move.y)
    ctx.lineTo(hp.rotate.x, hp.rotate.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(hp.move.x, hp.move.y)
    ctx.lineTo(hp.scale.x, hp.scale.y)
    ctx.stroke()
    ctx.setLineDash([])

    // Scale handle — square, cyan glow (dimmed when size is auto-controlled).
    // Scaling adjusts the manual font size directly.
    const sizeAutoControlled = this._sizeSlot.isActive || this._maskSlot.isActive
    this._drawGlowSquare(ctx, hp.scale, HANDLE_SZ,
      sizeAutoControlled ? '#666688' : '#81d4fa')

    // Rotate handle — orange normally; cyan when snapping; dimmed when slot bound
    const rotCol = this._rotationSlot.isActive ? '#666688'
                 : this._snapSnapped           ? ROT_SNAP_COL
                 : '#ffb74d'
    this._drawGlowCircle(ctx, hp.rotate, HANDLE_R, rotCol)
    if (this._snapSnapped && this._snapProgress > 0) {
      const arcR  = HANDLE_R + 5
      const start = -Math.PI / 2
      const end   = start + this._snapProgress * 2 * Math.PI
      ctx.save()
      ctx.strokeStyle = ROT_SNAP_COL
      ctx.lineWidth   = 2
      ctx.globalAlpha = 0.85
      ctx.beginPath()
      ctx.arc(hp.rotate.x, hp.rotate.y, arcR, start, end)
      ctx.stroke()
      ctx.restore()
    }

    if (!masked) {
      // Draggable move handle — circle + crosshair
      this._drawGlowCircle(ctx, hp.move, HANDLE_R,
        this._positionSlot.isActive ? '#666688' : '#ffffff')
      const cr = HANDLE_R - 2
      ctx.strokeStyle = 'rgba(0,0,0,0.80)'
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.moveTo(hp.move.x - cr, hp.move.y)
      ctx.lineTo(hp.move.x + cr, hp.move.y)
      ctx.moveTo(hp.move.x, hp.move.y - cr)
      ctx.lineTo(hp.move.x, hp.move.y + cr)
      ctx.stroke()
    } else if (this._textContentBBox !== null) {
      // Alignment anchor indicator — crosshair only (not draggable)
      const cr = HANDLE_R + 2
      ctx.save()
      ctx.strokeStyle = ACCENT
      ctx.lineWidth   = 1.5
      ctx.globalAlpha = 0.70
      ctx.beginPath()
      ctx.moveTo(hp.move.x - cr, hp.move.y)
      ctx.lineTo(hp.move.x + cr, hp.move.y)
      ctx.moveTo(hp.move.x, hp.move.y - cr)
      ctx.lineTo(hp.move.x, hp.move.y + cr)
      ctx.stroke()
      ctx.restore()
    }

    ctx.restore()
  }

  // Green edit-region boundary + blinking cursor triangle, shown while
  // isTextEditActive() (hover or OS text-drag).
  private _renderEditOverlay(ctx: Ctx2D): void {
    if (!this.isTextEditActive()) return
    const hp = this._handlePos()

    ctx.save()
    ctx.strokeStyle = 'rgba(120,255,120,0.85)'
    ctx.lineWidth   = 2
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.arc(hp.move.x, hp.move.y, EDIT_REGION_R, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()

    // Cursor is only positionable for unmasked (centred-line) layout.
    if (this._maskRows === null) {
      const pos = this._cursorWorldPos(ctx)
      if (pos !== null) this._drawCursorTriangle(ctx, pos)
    }
  }

  // World-space position of the cursor, just below the text baseline of the
  // line it sits on — used to draw the triangle cursor.
  private _cursorWorldPos(ctx: Ctx2D): Point | null {
    if (!this._text) return null

    ctx.save()
    ctx.font = this._fontString()
    const lines = this._wrapLines(ctx)

    // Find the wrapped line containing the cursor: the last line whose
    // start is <= _cursorPos (starts are non-decreasing across the text).
    let line = 0
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (l !== undefined && l.start <= this._cursorPos) line = i
      else break
    }
    const lineRec = lines[line] ?? { text: '', start: 0 }
    const col = Math.min(Math.max(this._cursorPos - lineRec.start, 0), lineRec.text.length)

    const lineH  = Math.max(0, this._lineSpacing) * this._size
    const totalH = (lines.length - 1) * lineH

    const lineWidth = ctx.measureText(lineRec.text).width
    const prefixW   = ctx.measureText(lineRec.text.slice(0, col)).width
    ctx.restore()

    // Local frame: origin at _position, x to the right, y down, before
    // rotation — matches the translate/rotate setup in _renderUnmasked.
    const lineOffsetX = this._justify === 'center' ? -lineWidth / 2 :
                        this._justify === 'right'  ? -lineWidth : 0
    const localX = lineOffsetX + prefixW
    const localY = -totalH / 2 + line * lineH + this._size * 0.3 + CURSOR_GAP

    const cos = Math.cos(this._rotation), sin = Math.sin(this._rotation)
    return {
      x: this._position.x + localX * cos - localY * sin,
      y: this._position.y + localX * sin + localY * cos,
    }
  }

  // A small triangle pointing up at the baseline from below.
  private _drawCursorTriangle(ctx: Ctx2D, pos: Point): void {
    ctx.save()
    ctx.fillStyle = 'rgba(120,255,120,0.95)'
    ctx.beginPath()
    ctx.moveTo(pos.x, pos.y)
    ctx.lineTo(pos.x - CURSOR_W, pos.y + CURSOR_H)
    ctx.lineTo(pos.x + CURSOR_W, pos.y + CURSOR_H)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  private _drawGlowCircle(ctx: Ctx2D, pt: Point, r: number, glowColour: string): void {
    ctx.save()
    ctx.shadowColor = glowColour
    ctx.shadowBlur  = 14
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,255,255,0.95)'
    ctx.fill()
    ctx.restore()
    // Dark outline drawn without shadow
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(0,0,0,0.65)'
    ctx.lineWidth   = 1.5
    ctx.stroke()
  }

  private _drawGlowSquare(ctx: Ctx2D, pt: Point, s: number, glowColour: string): void {
    ctx.save()
    ctx.shadowColor = glowColour
    ctx.shadowBlur  = 14
    ctx.fillStyle   = 'rgba(255,255,255,0.95)'
    ctx.fillRect(pt.x - s, pt.y - s, s * 2, s * 2)
    ctx.restore()
    ctx.strokeStyle = 'rgba(0,0,0,0.65)'
    ctx.lineWidth   = 1.5
    ctx.strokeRect(pt.x - s, pt.y - s, s * 2, s * 2)
  }

  // ----------------------------------------------------------
  // Drawing helpers
  // ----------------------------------------------------------

  private _fontString(size?: number): string {
    const parts = []
    if (this._italic) parts.push('italic')
    if (this._bold)   parts.push('bold')
    parts.push(`${Math.round(size ?? this._size)}px`, this._fontFamily)
    return parts.join(' ')
  }

  // Pick a random on-canvas position for a newly-created layer's single-line
  // text, keeping the whole rendered line within the canvas — mirrors
  // rndShape's random placement for Ellipse/Rect/Path layers.
  private _randomPosition(): Point {
    const lineH = Math.ceil(this._size * 1.35)
    let textWidth = 0
    const ctx = this._imageCanvas.getContext('2d')
    if (ctx) {
      ctx.font  = this._fontString()
      textWidth = ctx.measureText(this._text).width
    }
    const vw    = Node.viewportWidth
    const vh    = Node.viewportHeight
    const halfW = Math.min(textWidth / 2, vw / 2)
    const halfH = Math.min(lineH / 2,     vh / 2)
    return {
      x: halfW + Math.random() * Math.max(0, vw - 2 * halfW),
      y: halfH + Math.random() * Math.max(0, vh - 2 * halfH),
    }
  }

  private _drawBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    colour: string,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 3)
    ctx.fill()
    ctx.font         = '12px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }

  private _drawToggleBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    active: boolean,
    midY: number,
    font: string,
  ): void {
    ctx.fillStyle = active ? 'rgba(200,200,232,0.22)' : 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 3)
    ctx.fill()
    if (active) {
      ctx.strokeStyle = 'rgba(200,200,232,0.45)'
      ctx.lineWidth   = 1
      ctx.stroke()
    }
    ctx.font         = font
    ctx.fillStyle    = active ? ACCENT : 'rgba(255,255,255,0.55)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, midY)
  }

  private _truncate(ctx: Ctx2D, str: string, maxWidth: number): string {
    if (maxWidth <= 0) return ''
    if (ctx.measureText(str).width <= maxWidth) return str
    let lo = 0, hi = str.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (ctx.measureText(str.slice(0, mid) + '…').width <= maxWidth) lo = mid
      else hi = mid - 1
    }
    return str.slice(0, lo) + '…'
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

// Stretch `text` to fill `width` by distributing extra space between words.
// Falls back to left-aligned fillText when there is only one word.
type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
function _fillJustified(ctx: AnyCtx, text: string, x: number, y: number, width: number): void {
  const words = text.split(' ')
  if (words.length <= 1) {
    ctx.fillText(text, x, y)
    return
  }
  const wordWidths = words.map(w => ctx.measureText(w).width)
  const totalWordWidth = wordWidths.reduce((s, w) => s + w, 0)
  const gap = (width - totalWordWidth) / (words.length - 1)
  let xPos = x
  for (let i = 0; i < words.length; i++) {
    ctx.fillText(words[i]!, xPos, y)
    xPos += wordWidths[i]! + gap
  }
}

function makeDialogBtn(label: string, bg: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.textContent = label
  btn.style.cssText =
    `padding:6px 14px;border-radius:5px;border:none;cursor:pointer;` +
    `background:${bg};color:#e0e0e0;font:11px monospace;`
  return btn
}

// Load all Google Fonts from the FONTS list in a single stylesheet request.
// Called once (idempotent); fires-and-forgets the network fetch.
let _googleFontsInjected = false
function loadGoogleFonts(): void {
  if (_googleFontsInjected) return
  _googleFontsInjected = true
  const families = FONTS
    .filter(f => f.google)
    .map(f => `family=${encodeURIComponent(f.name)}`)
    .join('&')
  const link = document.createElement('link')
  link.rel  = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`
  document.head.appendChild(link)
}
