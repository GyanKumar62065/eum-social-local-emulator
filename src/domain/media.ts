const DOCUMENT_MIME = new Set([
  'text/plain',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])
const IMAGE_MIME = new Set(['image/jpeg', 'image/png'])
const AUDIO_MIME = new Set(['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'])
const VIDEO_MIME = new Set(['video/mp4', 'video/3gp', 'video/3gpp'])
const LIMITS: Record<string, number> = {
  ...Object.fromEntries([...DOCUMENT_MIME].map((mime) => [mime, 100_000_000])),
  ...Object.fromEntries([...IMAGE_MIME].map((mime) => [mime, 5_000_000])),
  ...Object.fromEntries([...AUDIO_MIME].map((mime) => [mime, 16_000_000])),
  ...Object.fromEntries([...VIDEO_MIME].map((mime) => [mime, 16_000_000])),
}

function isAnimatedWebp(bytes?: Uint8Array): boolean {
  if (!bytes) return false
  for (let i = 12; i + 8 < bytes.length;) {
    const chunk = String.fromCharCode(...bytes.subarray(i, i + 4))
    const length = bytes[i + 4]! | (bytes[i + 5]! << 8) | (bytes[i + 6]! << 16) | (bytes[i + 7]! << 24)
    if (chunk === 'VP8X') return (bytes[i + 8]! & 0x02) !== 0
    if (length < 0 || i + 8 + length > bytes.length) break
    i += 8 + length + (length & 1)
  }
  return false
}

export function mediaLimitBytes(mimeType: string, bytes?: Uint8Array): number | undefined {
  const mime = mimeType.split(';', 1)[0]!.trim().toLowerCase()
  if (mime === 'image/webp') return isAnimatedWebp(bytes) ? 500_000 : 100_000
  return LIMITS[mime]
}
export function isSupportedDocumentMime(mimeType: string): boolean {
  return DOCUMENT_MIME.has(mimeType.split(';', 1)[0]!.trim().toLowerCase())
}
export function defaultDocumentFilename(mimeType: string): string {
  const mime = mimeType.split(';', 1)[0]!.trim().toLowerCase()
  const extensions: Record<string, string> = {
    'text/plain': '.txt', 'application/pdf': '.pdf', 'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-powerpoint': '.ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  }
  return `document${extensions[mime] ?? ''}`
}
export function isMimeCompatibleWithHeader(format: string, mimeType: string): boolean {
  const mime = mimeType.split(';', 1)[0]!.trim().toLowerCase()
  switch (format.toUpperCase()) {
    case 'DOCUMENT': return isSupportedDocumentMime(mime)
    case 'IMAGE': return IMAGE_MIME.has(mime)
    case 'VIDEO': return VIDEO_MIME.has(mime)
    case 'AUDIO': return AUDIO_MIME.has(mime)
    case 'STICKER': return mime === 'image/webp'
    case 'TEXT': return mime.startsWith('text/')
    default: return false
  }
}
export function validateMediaUpload(mimeType: string, bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return 'Media upload cannot be empty'
  const limit = mediaLimitBytes(mimeType, bytes)
  if (limit === undefined) return `Unsupported WhatsApp media MIME type ${mimeType}`
  if (bytes.byteLength > limit) return `Media is ${bytes.byteLength} bytes; ${mimeType} limit is ${limit} bytes`
  return null
}
