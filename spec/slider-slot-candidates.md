# SliderSlot candidates across all layers

`SliderSlot` (`src/ui/SliderSlot.ts`) combines a manual slider control with a `ParameterSlot`
binding drop-target in a single row. This document tabulates all current and potential uses
across the codebase, identified by surveying every layer file after the initial refactor
(2026-07-08).

---

## 1. Already using SliderSlot ✓

| Layer | Slot(s) | Binding type |
|---|---|---|
| FilterLayer | per-filter `amountSlot` | Amount |
| FillLayer | `_opacitySlot` | Amount |
| NoiseLayer | `_scaleSlot`, `_speedSlot`, `_detailSlot` | Amount |
| NoiseLayer | `_driftSlot` | Direction |
| PointLayer | `_amountSlot` | Amount |
| PointLayer | `_speedSlot` | **Rate** |
| MotionBlurLayer | `_fadeSlot`, `_delaySlot` | Amount |
| TransformLayer | `_opacitySlot` | Amount |
| DirectionLayer | `_speedSlot` | Amount |

---

## 2. Legacy slider + slot already paired — convert to SliderSlot

These layers already have both a manual slider and a `ParameterSlot` for the same value, but
use `SliderRegion` or bespoke code rather than `SliderSlot`:

| Layer | Slider | Slot | Notes |
|---|---|---|---|
| **AmountLayer** | `_slider` (SliderRegion) | `_slot` (Amount) | Core widget; `_xSlot`/`_ySlot` (Point) are separate decomposition inputs, no slider needed |
| **CompositeLayer** | `_blendSlider` (SliderRegion) | `opacitySlot` (Amount) | Canvas-centre blend control |
| **ShapeLayer** | bespoke `_scaleSliderDrag` | `scaleSlot` (Amount) | Two-row custom implementation; unifying would simplify significantly |
| **TempoLayer** | `_rateSlider` (SliderRegion) | *(no slot for rate)* | Rate slider controls Hz output; `_timeSlot` (Amount) is the time input with no slider |

---

## 3. Slot present, no manual slider — add slider via SliderSlot

| Layer | Slot | Binding type | Notes |
|---|---|---|---|
| **ShapeLayer** | `opacitySlot` | Amount | Standard binding row only; shared by RectLayer, EllipseLayer, PathLayer |
| **ShapeLayer** | `strokeWidthSlot` | Amount | Binding row only; value shown but no drag control |
| **ShapeLayer** | `rotationSlot` | **Direction** | Overlay handle exists; a slider would give numeric scrub alongside it |
| **TextLayer** | `_sizeSlot` ('scale') | Amount | Overlay handles for scale; no pill slider |
| **TextLayer** | `_opacitySlot` | Amount | No slider at all |
| **TextLayer** | `_lineSpacingSlot` | Amount | No slider |
| **TextLayer** | `_rotationSlot` | **Direction** | Overlay handle only |
| **ImageLayer** | `_opacitySlot` | Amount | Overlay handles only |
| **ImageLayer** | `_scaleSlot` | Amount | Overlay handles only |
| **ImageLayer** | `_rotationSlot` | **Direction** | Overlay rotate handle only |
| **ClipLayer** | `_scaleSlot` | Amount | Overlay handles only |
| **ClipLayer** | `_rotationSlot` | **Direction** | Overlay handle only |
| **VideoLayer** | `_opacitySlot` | Amount | No manual control at all |
| **TileLayer** | `_opacitySlot` | Amount | No slider |
| **LineLayer** | `_widthSlot` | Amount | No pill slider |
| **LineLayer** | `_opacitySlot` | Amount | No slider |
| **LineLayer** | `_directionSlot` | **Direction** | No slider |
| **AnimationPathLayer** | `_posSlot` ('position') | Amount | Scrubbing playback position 0–1 would be highly useful |
| **SequencerLayer** | `_rateSlot` ('rate') | Amount | Manual tempo control with optional binding |
| **TraceLayer** | `phaseSlot` | Amount | Has 6 other SliderRegion controls but `phaseSlot` has no slider |
| **MathLayer** | `_slotA`, `_slotB` | Amount | Adding sliders would let MathLayer act as a constant source as well as a combiner |
| **PathLayer** | `radiusSlot` ('spline radius') | Amount | Overlay-driven but no pill slider |

---

## 4. Slider present, no binding slot — add Amount slot

| Layer | Slider(s) | Controls | Notes |
|---|---|---|---|
| **TraceLayer** | `_raysSlider` | number of trace points | All 6 are pure algorithmic parameters; adding Amount slots would allow animated control |
| **TraceLayer** | `_smoothSlider` | smoothness / window size | |
| **TraceLayer** | `_sizeSlider` | granularity / work size | |
| **TraceLayer** | `_biasSlider` | radial bias | |
| **TraceLayer** | `_circSlider` | circular bias | |
| **TraceLayer** | `_gradModeSlider` | gradient/hue mode | |
| **TempoLayer** | `_rateSlider` | rate in Hz (log-scaled) | Adding an Amount slot to receive external rate control is the main gap; `_timeSlot` covers the time input |

---

## Not candidates

- **RotateLayer**: `_phaseSlot`, `_startSlot`, `_endSlot` — binding-only; no user scrub value makes sense
- **WarpLayer**: point handle slots (Point type) — spatial, not scalar
- **SelectLayer**, **FlashLayer**, **MaskLayer**: Event/Image/Mask slots only
- **MathLayer** `_slotA`/`_slotB`: noted above as useful if you want MathLayer to work without requiring an upstream AmountLayer

---

## Type observations

- **Direction/Angle slots** appear in ShapeLayer, TextLayer, ImageLayer, ClipLayer, LineLayer,
  DirectionLayer — all currently overlay-handle-only. SliderSlot already supports Direction
  (used in NoiseLayer's `_driftSlot`). Rotation in degrees 0–360 maps naturally to [0,1].
- **Rate** (TempoLayer, PointLayer's speed) — SliderSlot already handles Rate (PointLayer).
  TempoLayer's `_rateSlider` uses a log Hz scale internally; an Amount binding would need the
  same `sliderToHz` conversion.
- **TraceLayer** is the largest untouched cluster: 6 bespoke SliderRegion controls with no
  binding slots at all.
