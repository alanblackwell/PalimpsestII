// PalimpsestII — entry point
// The application shell will be built here.
// For now this just confirms the canvas context is available.

const app = document.getElementById('app')!
const canvas = document.createElement('canvas')
canvas.width  = window.innerWidth
canvas.height = window.innerHeight
app.appendChild(canvas)

const ctx = canvas.getContext('2d')!
ctx.fillStyle = '#444'
ctx.fillRect(0, 0, canvas.width, canvas.height)
ctx.fillStyle = '#fff'
ctx.font = '16px monospace'
ctx.fillText('PalimpsestII', 20, 40)

window.addEventListener('resize', () => {
  canvas.width  = window.innerWidth
  canvas.height = window.innerHeight
})
