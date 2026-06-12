import type { Colour } from './types.js'

// ------------------------------------------------------------
// Random colour generation
// ------------------------------------------------------------
//
// Random colour across the full hue range, avoiding near-black and near-white.
// Saturation 0.25–1.0 (allows pastels but not grey); value 0.30–0.82.

export function rndColour(): Colour {
  const h = Math.random() * 360
  const s = 0.25 + Math.random() * 0.75
  const v = 0.30 + Math.random() * 0.52
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
