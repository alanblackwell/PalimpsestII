import type { Ctx2D, Point } from '../core/types.js'
import { OnsetDetector } from './OnsetDetector.js'
import { audioRhythm } from './AudioRhythm.js'

// ------------------------------------------------------------
// AudioScopeWidget — shared live-scope tuning UI
// ------------------------------------------------------------
//
// The part of the audio-onset panel that's identical wherever it's shown
// (EventLayer, TempoLayer) and reads/writes the single shared `audioRhythm`
// singleton: the band-centre-frequency mini-slider, the amplitude-trace
// scope with onset markers and the predicted-beat overlay, and the
// level/Q drag handles. NOT included: the audioSlot binding row and pill
// header, which stay layer-specific (each layer still decides which
// VideoLayer feeds the shared analysis).
//
// Each host layer constructs its own instance — this class only holds
// per-instance UI/drag state, never analysis state, so two widgets bound
// to the same audioRhythm singleton can be dragged independently while
// staying visually and numerically in sync.

const AUDIO_TC   = '#a87ee8'   // Audio type accent
const ONSET_TC   = '#ffe000'   // detected-onset marker
const PREDICT_TC = '#4ae0e0'   // predicted-beat marker — distinct from both
const TAP_TC     = '#ff3b3b'   // tap-button marker — distinct from all three

const SCOPE_H         = 64
const SCOPE_PAD      = 8
const HANDLE_HIT_R   = 10   // pointer-hit radius around a scope drag handle
const NORM_HEADROOM  = 4    // total deviation range (both directions) the axis spans
// Vertical anchor for the mean: 20% up from the bottom, not centred — every
// onset of interest sits above the mean, so most of the height (80%) is
// given to headroom above it, and little to below.
const MEAN_Y_FRAC    = 0.2
const FREQ_ROW_H     = 14   // band-centre-frequency + selectivity row
const FREQ_ROW_GAP   = 4

const FILTER_FREQ_MIN = 40     // Hz
const FILTER_FREQ_MAX = 2000   // Hz
const FILTER_Q_MIN    = 0.5
const FILTER_Q_MAX    = 8

// Q is shown as whiskers either side of the band-centre line, sized by
// half-bandwidth in octaves — a visual approximation (not exact biquad
// magnitude-response math), just enough to be monotonic and to give a
// meaningfully different width across the Q range. Since the frequency
// axis is linear in log(f), a fixed octave width maps to a fixed pixel
// width regardless of where the band centre currently sits.
const FILTER_OCTAVE_RANGE = Math.log2(FILTER_FREQ_MAX / FILTER_FREQ_MIN)
const Q_HALF_OCTAVE_MIN   = 0.5 / FILTER_Q_MAX   // narrowest whiskers (highest Q)
const Q_HALF_OCTAVE_MAX   = 0.5 / FILTER_Q_MIN   // widest whiskers (lowest Q)

const MAX_PREDICTED_BEATS = 300   // loop safety cap, well above what HISTORY_LEN can show

type BBox = { x: number; y: number; width: number; height: number }

export class AudioScopeWidget {
  // Total height render() consumes — callers need this up front to size
  // their own pill backdrop before calling render().
  static readonly HEIGHT = FREQ_ROW_H + FREQ_ROW_GAP + SCOPE_H

  private _scopeBounds:   BBox | null = null
  private _levelHandlePos: Point | null = null
  private _qLeftPos:       Point | null = null
  private _qRightPos:      Point | null = null
  private _freqRowBounds:  BBox | null = null
  private _scopeDrag: 'level' | 'qLeft' | 'qRight' | 'freq' | null = null

