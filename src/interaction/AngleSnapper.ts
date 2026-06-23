// AngleSnapper — reusable snap-and-refine behaviour for angle drag handles.
//
// Phases:
//   snap    — within `threshold` rad of a snap position → angle is held there;
//             dwell timer starts.
//   dwell   — pointer stays in snap zone for `dwellMs` → progress arc fills;
//             at 100 % the handle enters refine mode.
//   refine  — angle moves freely from the snap point (snap disengaged until
//             the next drag start).
//   free    — outside all snap zones → angle is raw; timer resets if user
//             re-enters a snap zone.
//
// Usage:
//   const s = new AngleSnapper([0, Math.PI/4, ...], Math.PI/12, 700)
//   // on pointerdown:
//   s.reset()
//   // on pointermove:
//   const { angle, snapped, progress } = s.update(rawAngle)
//   // pass angle to the layer; use snapped/progress for rendering.

export interface SnapResult {
  angle:    number   // output angle — snapped or raw
  snapped:  boolean  // currently held at a snap position (dwell in progress)
  progress: number   // dwell progress [0, 1]; 1 means refine mode unlocked
}

/** Smallest angular distance, accounting for wrap-around. */
export function angleDist(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI)
  if (d > Math.PI) d = 2 * Math.PI - d
  return d
}

// ── ValueSnapper ─────────────────────────────────────────────────────────────
// Same snap-and-refine behaviour as AngleSnapper but for any 1-D value
// (no circular wrap). Useful for ratios, positions, percentages, etc.

export interface ValueSnapResult {
  value:    number   // output value — snapped or raw
  snapped:  boolean
  progress: number   // dwell progress [0, 1]; 1 = refine mode
}

export class ValueSnapper {
  private _activeSnap: number | null = null
  private _snapStartMs: number | null = null
  private _refining = false

  constructor(
    readonly snaps:     readonly number[],
    readonly threshold: number,
    readonly dwellMs:   number,
  ) {}

  reset(): void {
    this._activeSnap  = null
    this._snapStartMs = null
    this._refining    = false
  }

  update(rawValue: number): ValueSnapResult {
    if (this._refining) {
      return { value: rawValue, snapped: false, progress: 1 }
    }

    let nearest: number | null = null
    let minDist = Infinity
    for (const s of this.snaps) {
      const d = Math.abs(rawValue - s)
      if (d < minDist) { minDist = d; nearest = s }
    }

    if (nearest !== null && minDist <= this.threshold) {
      if (nearest !== this._activeSnap) {
        this._activeSnap  = nearest
        this._snapStartMs = performance.now()
      }
      const elapsed  = performance.now() - (this._snapStartMs ?? 0)
      const progress = Math.min(1, elapsed / this.dwellMs)
      if (progress >= 1) {
        this._refining = true
        return { value: rawValue, snapped: false, progress: 1 }
      }
      return { value: nearest, snapped: true, progress }
    }

    this._activeSnap  = null
    this._snapStartMs = null
    return { value: nearest ?? rawValue, snapped: false, progress: 0 }
  }

  get isRefining(): boolean { return this._refining }
}

// ── AngleSnapper ──────────────────────────────────────────────────────────────

export class AngleSnapper {
  private _activeSnap: number | null = null
  private _snapStartMs: number | null = null
  private _refining = false

  /**
   * @param snaps      Snap positions in radians (any range; wrap is handled).
   * @param threshold  Angular half-width of each snap zone in radians.
   * @param dwellMs    Milliseconds to dwell before entering refine mode.
   */
  constructor(
    readonly snaps:     readonly number[],
    readonly threshold: number,
    readonly dwellMs:   number,
  ) {}

  /** Call on drag start to return to snap mode. */
  reset(): void {
    this._activeSnap = null
    this._snapStartMs = null
    this._refining = false
  }

  /** Feed the raw angle; returns output angle and visual state. */
  update(rawAngle: number): SnapResult {
    if (this._refining) {
      return { angle: rawAngle, snapped: false, progress: 1 }
    }

    // Find nearest snap within threshold.
    let nearest: number | null = null
    let minDist = Infinity
    for (const s of this.snaps) {
      const d = angleDist(rawAngle, s)
      if (d < minDist) { minDist = d; nearest = s }
    }

    if (nearest !== null && minDist <= this.threshold) {
      // Entered or still inside a snap zone.
      if (nearest !== this._activeSnap) {
        // Re-entered (possibly a different snap) — restart dwell timer.
        this._activeSnap  = nearest
        this._snapStartMs = performance.now()
      }
      const elapsed  = performance.now() - (this._snapStartMs ?? 0)
      const progress = Math.min(1, elapsed / this.dwellMs)
      if (progress >= 1) {
        this._refining = true
        return { angle: rawAngle, snapped: false, progress: 1 }
      }
      return { angle: nearest, snapped: true, progress }
    }

    // Outside all snap zones — reset so dwell restarts if user re-enters.
    this._activeSnap  = null
    this._snapStartMs = null
    return { angle: rawAngle, snapped: false, progress: 0 }
  }

  /** The snap angle currently being held (null if free or refining). */
  get snappedAngle(): number | null {
    return (this._activeSnap !== null && !this._refining) ? this._activeSnap : null
  }

  get isRefining(): boolean { return this._refining }
}
