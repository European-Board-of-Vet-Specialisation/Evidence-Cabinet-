// What the cabinet accepts: PDF, PNG and JPEG, judged by the file's own bytes, never by its
// name or the browser's label. A renamed file is what its bytes say it is.

export type Kind = 'pdf' | 'png' | 'jpeg'
export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_FILES = 10
export const MAX_STATEMENT = 20_000
/** Per case: submissions, and bytes of documents across all of them. */
export const MAX_VERSIONS = 20
export const MAX_CASE_BYTES = 200 * 1024 * 1024

export function sniff(head: Uint8Array): Kind | null {
  const at = (sig: number[], off = 0) => sig.every((b, i) => head[off + i] === b)
  if (at([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'                         // %PDF-
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (at([0xff, 0xd8, 0xff])) return 'jpeg'
  return null
}

export const CONTENT_TYPE: Record<Kind, string> = { pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg' }

export type FileCheck = { ok: true; kind: Kind } | { ok: false; error: string }

export function checkFile(bytes: Uint8Array): FileCheck {
  if (!bytes.length) return { ok: false, error: 'is empty' }
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: `is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` }
  const kind = sniff(bytes.subarray(0, 16))
  if (!kind) return { ok: false, error: 'is not a PDF, PNG or JPEG' }
  // A PDF must also end like one: a truncated upload is refused, not stored half.
  if (kind === 'pdf' && !new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 1024))).includes('%%EOF')) return { ok: false, error: 'is an incomplete PDF' }
  return { ok: true, kind }
}
