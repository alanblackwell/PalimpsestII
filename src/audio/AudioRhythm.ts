import { OnsetDetector } from './OnsetDetector.js'

// ------------------------------------------------------------
// AudioRhythm — shared, single "master" audio-rhythm analysis
// ------------------------------------------------------------
//
// Plain module-level singleton (same weight as FilterGL's shared WebGL
// pipeline, src/layers/FilterGL.ts) — not a Node/Layer/Clock, no graph
// registration, no per-frame ticking of its own. There is only ever one
// audio rhythm being tracked at a time, so EventLayer's audio-onset mode
// and TempoLayer's audio-driven beat induction both call into this same
// instance rather than each keeping an independent filter/detector/tempo
// estimate that could drift out of sync with the other.
//
// update() is driven by whichever layer(s) currently have an active,
// bound audioSlot — there's no ticking here without a caller supplying a
// live AnalyserNode.

// Gap after which a new tap sequence starts. Must comfortably exceed the
// slowest realistic tap-to-tap spacing — too short and every tap in a
// genuine slow-tempo sequence (or just an unhurried human click) looks
// like the first tap of a brand new run, and periodMs never updates at
// all despite tap() otherwise running fine. 12s covers down to 6 BPM — e.g.
// tapping the downbeat of a slow bar rather than every beat, where "tempo"
// here really means bar-rate, not individual beats.
const MIN_TAP_INTERVAL_GAP_MS = 12000
const MAX_TAP_SAMPLES         = 8
const TAP_DRIFT_RATE          = 0.4    // blend weight for taps after the first in a run — higher than audio's, since a deliberate tap is higher-quality evidence and should converge in a few taps, not drift glacially

// Refractory scales with the current period estimate once one exists, so
// an echo/reverb tail landing soon after a beat structurally can't ever
// register as a separate onset — filtered before it reaches interval
// estimation at all, not just down-weighted afterward.
const BASE_REFRACTORY_MS  = 80     // before any period estimate exists
const REFRACTORY_FRACTION = 0.6    // of periodMs — rejects anything faster than ~0.6x tempo

const AUDIO_DRIFT_RATE           = 0.1    // default period-drift blend for live audio-detected onsets
const AUDIO_DRIFT_RATE_CONFIDENT = 0.02   // once a tap has set the period: much stickier — a tap is more reliable evidence of "this is the beat" than raw signal, so audio onsets mostly just refine phase

function wrap01(v: number): number {
  return ((v % 1) + 1) % 1
}

export class AudioRhythm {
  // Global pause (e.g. the 'p' key, alongside the singleton ClockLayer and
  // VideoLayer playback — see main.ts) — freezes analysis entirely: update()
  // stops sampling/detecting, so history/onset markers hold their last
  // state. displayNowMs freezes at the moment pausing started, so the
  // predicted-beat overlay (computed from wall-clock time each render)
  // stops advancing too, rather than continuing to drift while the trace
  // itself is frozen.
  paused = false
  private _pausedAtMs: number | null = null

  setPaused(p: boolean): void {
    if (p === this.paused) return
    this.paused     = p
    this._pausedAtMs = p ? performance.now() : null
  }

  get displayNowMs(): number {
    return this.paused && this._pausedAtMs !== null ? this._pausedAtMs : performance.now()
  }

  // Shared onset detector — level threshold is its one user-tunable value.
  // 0.05 puts the handle at roughly 50% up AudioScopeWidget's vertical axis
  // given OnsetDetector's initial (pre-adaptation) EMA seed values — a
  // reasonable starting drag position before any real audio has streamed
  // in and the live centre/scale have settled to something track-specific.
  readonly onset = new OnsetDetector(0.05)

  // Shared band-pass filter tuning.
  filterFreq = 120   // Hz — near a kick drum's fundamental
  filterQ    = 1.5

  // Beat-induction prior — null until locked (bootstrapped from the first
  // two onsets, or seeded directly via tap()). All wall-clock (ms) based:
  // onset-interval measurement already was, and decoupling the phase
  // anchor from any one consumer's own time source is exactly what
  // sharing this across multiple layers requires.
  periodMs: number | null = null
  private _phaseAnchorMs  = 0
  private _lastBeatOnsetMs: number | null = null
  private _tapTimes: number[] = []

  // Wall-clock time of every recent tap() call, render-only — lets a
  // caller (AudioScopeWidget) draw a marker per tap, confirming the
  // button is actually registering clicks independent of whatever it did
  // or didn't do to periodMs. Pruned by count, not by visible-window age —
  // the widget itself skips any that have scrolled out.
  readonly tapMarkerTimesMs: number[] = []
  private static readonly MAX_TAP_MARKERS = 32

  // True once a tap has set periodMs — slows live audio-onset period drift
  // right down (see AUDIO_DRIFT_RATE_CONFIDENT) so echoes/noise can't walk
  // a tap-established tempo away from what was actually tapped. Phase
  // correction is unaffected either way — audio timing is more precise
  // than a human tap, so it should keep adjusting phase freely.
  private _periodConfident = false

  // Band-pass tap, lazily built downstream of whichever raw AnalyserNode
  // is currently supplied, rebuilt if the source changes.
  private _filterNode:       BiquadFilterNode | null = null
  private _filteredAnalyser: AnalyserNode | null = null
  private _lastRawAnalyser:  AnalyserNode | null = null

  // Runs the shared filter + onset detector against `rawAnalyser`, and
  // updates the beat-induction prior on a fire. Returns whether an onset
  // fired this call. Call once per active audioSlot per recompute().
  update(rawAnalyser: AnalyserNode, nowMs: number): boolean {
    if (this.paused) return false
    this.onset.refractoryMs = this.periodMs !== null
      ? Math.max(BASE_REFRACTORY_MS, this.periodMs * REFRACTORY_FRACTION)
      : BASE_REFRACTORY_MS
    const filtered = this._getFilteredAnalyser(rawAnalyser)
    const { onset } = this.onset.sample(filtered, nowMs)
    if (onset) this._registerBeatOnset(nowMs)
    return onset
  }

