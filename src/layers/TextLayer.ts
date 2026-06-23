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
import { contentLeft, panelWidth } from '../interaction/layout.js'

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
  private _fontFamily: string = 'sans-serif'
  private _bold:       boolean    = false
  private _italic:     boolean    = false
  private _manualSize: number     = DEFAULT_SIZE

  // Resolved values (overwritten each recompute)
  private _position: Point  = { x: 400, y: 300 }
  private _colour:   Colour = DEFAULT_COLOUR
  private _size:     number = DEFAULT_SIZE

  // Scanline data sampled from the mask (null = no mask / not yet sampled)
  private _maskRows: Scanline[] | null = null

  // White-on-transparent silhouette of the rendered text, rebuilt every
  // recompute() — used as this layer's own MaskSource output (getMask()),
  // so a TextLayer can be dropped onto a MaskLayer shape slot.
  private _maskCanvas: OffscreenCanvas

  // The rendered text at its actual colour/typography, rebuilt every
  // recompute() — used as this layer's own ImageSource output (getImage()),
  // so a TextLayer can be dropped onto a Filter/Composite image slot.
  private _imageCanvas: OffscreenCanvas

  // Direct-manipulation state (persist across recompute when slots unbound)
  private _rotation:       number       = 0
  private _manualPosition: Point | null = null
  private _drag:           DragState | null = null

  private readonly _rotSnapper = new AngleSnapper(ROT_SNAP_ANGLES, ROT_SNAP_THRESHOLD, ROT_SNAP_DWELL_MS)
  private _snapSnapped  = false
  private _snapProgress = 0
  private _rotDwellTimer: ReturnType<typeof setInterval> | null = null

  // Opacity — computed each recompute from slot; 1.0 when unbound
  private _opacity = 1.0

  // Direct in-place text editing — ephemeral UI state, not persisted.
  private _cursorPos:        number  = 0
  private _hoverActive:      boolean = false   // mouse hovering the edit region
  private _dragHoverActive:  boolean = false   // OS text drag hovering this layer
  private _isDefaultText:    boolean = true    // true until the user provides real content

  constructor(text?: string) {
    super()
    this._maskCanvas   = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)
    this._imageCanvas  = new OffscreenCanvas(Node.canvasWidth, Node.canvasHeight)
    this._isDefaultText = text === undefined
    this._text         = text ?? randomDefaultText()
    this._cursorPos    = this._text.length
    this._manualPosition = this._randomPosition()
    this._positionSlot = new ParameterSlot(ValueType.Point,     this)
    this._colourSlot   = new ParameterSlot(ValueType.Colour,    this)
    this._sizeSlot     = new ParameterSlot(ValueType.Amount,    this)
    this._maskSlot     = new ParameterSlot(ValueType.Mask,      this, 'mask')
    this._rotationSlot = new ParameterSlot(ValueType.Direction, this, 'rotation')
    this._opacitySlot  = new ParameterSlot(ValueType.Amount,    this, 'opacity')
    this.slots.push(this._positionSlot, this._colourSlot, this._sizeSlot, this._maskSlot, this._rotationSlot, this._opacitySlot)
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

  // Seed a newly-created layer (via slot-click-to-create) with the value
  // currently shown by the corresponding manual control, so the binding
  // starts as a no-op.
  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | null {
    if (slot === this._positionSlot) return this._manualPosition ?? this._position
    if (slot === this._sizeSlot) {
      const size = this._manualSize
      return Math.max(0, Math.min(1, (size - MIN_SIZE) / (MAX_SIZE - MIN_SIZE)))
    }
    if (slot === this._rotationSlot) return { angle: this._rotation, magnitude: 1 }
    if (slot === this._opacitySlot)  return this._opacity
    return null
  }

  // ----------------------------------------------------------
  // MaskSource
  // ----------------------------------------------------------

  getMask(): MaskValue { return this._maskCanvas }

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
    this._insertText(text)
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
      text:           this._text,
      isDefaultText:  this._isDefaultText,
      fontFamily:     this._fontFamily,
      bold:           this._bold,
      italic:         this._italic,
      manualSize:     this._manualSize,
      manualPosition: this._manualPosition,
      rotation:       this._rotation,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.text === 'string')       this._text       = state.text
    if (typeof state.fontFamily === 'string') this._fontFamily = state.fontFamily
    if (typeof state.bold === 'boolean')      this._bold       = state.bold
    if (typeof state.italic === 'boolean')    this._italic     = state.italic
    if (typeof state.manualSize === 'number') this._manualSize = state.manualSize
    if (typeof state.rotation === 'number')   this._rotation   = state.rotation
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
  }

  protected recompute(): void {
    this._opacity = this._opacitySlot.isActive
      ? (this._opacitySlot.source as AmountSource).getAmount() as Amount
      : 1.0

    this._position = this._positionSlot.isActive
      ? (this._positionSlot.source as PointSource).getPoint()
      : (this._manualPosition ?? { x: Node.canvasWidth / 2, y: Node.canvasHeight / 2 })

    this._colour = this._colourSlot.isActive
      ? (this._colourSlot.source as ColourSource).getColour()
      : DEFAULT_COLOUR

    if (this._sizeSlot.isActive) {
      const t = (this._sizeSlot.source as AmountSource).getAmount() as Amount
      this._size = MIN_SIZE + t * (MAX_SIZE - MIN_SIZE)
    } else {
      this._size = this._manualSize
    }

    if (this._rotationSlot.isActive) {
      this._rotation = (this._rotationSlot.source as DirectionSource).getDirection().angle
    }

    if (this._maskSlot.isActive) {
      const mask = (this._maskSlot.source as MaskSource).getMask()
      if (mask !== null) {
        this._sampleMask(mask as OffscreenCanvas)
      } else {
        this._maskRows = null
      }
    } else {
      this._maskRows = null
    }

    this._updateMaskCanvas()
    this._updateImageCanvas()
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
    // Copy mask to a temp canvas to avoid touching its rendering context state.
    const tmp  = new OffscreenCanvas(w, h)
    const tctx = tmp.getContext('2d')!
    if (this._rotation !== 0) {
      tctx.translate(w / 2, h / 2)
      tctx.rotate(-this._rotation)
      tctx.translate(-w / 2, -h / 2)
    }
    tctx.drawImage(mask as CanvasImageSource, 0, 0)
    const { data } = tctx.getImageData(0, 0, w, h)
    this._maskRows = Array.from({ length: h }, (_, y) => {
      let minX = w, maxX = -1
      const base = y * w * 4
      for (let x = 0; x < w; x++) {
        if ((data[base + x * 4 + 3] ?? 0) > 128) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
        }
      }
      return maxX >= 0 ? { x: minX, w: maxX - minX + 1 } : null
    })
  }

  // ----------------------------------------------------------
  // Panel layout
  // ----------------------------------------------------------

  private get _ctrlY(): number { return 50 + this.bounds.height + CTRL_GAP }

  override get panelBottom(): number {
    return this._ctrlY + CTRL_H + CTRL_GAP
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    // Edit button (in main pill)
    if (boundingBoxContains(this._editBtnBounds(), point)) {
      this.openEditDialog()
      return true
    }

    // Controls row
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

    // Transform handles
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
        center:     { ...hp.center },
        startAngle: Math.atan2(point.y - hp.center.y, point.x - hp.center.x),
        startRot:   this._rotation,
      }
      return true
    }

    // Scale handle — only when sizeSlot is unbound; adjusts the manual font size.
    if (!this._sizeSlot.isActive && ptDist(point, hp.scale) <= HANDLE_HIT) {
      this._drag = {
        type:       'scale',
        center:     { ...hp.center },
        startDist:  Math.max(1, ptDist(point, hp.center)),
        startSize:  this._manualSize,
      }
      return true
    }

    // Move handle — only when positionSlot is unbound and no mask is applied
    // (masked text ignores _position entirely, so manual move has no effect).
    if (!this._positionSlot.isActive && !this._maskSlot.isActive
        && ptDist(point, hp.move) <= HANDLE_HIT) {
      this._drag = {
        type:       'move',
        startMouse: { ...point },
        startPos:   { ...this._position },
      }
      return true
    }

    return false
  }

  handlePointerMove(point: Point): void {
    if (this._drag === null) return

    if (this._drag.type === 'move') {
      this._manualPosition = {
        x: this._drag.startPos.x + point.x - this._drag.startMouse.x,
        y: this._drag.startPos.y + point.y - this._drag.startMouse.y,
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
    this._drag = null
    this._clearRotDwellTimer()
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
    if (boundingBoxContains(this.canvasBounds, point)) return this
    if (boundingBoxContains(this._ctrlPanelBounds(), point)) return this
    if (this._drag !== null) return this

    const hp = this._handlePos()
    if (ptDist(point, hp.rotate) <= HANDLE_HIT) return this
    if (!this._sizeSlot.isActive && ptDist(point, hp.scale) <= HANDLE_HIT) return this
    if (!this._positionSlot.isActive && !this._maskSlot.isActive
        && ptDist(point, hp.move) <= HANDLE_HIT) return this
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
  }

  override renderOverlay(ctx: Ctx2D): void {
    this._renderHandles(ctx)
    this._renderEditOverlay(ctx)
  }

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
  // no mask is set), render lines centred on _position, rotated about it.
  private _renderUnmasked(ctx: Ctx2D): void {
    const { x: px, y: py } = this._position
    const lines  = this._wrapLines(ctx)
    const lineH  = Math.ceil(this._size * 1.35)
    const totalH = (lines.length - 1) * lineH

    ctx.save()
    ctx.translate(px, py)
    ctx.rotate(this._rotation)

    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    let y = -totalH / 2
    for (const line of lines) {
      ctx.fillText(line.text, 0, y)
      y += lineH
    }
    ctx.restore()
  }

  // Word-wrap _text to fit within the canvas width (minus WRAP_PAD on each
  // side), preserving '\n' as hard breaks. Each returned line carries the
  // index into _text where its text begins, so the cursor (an index into
  // _text) can be mapped back to a wrapped line + column for rendering.
  private _wrapLines(ctx: Ctx2D): { text: string; start: number }[] {
    const maxWidth = Math.max(1, Node.canvasWidth - WRAP_PAD * 2)
    const lines: { text: string; start: number }[] = []

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
          lines.push({ text: line, start: lineStart })
          line      = tok
          lineStart = paraOffset + consumed
        } else {
          line = line.length > 0 ? line + pendingWs + tok : pendingWs + tok
        }
        consumed += tok.length
        pendingWs = ''
      }
      lines.push({ text: line, start: lineStart })

      paraOffset += para.length + 1   // +1 for the '\n'
    }
    return lines
  }

  // Masked: flow text into the mask shape using per-scanline word-wrap.
  //
  // _maskRows were sampled from the mask counter-rotated by -_rotation about
  // the canvas centre (see _sampleMask). Rendering at those row coordinates
  // under a forward rotation by _rotation (about the same centre) places the
  // wrapped text back inside the true mask outline, rotated as a whole.
  private _renderMasked(ctx: Ctx2D): void {
    const rows  = this._maskRows!
    const lineH = Math.ceil(this._size * 1.35)
    const h     = rows.length
    const pad   = 6   // horizontal padding inside the mask boundary

    // Find the first row with mask coverage.
    let startY = 0
    while (startY < h && !rows[startY]) startY++
    if (startY >= h) return

    ctx.save()
    if (this._rotation !== 0) {
      const cx = Node.canvasWidth / 2, cy = Node.canvasHeight / 2
      ctx.translate(cx, cy)
      ctx.rotate(this._rotation)
      ctx.translate(-cx, -cy)
    }

    ctx.textAlign    = 'left'
    ctx.textBaseline = 'alphabetic'

    // Build a flat word queue; null marks a paragraph break.
    const queue: (string | null)[] = []
    for (const para of this._text.split('\n')) {
      for (const w of para.split(/\s+/).filter(Boolean)) queue.push(w)
      queue.push(null)
    }

    let y  = startY + this._size  // first baseline
    let qi = 0

    while (qi < queue.length && y < h) {
      const rowY     = Math.min(h - 1, Math.floor(y))
      const scanline = rows[rowY]

      if (!scanline || scanline.w <= pad * 2) {
        y += lineH
        continue
      }

      const xStart = scanline.x + pad
      const avail  = scanline.w - pad * 2

      // Greedy word-wrap for this line.
      let line = ''
      while (qi < queue.length) {
        const word = queue[qi]!  // bounds-checked by while condition
        if (word === null) { qi++; break }          // paragraph break
        const test = line ? `${line} ${word}` : word
        if (ctx.measureText(test).width <= avail) {
          line = test
          qi++
        } else {
          if (!line) { line = word; qi++ }           // force oversized word
          break
        }
      }

      if (line) ctx.fillText(line, xStart, y)
      y += lineH
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

    return {
      center,
      move: { x: this._position.x, y: this._position.y },
      // Scale handle: (so, so) rotated into world space → lower-right
      scale: {
        x: center.x + so * cos - so * sin,
        y: center.y + so * sin + so * cos,
      },
      // Rotate handle: (0, -ROT_ARM) rotated into world space → directly above when rot=0
      rotate: {
        x: center.x + ROT_ARM * sin,
        y: center.y - ROT_ARM * cos,
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
    ctx.moveTo(hp.center.x, hp.center.y)
    ctx.lineTo(hp.rotate.x, hp.rotate.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(hp.center.x, hp.center.y)
    ctx.lineTo(hp.scale.x, hp.scale.y)
    ctx.stroke()
    ctx.setLineDash([])

    // Scale handle — square, cyan glow (dimmed when sizeSlot bound).
    // Scaling adjusts the manual font size directly.
    this._drawGlowSquare(ctx, hp.scale, HANDLE_SZ,
      this._sizeSlot.isActive ? '#666688' : '#81d4fa')

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

    // Move handle — circle + crosshair, white glow. Hidden entirely when a
    // mask is applied, since masked text ignores _position.
    if (!masked) {
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

    const lineH  = Math.ceil(this._size * 1.35)
    const totalH = (lines.length - 1) * lineH

    const lineWidth = ctx.measureText(lineRec.text).width
    const prefixW   = ctx.measureText(lineRec.text.slice(0, col)).width
    ctx.restore()

    // Local frame: origin at _position, x to the right, y down, before
    // rotation — matches the translate/rotate setup in _renderUnmasked.
    const localX = -lineWidth / 2 + prefixW
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

  private _fontString(): string {
    const parts = []
    if (this._italic) parts.push('italic')
    if (this._bold)   parts.push('bold')
    parts.push(`${Math.round(this._size)}px`, this._fontFamily)
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
