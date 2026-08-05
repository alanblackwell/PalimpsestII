// ------------------------------------------------------------
// OnsetDetector — crude, low-latency level-crossing detector
// ------------------------------------------------------------
//
// Plain stateful helper (not a Node/Region) shared by EventLayer's
// audio-onset trigger mode and TempoLayer's audio-driven beat induction.
// Deliberately time-domain only — no FFT — so a one-off transient isn't
// delayed by an analysis window. Frequency selectivity (e.g. isolating a
// kick drum from vocals) is the caller's job — pass in an AnalyserNode
// downstream of a BiquadFilterNode rather than the raw tap; this class
// just watches whatever signal it's given.
//
// Each sample() call reads the analyser's raw waveform, reduces it to a
// single envelope scalar (mean absolute deviation from silence, [0, 1]),
// and fires `onset` on the below→above rising edge of `levelThreshold`,
// gated by a refractory period. Edge-triggering (rather than "level is
// currently above threshold") is what keeps a sustained loud passage from
// retriggering every time the refractory window expires.

export class OnsetDetector {
  levelThreshold: number   // [0, 1] — mutable; e.g. dragged on a live scope
  refractoryMs = 80

  // Ring buffer of recent envelope samples, render-only (live scope trace).
  // ~1000 samples at one sample() call per rendered frame (~60 Hz) is a
  // long enough window to see multiple cycles of a slow beat. Public so
  // callers can build a fixed (non-rescaling) time axis from it — see
  // onsetAges below.
  readonly history: number[] = []
  static readonly HISTORY_LEN = 1000

  // Wall-clock capture time (performance.now()) of each sample in `history`,
  // parallel/same-length — lets a caller place something measured in real
  // time (e.g. a predicted beat grid) onto history's tick-indexed x-axis by
  // interpolation, without tracking per-tick timestamps itself.
  readonly historyTimesMs: number[] = []

  private _wasAbove = false
  private _lastOnsetMs: number | null = null
  private _buf = new Uint8Array(0)

  // Monotonic tick counter + the ticks every still-visible onset fired at
  // (oldest first), used to locate each onset's current position as the
  // buffer scrolls — see onsetAges — so a caller can draw a marker per
  // onset that travels with the trace rather than only the latest one.
  private _tick = 0
  private _onsetTicks: number[] = []

  // Slow-moving centre/spread of the envelope (EMA, not a windowed min/max
  // — avoids the display scale jumping every time a peak enters or leaves
  // the visible history), for callers that want to auto-normalise a live
  // trace so the average level sits mid-range and the waveform stays
  // visible regardless of how loud/quiet the current signal is.
  private _avgEnvelope  = 0
  private _avgDeviation = 0.02
  private static readonly NORM_SMOOTH = 0.005

  constructor(levelThreshold: number) {
    this.levelThreshold = levelThreshold
  }

  sample(analyser: AnalyserNode, nowMs: number): { envelope: number; onset: boolean } {
    if (this._buf.length !== analyser.fftSize) this._buf = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(this._buf)

    let sum = 0
    for (const b of this._buf) sum += Math.abs(b - 128)
    const envelope = sum / this._buf.length / 128

    this.history.push(envelope)
    if (this.history.length > OnsetDetector.HISTORY_LEN) this.history.shift()
    this.historyTimesMs.push(nowMs)
    if (this.historyTimesMs.length > OnsetDetector.HISTORY_LEN) this.historyTimesMs.shift()

    this._avgEnvelope  += (envelope - this._avgEnvelope) * OnsetDetector.NORM_SMOOTH
    this._avgDeviation += (Math.abs(envelope - this._avgEnvelope) - this._avgDeviation) * OnsetDetector.NORM_SMOOTH

    const above = envelope >= this.levelThreshold
    const ready = this._lastOnsetMs === null || nowMs - this._lastOnsetMs >= this.refractoryMs
    const onset = above && !this._wasAbove && ready
    this._wasAbove = above

    if (onset) {
      this._lastOnsetMs = nowMs
      this._onsetTicks.push(this._tick)
    }
    this._tick++
    // Drop onset ticks once they've scrolled fully out of the visible history.
    while (this._onsetTicks.length > 0 && this._tick - this._onsetTicks[0]! > OnsetDetector.HISTORY_LEN) {
      this._onsetTicks.shift()
    }
    return { envelope, onset }
  }

  // Advances the ring buffer + tick counter from the wall clock alone, with
  // no real signal to sample — lets a caller's scope keep rendering/
  // animating (tap markers, predicted-beat grid, both keyed off history's
  // timing) when no live analyser is available yet, e.g. tap-tempo used
  // before any audio is bound. Flatlines the trace at the current running
  // mean rather than jumping to 0, so it reads as "no signal" rather than
  // a discontinuity, and runs no onset detection — there's nothing to
  // detect against.
  sampleSilent(nowMs: number): void {
    this.history.push(this._avgEnvelope)
    if (this.history.length > OnsetDetector.HISTORY_LEN) this.history.shift()
    this.historyTimesMs.push(nowMs)
    if (this.historyTimesMs.length > OnsetDetector.HISTORY_LEN) this.historyTimesMs.shift()

    this._tick++
    while (this._onsetTicks.length > 0 && this._tick - this._onsetTicks[0]! > OnsetDetector.HISTORY_LEN) {
      this._onsetTicks.shift()
    }
  }

  // Ages (in samples/ticks since firing) of every onset still within the
  // visible history, oldest first — each one travels as the buffer scrolls
  // and drops out once its age exceeds HISTORY_LEN.
  get onsetAges(): number[] {
    return this._onsetTicks.map(t => this._tick - t)
  }

  // Slow-moving centre of the envelope — display middle, not a detection value.
  get normCenter(): number { return this._avgEnvelope }
  // Slow-moving mean absolute deviation — display scale, not a detection value.
  get normScale():  number { return Math.max(this._avgDeviation, 0.01) }
}