  currentPhase(nowMs: number): number {
    if (this.periodMs === null) return 0
    return wrap01((nowMs - this._phaseAnchorMs) / this.periodMs)
  }

  currentRateHz(): number {
    return this.periodMs === null ? 0 : 1000 / this.periodMs
  }

  // Tap-tempo — (re)seeds the prior directly from recent tap intervals,
  // same convention as music software, and marks the period "confident"
  // (see AUDIO_DRIFT_RATE_CONFIDENT) so it takes priority over live audio:
  // subsequent onsets keep correcting phase readily, but barely nudge the
  // period, and the resulting refractory (see update()) structurally
  // rejects anything arriving too soon after a beat — e.g. an echo/reverb
  // tail immediately following the real hit. A gap of more than
  // MIN_TAP_INTERVAL_GAP_MS starts a fresh tap sequence, free to jump
  // straight to a new tempo.
  tap(nowMs: number): void {
    this.tapMarkerTimesMs.push(nowMs)
    if (this.tapMarkerTimesMs.length > AudioRhythm.MAX_TAP_MARKERS) this.tapMarkerTimesMs.shift()

    const last = this._tapTimes.at(-1)
    if (last !== undefined && nowMs - last > MIN_TAP_INTERVAL_GAP_MS) this._tapTimes = []
    this._tapTimes.push(nowMs)
    if (this._tapTimes.length > MAX_TAP_SAMPLES) this._tapTimes.shift()
    if (this._tapTimes.length < 2) return   // first tap of a run just anchors; nothing to estimate yet

    const interval = nowMs - this._tapTimes[this._tapTimes.length - 2]!

    if (this._tapTimes.length === 2 || this.periodMs === null) {
      // First interval of this run (or no estimate at all yet) — jump to
      // it directly rather than blending against an unrelated prior.
      this.periodMs = interval
    } else {
      // Later taps in the same run: blend progressively so the estimate
      // firms up over a few taps instead of recomputing (and jittering)
      // from scratch each time.
      this.periodMs = this.periodMs * (1 - TAP_DRIFT_RATE) + interval * TAP_DRIFT_RATE
    }

    this._phaseAnchorMs    = nowMs
    this._lastBeatOnsetMs  = null
    this._periodConfident  = true
  }

  // Crude drift-tolerant beat tracker (a lightweight phase-locked loop).
  private _registerBeatOnset(nowMs: number): void {
    if (this._lastBeatOnsetMs === null) {
      this._lastBeatOnsetMs = nowMs
      return
    }
    const interval = nowMs - this._lastBeatOnsetMs
    this._lastBeatOnsetMs = nowMs

    if (this.periodMs === null) {
      // Bootstrap the prior from the raw interval between the first two onsets.
      this.periodMs       = interval
      this._phaseAnchorMs = nowMs
      return
    }

    // Reject onsets that don't look like a continuation of the current
    // beat (spurious hit, syncopation) — avoids corrupting the prior. In
    // practice this rarely trips once a period estimate exists, since the
    // refractory (update()) already keeps intervals from landing much
    // below REFRACTORY_FRACTION × periodMs — kept as defense in depth.
    if (interval < this.periodMs * 0.5 || interval > this.periodMs * 1.5) return

    // Slow drift toward the freshly measured interval — much slower once
    // a tap has established the period (AUDIO_DRIFT_RATE_CONFIDENT), so
    // taps take priority over ongoing audio evidence for period specifically.
    const driftRate = this._periodConfident ? AUDIO_DRIFT_RATE_CONFIDENT : AUDIO_DRIFT_RATE
    this.periodMs = this.periodMs * (1 - driftRate) + interval * driftRate

    // Damped phase-alignment: nudge the anchor toward where this onset
    // would land exactly on a phase wrap, rather than a hard reset. Same
    // rate regardless of _periodConfident — audio timing is more precise
    // than a tap, so phase keeps adjusting freely either way.
    const rawPhase   = wrap01((nowMs - this._phaseAnchorMs) / this.periodMs)
    const phaseError = rawPhase > 0.5 ? rawPhase - 1 : rawPhase
    this._phaseAnchorMs += phaseError * this.periodMs * 0.25
  }

  // Lazily builds (and rebuilds on source change) a band-pass tap
  // downstream of the raw AnalyserNode a VideoLayer hands back: raw
  // analyser -> BiquadFilterNode('bandpass') -> our own AnalyserNode. This
  // is an AnalyserNode's output fanning out further, not a change to
  // VideoLayer — keeps "VideoLayer only exposes the tap, DSP happens at
  // the consumer" (here, the shared consumer).
  private _getFilteredAnalyser(rawAnalyser: AnalyserNode): AnalyserNode {
    if (this._filterNode === null || this._lastRawAnalyser !== rawAnalyser) {
      this._filterNode?.disconnect()
      const ctx = rawAnalyser.context
      this._filterNode = ctx.createBiquadFilter()
      this._filterNode.type = 'bandpass'
      this._filteredAnalyser = ctx.createAnalyser()
      this._filteredAnalyser.fftSize = rawAnalyser.fftSize
      rawAnalyser.connect(this._filterNode)
      this._filterNode.connect(this._filteredAnalyser)
      this._lastRawAnalyser = rawAnalyser
    }
    this._filterNode.frequency.value = this.filterFreq
    this._filterNode.Q.value         = this.filterQ
    return this._filteredAnalyser!
  }
}

export const audioRhythm = new AudioRhythm()