  // Draws the freq-slider row + scope (waveform, onset markers, predicted
  // beat grid, level/Q handles) at (x, y, width). Returns the total height
  // consumed, so the caller can stack more content beneath it.
  render(ctx: Ctx2D, x: number, y: number, width: number): number {
    const totalH = AudioScopeWidget.HEIGHT

    ctx.save()
    ctx.textBaseline = 'middle'

    // Band-centre-frequency + selectivity (Q) — one integrated control.
    // A vertical line marks the band centre (drag anywhere on the row's
    // background to retune it, full-width track since the range needs a
    // wider grab target than a circular handle); horizontal whiskers
    // either side show the filter's selectivity — narrow whiskers = high
    // Q (tight band), wide whiskers = low Q (broad band). Each whisker
    // end is independently draggable; both drive the same symmetric Q.
    const freqRowY = y
    const freqX    = x + SCOPE_PAD
    const freqW    = width - SCOPE_PAD * 2
    this._freqRowBounds = { x: freqX, y: freqRowY, width: freqW, height: FREQ_ROW_H }

    ctx.fillStyle = 'rgba(255,255,255,0.06)'
    ctx.beginPath(); ctx.roundRect(freqX, freqRowY, freqW, FREQ_ROW_H, 3); ctx.fill()

    const centerX   = this._freqToX(audioRhythm.filterFreq, freqX, freqW)
    const midY      = freqRowY + FREQ_ROW_H / 2
    const whiskerPx = this._qToWhiskerPx(audioRhythm.filterQ, freqW)
    const leftX     = Math.max(freqX, centerX - whiskerPx)
    const rightX    = Math.min(freqX + freqW, centerX + whiskerPx)
    this._qLeftPos  = { x: leftX, y: midY }
    this._qRightPos = { x: rightX, y: midY }

    ctx.strokeStyle = AUDIO_TC + 'aa'
    ctx.lineWidth   = 1.5
    ctx.beginPath(); ctx.moveTo(leftX, midY); ctx.lineTo(rightX, midY); ctx.stroke()
    for (const wx of [leftX, rightX]) {
      ctx.beginPath(); ctx.moveTo(wx, midY - 4); ctx.lineTo(wx, midY + 4); ctx.stroke()
    }

    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.beginPath(); ctx.roundRect(centerX - 1.5, freqRowY - 2, 3, FREQ_ROW_H + 4, 1.5); ctx.fill()

    ctx.font      = '8px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.textAlign = 'left'
    ctx.fillText(`band ${Math.round(audioRhythm.filterFreq)} Hz · Q ${audioRhythm.filterQ.toFixed(1)}`,
      freqX + 4, freqRowY + FREQ_ROW_H / 2 + 0.5)

    // Live scope
    const scopeX = x + SCOPE_PAD
    const scopeY = freqRowY + FREQ_ROW_H + FREQ_ROW_GAP
    const scopeW = width - SCOPE_PAD * 2
    this._scopeBounds = { x: scopeX, y: scopeY, width: scopeW, height: SCOPE_H }

    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.beginPath(); ctx.roundRect(scopeX, scopeY, scopeW, SCOPE_H, 4); ctx.fill()

    // Fixed time axis: x is placed by age (ticks since the sample was
    // captured) against the buffer's full capacity, not its current length —
    // so the trace starts empty and fills in from the right as the buffer
    // fills, rather than the whole history stretching to fit the width from
    // the first sample.
    const hist = audioRhythm.onset.history
    if (hist.length > 1) {
      ctx.beginPath()
      for (let i = 0; i < hist.length; i++) {
        const age = hist.length - 1 - i
        const px  = this._ageToX(age, scopeX, scopeW)
        const py  = this._envToY(hist[i]!, scopeY)
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
      }
      ctx.strokeStyle = AUDIO_TC + 'aa'
      ctx.lineWidth   = 1.25
      ctx.stroke()
    }

    // Wall-clock time -> tick-age conversion, shared by everything below
    // that's timestamped in ms rather than ticks (predicted beats, tap
    // markers): the average ms-per-tick across the visible window — a
    // close enough approximation for a visual overlay without tracking
    // exact per-tick timestamps everywhere. displayNowMs (not
    // performance.now() directly) freezes these overlays in place while
    // audioRhythm.paused, matching the frozen waveform.
    const nowMs = audioRhythm.displayNowMs
    const times = audioRhythm.onset.historyTimesMs
    const msPerTick = hist.length > 1 && times.length > 1
      ? (times[times.length - 1]! - times[0]!) / (times.length - 1)
      : 0

    // Predicted-beat grid — the beat-induction prior's current estimate,
    // for visually comparing "where the algorithm predicts the beat"
    // against the yellow "where the detector actually fired" markers.
    if (audioRhythm.periodMs !== null && msPerTick > 0) {
      let tBeat = nowMs - audioRhythm.currentPhase(nowMs) * audioRhythm.periodMs
      for (let k = 0; k < MAX_PREDICTED_BEATS; k++) {
        const ageTicks = (nowMs - tBeat) / msPerTick
        if (ageTicks > OnsetDetector.HISTORY_LEN - 1) break
        if (ageTicks >= 0) {
          const lineX = this._ageToX(ageTicks, scopeX, scopeW)
          ctx.strokeStyle = PREDICT_TC
          ctx.lineWidth   = 1.5
          ctx.setLineDash([2, 2])
          ctx.beginPath(); ctx.moveTo(lineX, scopeY); ctx.lineTo(lineX, scopeY + SCOPE_H); ctx.stroke()
          ctx.setLineDash([])
        }
        tBeat -= audioRhythm.periodMs
      }
    }

    // Tap markers — a red line each time the TAP button was pressed,
    // independent of whatever it did or didn't do to periodMs. Diagnostic:
    // confirms the button is actually registering clicks.
    if (msPerTick > 0) {
      for (const t of audioRhythm.tapMarkerTimesMs) {
        const ageTicks = (nowMs - t) / msPerTick
        if (ageTicks < 0 || ageTicks > OnsetDetector.HISTORY_LEN - 1) continue
        const lineX = this._ageToX(ageTicks, scopeX, scopeW)
        ctx.strokeStyle = TAP_TC
        ctx.lineWidth   = 2
        ctx.beginPath(); ctx.moveTo(lineX, scopeY); ctx.lineTo(lineX, scopeY + SCOPE_H); ctx.stroke()
      }
    }

    // Detection markers — a yellow line per still-visible onset, each
    // travelling leftward with the waveform as the buffer scrolls, and
    // dropped only once it ages out of history (not replaced by the next).
    for (const age of audioRhythm.onset.onsetAges) {
      const lineX = this._ageToX(age, scopeX, scopeW)
      ctx.strokeStyle = ONSET_TC
      ctx.lineWidth   = 2
      ctx.beginPath(); ctx.moveTo(lineX, scopeY); ctx.lineTo(lineX, scopeY + SCOPE_H); ctx.stroke()
    }

    // Level threshold — horizontal dashed line + draggable handle at
    // mid-width. Positioned via the same auto-normalised transform as the
    // waveform, so the dashed line always tracks where it actually crosses
    // the live trace.
    const levelY = this._envToY(audioRhythm.onset.levelThreshold, scopeY)
    ctx.strokeStyle = AUDIO_TC + '88'
    ctx.lineWidth   = 1
    ctx.setLineDash([4, 3])
    ctx.beginPath(); ctx.moveTo(scopeX, levelY); ctx.lineTo(scopeX + scopeW, levelY); ctx.stroke()
    ctx.setLineDash([])

    const levelHx = scopeX + scopeW / 2
    this._levelHandlePos = { x: levelHx, y: levelY }
    ctx.beginPath(); ctx.arc(levelHx, levelY, 5, 0, Math.PI * 2)
    ctx.fillStyle = AUDIO_TC
    ctx.fill()

    ctx.font      = '9px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.32)'
    ctx.textAlign = 'left'
    ctx.fillText('level', scopeX + 4, scopeY + 9)

    ctx.restore()
    return totalH
  }

