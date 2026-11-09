// Copy PDF.js into public/pdfjs, served as static assets beside the Worker. The library is
// public code; evidence never goes near these files.
import { cpSync, mkdirSync, rmSync } from 'node:fs'
const from = 'node_modules/pdfjs-dist', to = 'public/pdfjs'
rmSync(to, { recursive: true, force: true }); mkdirSync(to, { recursive: true })
// The legacy build: the same library transpiled with polyfills, so a reviewer on a browser a few
// years old (no Uint8Array.toHex, for one) can still read evidence.
for (const f of ['legacy/build/pdf.min.mjs', 'legacy/build/pdf.worker.min.mjs', 'LICENSE']) cpSync(`${from}/${f}`, `${to}/${f.split('/').pop()}`)
for (const d of ['wasm', 'cmaps', 'standard_fonts']) cpSync(`${from}/${d}`, `${to}/${d}`, { recursive: true })
console.log('pdf.js copied to', to)
