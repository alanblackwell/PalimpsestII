// Backward-compat re-export — all code now lives in TempoLayer.ts.
export {
  TempoLayer as RateLayer,
  sliderToHz, hzToSlider,
  hzToBpm, bpmToHz, tempoMarking,
  MIN_RATE, MAX_RATE,
} from './TempoLayer.js'
