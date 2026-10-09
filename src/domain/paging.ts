import { invalid } from '../smithy/errors.ts'

export function paginate<T>(items: T[], nextToken: string | undefined, maxResults = 100): { items: T[]; nextToken?: string } {
  let offset = 0
  if (nextToken) {
    try { offset = JSON.parse(Buffer.from(nextToken, 'base64url').toString('utf8')).o } catch { offset = Number.NaN }
    if (!Number.isInteger(offset) || offset < 0) throw invalid('nextToken is invalid')
  }
  const end = offset + maxResults
  return { items: items.slice(offset, end), nextToken: end < items.length ? Buffer.from(JSON.stringify({ o: end })).toString('base64url') : undefined }
}
