import { describe, expect, it } from 'vitest'
import { defaultDocumentFilename, isMimeCompatibleWithHeader, isSupportedDocumentMime, mediaLimitBytes, validateMediaUpload } from '../../src/domain/media.ts'

describe('WhatsApp media policy', () => {
  it('uses AWS decimal size limits per MIME family', () => {
    expect(mediaLimitBytes('application/pdf')).toBe(100_000_000)
    expect(mediaLimitBytes('image/jpeg')).toBe(5_000_000)
    expect(mediaLimitBytes('audio/mpeg')).toBe(16_000_000)
    expect(mediaLimitBytes('video/mp4')).toBe(16_000_000)
    expect(mediaLimitBytes('image/webp')).toBe(100_000)
    expect(mediaLimitBytes('application/octet-stream')).toBeUndefined()
  })
  it('accepts exact limits and rejects one byte over and empty uploads', () => {
    for (const [mime, limit] of [['application/pdf', 100_000_000], ['image/jpeg', 5_000_000], ['audio/mpeg', 16_000_000], ['video/mp4', 16_000_000]] as const) {
      expect(validateMediaUpload(mime, new Uint8Array(limit))).toBeNull()
      expect(validateMediaUpload(mime, new Uint8Array(limit + 1))).toMatch(/limit/)
    }
    expect(validateMediaUpload('application/pdf', new Uint8Array())).toMatch(/empty/i)
    expect(validateMediaUpload('application/x-unknown', Uint8Array.of(1))).toMatch(/unsupported/i)
    const animatedWebp = new Uint8Array(21); animatedWebp.set(new TextEncoder().encode('RIFF')); animatedWebp.set(new TextEncoder().encode('WEBPVP8X'), 8); animatedWebp[16] = 10; animatedWebp[20] = 2
    expect(mediaLimitBytes('image/webp', animatedWebp)).toBe(500_000)
    expect(validateMediaUpload('image/webp', new Uint8Array(100_000))).toBeNull()
    expect(validateMediaUpload('image/webp', new Uint8Array(100_001))).toMatch(/limit/)
    const animatedAtLimit = new Uint8Array(500_000); animatedAtLimit.set(animatedWebp.subarray(0, 21)); expect(validateMediaUpload('image/webp', animatedAtLimit)).toBeNull()
    const animatedOverLimit = new Uint8Array(500_001); animatedOverLimit.set(animatedWebp.subarray(0, 21)); expect(validateMediaUpload('image/webp', animatedOverLimit)).toMatch(/limit/)
  })
  it('matches document, image and video header formats to supported MIME values', () => {
    expect(isSupportedDocumentMime('application/pdf')).toBe(true)
    expect(isMimeCompatibleWithHeader('DOCUMENT', 'application/pdf')).toBe(true)
    expect(isMimeCompatibleWithHeader('DOCUMENT', 'image/jpeg')).toBe(false)
    expect(isMimeCompatibleWithHeader('IMAGE', 'image/png')).toBe(true)
    expect(isMimeCompatibleWithHeader('VIDEO', 'video/mp4')).toBe(true)
    expect(isMimeCompatibleWithHeader('AUDIO', 'audio/mpeg')).toBe(true)
    expect(isMimeCompatibleWithHeader('VIDEO', 'video/3gp')).toBe(true)
    expect(defaultDocumentFilename('application/pdf')).toBe('document.pdf')
    expect(defaultDocumentFilename('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('document.docx')
  })
})