  // ----------------------------------------------------------
  // Interaction — call from the host layer's own hitTestSelf /
  // handlePointerDown / handlePointerMove / handlePointerUp.
  // ----------------------------------------------------------

  hitTest(point: Point): 'level' | 'qLeft' | 'qRight' | 'freq' | null {
    if (this._levelHandlePos
        && Math.hypot(point.x - this._levelHandlePos.x, point.y - this._levelHandlePos.y) <= HANDLE_HIT_R) return 'level'
    if (this._qLeftPos
        && Math.hypot(point.x - this._qLeftPos.x, point.y - this._qLeftPos.y) <= HANDLE_HIT_R) return 'qLeft'
    if (this._qRightPos
        && Math.hypot(point.x - this._qRightPos.x, point.y - this._qRightPos.y) <= HANDLE_HIT_R) return 'qRight'
    if (this._freqRowBounds
        && point.x >= this._freqRowBounds.x && point.x <= this._freqRowBounds.x + this._freqRowBounds.width
        && point.y >= this._freqRowBounds.y && point.y <= this._freqRowBounds.y + this._freqRowBounds.height) return 'freq'
    return null
  }

  handlePointerDown(point: Point): boolean {
    const handle = this.hitTest(point)
    if (handle === null) return false
    this._scopeDrag = handle
    return true
  }

