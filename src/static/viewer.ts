// The evidence viewer, served at /static/viewer.js. Renders a PDF with PDF.js, or an image, onto
// canvases in the reviewer's browser, each page overlaid with the reviewer's name and the time.
// No download or print control is offered. A browser can always capture what it shows: the
// watermark and the view log make a leak traceable (spec §8).

export const VIEWER_JS = String.raw`import * as pdfjs from '/pdfjs/pdf.min.mjs'
pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs'
const root = document.getElementById('viewer'), status = document.getElementById('status')
const mark = root.dataset.mark
const say = t => { status.textContent = t }

function watermark(ctx, w, h) {
  ctx.save(); ctx.globalAlpha = 0.16; ctx.fillStyle = '#7a1f1f'
  const size = Math.max(14, Math.round(w / 34)); ctx.font = '600 ' + size + 'px system-ui, sans-serif'
  ctx.translate(w / 2, h / 2); ctx.rotate(-Math.PI / 6)
  const step = size * 5
  for (let y = -h; y < h; y += step) for (let x = -w; x < w; x += ctx.measureText(mark).width + size * 3) ctx.fillText(mark, x, y)
  ctx.restore()
}
function canvasFor(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  c.style.width = '100%'; c.style.maxWidth = Math.round(w / (window.devicePixelRatio || 1)) + 'px'
  c.style.display = 'block'; c.style.margin = '0 auto 16px'; c.style.boxShadow = '0 1px 4px rgba(0,0,0,.2)'
  root.appendChild(c); return c
}

async function main() {
  const res = await fetch(root.dataset.src, { headers: { 'X-Cabinet-Viewer': '1' }, credentials: 'same-origin', cache: 'no-store' })
  if (!res.ok) { say(res.status === 403 ? 'You no longer have access to this document.' : 'The document could not be opened.'); return }
  const kind = res.headers.get('Content-Type') || ''
  const data = new Uint8Array(await res.arrayBuffer())
  const scale = 1.5 * (window.devicePixelRatio || 1)
  if (kind === 'application/pdf') {
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, wasmUrl: '/pdfjs/wasm/', cMapUrl: '/pdfjs/cmaps/', standardFontDataUrl: '/pdfjs/standard_fonts/', enableXfa: false }).promise
    say(doc.numPages + ' page' + (doc.numPages === 1 ? '' : 's'))
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i), vp = p.getViewport({ scale })
      const c = canvasFor(Math.floor(vp.width), Math.floor(vp.height))
      await p.render({ canvas: c, viewport: vp, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise
      watermark(c.getContext('2d'), c.width, c.height)
    }
  } else {
    const img = await createImageBitmap(new Blob([data], { type: kind }))
    const c = canvasFor(img.width, img.height), ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0); watermark(ctx, c.width, c.height); say('')
  }
  // Blank our copy of the bytes. A PDF's buffer has already gone to the PDF.js worker.
  if (data.byteLength) data.fill(0)
}
document.addEventListener('contextmenu', e => { if (root.contains(e.target)) e.preventDefault() })
main().catch(e => { console.error('viewer:', e && e.name); say('The document could not be shown.') })`
