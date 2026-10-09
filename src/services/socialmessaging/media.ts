import { createHash } from 'node:crypto'
import type { Ctx, HandlerMap } from '../../context.ts'
import { metaNumericId } from '../../domain/ids.ts'
import { invalid, notFound } from '../../smithy/errors.ts'
import { deleteMedia, getMedia, insertMedia } from '../../store/media.ts'
import type { MediaRow } from '../../store/types.ts'
import { guessMime, readS3, writeS3 } from './s3io.ts'
import { requirePhone } from './waba.ts'

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024
const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
function requireS3Url(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw invalid('Presigned URL must be a valid Amazon S3 URL') }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.amazonaws.com') || !/(^|[.-])s3([.-]|$)/i.test(url.hostname)) throw invalid('Presigned URL must be a valid Amazon S3 URL')
  return url
}
async function readLimited(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (declaredLength > MAX_MEDIA_BYTES) throw invalid(`Media is ${declaredLength} bytes; the limit is ${MAX_MEDIA_BYTES}`)
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_MEDIA_BYTES) { await reader.cancel(); throw invalid(`Media is larger than the ${MAX_MEDIA_BYTES} byte limit`) }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
async function fetchSource(ctx: Ctx, input: any): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (input.sourceS3File && input.sourceS3PresignedUrl) throw invalid('Provide only one of sourceS3File or sourceS3PresignedUrl')
  if (input.sourceS3File) return readS3(ctx, input.sourceS3File)
  if (input.sourceS3PresignedUrl) {
    const url = requireS3Url(input.sourceS3PresignedUrl.url)
    let response: Response
    try { response = await fetch(url, { headers: input.sourceS3PresignedUrl.headers }) }
    catch (error) { throw invalid(`Could not fetch sourceS3PresignedUrl: ${reason(error)}`) }
    if (!response.ok) throw invalid(`sourceS3PresignedUrl returned HTTP ${response.status}`)
    return { bytes: await readLimited(response), mimeType: response.headers.get('content-type') ?? guessMime(url.pathname) }
  }
  throw invalid('Provide sourceS3File or sourceS3PresignedUrl')
}
function requireMedia(ctx: Ctx, phoneId: string, mediaId: string): MediaRow {
  const media = getMedia(ctx.db, mediaId)
  if (!media || media.ownerId !== phoneId) throw notFound(`Media ${mediaId}`)
  return media
}

export const mediaHandlers: HandlerMap = {
  async PostWhatsAppMessageMedia(input, ctx) {
    const { phone } = requirePhone(ctx, input.originationPhoneNumberId); const { bytes, mimeType } = await fetchSource(ctx, input)
    if (bytes.byteLength > MAX_MEDIA_BYTES) throw invalid(`Media is ${bytes.byteLength} bytes; the limit is ${MAX_MEDIA_BYTES}`)
    const mediaId = metaNumericId()
    insertMedia(ctx.db, { mediaId, ownerId: phone.id, mimeType, sha256: createHash('sha256').update(bytes).digest('base64'), bytes, createdAt: ctx.clock.now() })
    return { mediaId }
  },
  async GetWhatsAppMessageMedia(input, ctx) {
    const { phone } = requirePhone(ctx, input.originationPhoneNumberId); const media = requireMedia(ctx, phone.id, input.mediaId)
    if (!input.metadataOnly) {
      if (input.destinationS3File) await writeS3(ctx, input.destinationS3File, media.bytes, media.mimeType)
      else if (input.destinationS3PresignedUrl) {
        const url = requireS3Url(input.destinationS3PresignedUrl.url)
        let response: Response
        try { response = await fetch(url, { method: 'PUT', headers: input.destinationS3PresignedUrl.headers, body: Buffer.from(media.bytes) }) }
        catch (error) { throw invalid(`Could not upload to destinationS3PresignedUrl: ${reason(error)}`) }
        if (!response.ok) throw invalid(`destinationS3PresignedUrl returned HTTP ${response.status}`)
      } else throw invalid('Provide destinationS3File or destinationS3PresignedUrl, or set metadataOnly')
    }
    return { mimeType: media.mimeType, fileSize: media.bytes.byteLength }
  },
  DeleteWhatsAppMessageMedia(input, ctx) {
    const { phone } = requirePhone(ctx, input.originationPhoneNumberId); requireMedia(ctx, phone.id, input.mediaId); deleteMedia(ctx.db, input.mediaId); return { success: true }
  },
}
