// Copy PDF.js into public/pdfjs, served as static assets beside the Worker. The library is
// public code; evidence never goes near these files.
import { cpSync, mkdirSync, rmSync } from 'node:fs'
const from = 'node_modules/pdfjs-dist', to = 'public/pdfjs'
rmSync(to, { recursive: true, force: true }); mkdirSync(to, { recursive: true })
for (const f of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'LICENSE']) cpSync(`${from}/${f}`, `${to}/${f.split('/').pop()}`)
for (const d of ['wasm', 'cmaps', 'standard_fonts']) cpSync(`${from}/${d}`, `${to}/${d}`, { recursive: true })
console.log('pdf.js copied to', to)