  handlePointerMove(point: Point): void {
    if (this._scopeDrag === null || this._scopeBounds === null) return
    const { y: scopeY } = this._scopeBounds
    if (this._scopeDrag === 'level') {
      audioRhythm.onset.levelThreshold = Math.max(0, Math.min(1, this._yToEnv(point.y, scopeY)))
    } else if (this._scopeDrag === 'qLeft' || this._scopeDrag === 'qRight') {
      if (this._freqRowBounds === null) return
      const { x: rowX, width: rowW } = this._freqRowBounds
      const centerX = this._freqToX(audioRhythm.filterFreq, rowX, rowW)
      audioRhythm.filterQ = this._whiskerPxToQ(Math.abs(point.x - centerX), rowW)
    } else if (this._scopeDrag === 'freq' && this._freqRowBounds !== null) {
      const row = this._freqRowBounds
      audioRhythm.filterFreq = this._xToFreq(point.x, row.x, row.width)
    }
  }

  handlePointerUp(): void {
    this._scopeDrag = null
  }

  get dragging(): boolean { return this._scopeDrag !== null }

  // ----------------------------------------------------------
  // Transforms
  // ----------------------------------------------------------

  // Auto-normalised envelope <-> scope-y, built from OnsetDetector's
  // slow-moving centre/scale — the running average maps to MEAN_Y_FRAC up
  // from the bottom (not centred: onsets are rises above the mean, so most
  // of the height is headroom above it), at a constant deviations-per-pixel
  // rate in both directions (NORM_HEADROOM total), so the trace stays
  // visible regardless of how loud or quiet the filtered signal currently is.
  private _envToY(v: number, scopeY: number): number {
    const center = audioRhythm.onset.normCenter
    const scale  = audioRhythm.onset.normScale * NORM_HEADROOM
    const norm   = MEAN_Y_FRAC + (v - center) / (2 * scale)
    return scopeY + SCOPE_H - Math.min(1, Math.max(0, norm)) * SCOPE_H
  }

  private _yToEnv(y: number, scopeY: number): number {
    const center = audioRhythm.onset.normCenter
    const scale  = audioRhythm.onset.normScale * NORM_HEADROOM
    const norm   = (scopeY + SCOPE_H - y) / SCOPE_H
    return center + (norm - MEAN_Y_FRAC) * 2 * scale
  }

  // Band-centre frequency <-> row-x, log-mapped over [FILTER_FREQ_MIN,
  // FILTER_FREQ_MAX]. Shared by render (centre line + whisker anchor) and
  // pointer handling (freq-row drag, and re-deriving the centre for a
  // whisker drag in progress).
  private _freqToX(freq: number, rowX: number, rowW: number): number {
    const t = Math.log(freq / FILTER_FREQ_MIN) / Math.log(FILTER_FREQ_MAX / FILTER_FREQ_MIN)
    return rowX + Math.min(1, Math.max(0, t)) * rowW
  }

  private _xToFreq(x: number, rowX: number, rowW: number): number {
    const t = Math.max(0, Math.min(1, (x - rowX) / rowW))
    return FILTER_FREQ_MIN * Math.pow(FILTER_FREQ_MAX / FILTER_FREQ_MIN, t)
  }

  // Q <-> whisker half-width in px, via half-bandwidth in octaves. Since
  // _freqToX is affine in log(f), a fixed octave width is a fixed pixel
  // width regardless of where the band centre currently sits — no need to
  // convert through actual Hz values on each side.
  private _qToWhiskerPx(q: number, rowW: number): number {
    const halfOctave = Math.min(Q_HALF_OCTAVE_MAX, Math.max(Q_HALF_OCTAVE_MIN, 0.5 / q))
    return (halfOctave / FILTER_OCTAVE_RANGE) * rowW
  }

  private _whiskerPxToQ(px: number, rowW: number): number {
    const halfOctave = Math.min(Q_HALF_OCTAVE_MAX, Math.max(Q_HALF_OCTAVE_MIN, (px / rowW) * FILTER_OCTAVE_RANGE))
    return Math.min(FILTER_Q_MAX, Math.max(FILTER_Q_MIN, 0.5 / halfOctave))
  }

  // Fixed time-axis transform: age is ticks-since-capture, scaled against
  // the buffer's full capacity (not its current length) so newest is
  // always pinned to the right edge and the axis never rescales as the
  // buffer fills.
  private _ageToX(age: number, scopeX: number, scopeW: number): number {
    return scopeX + scopeW - (age / (OnsetDetector.HISTORY_LEN - 1)) * scopeW
  }
}
