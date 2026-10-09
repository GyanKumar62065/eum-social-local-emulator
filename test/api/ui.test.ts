import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from '../helpers.ts'
let h: Harness
beforeEach(async () => { h = await startHarness() })
afterEach(async () => { await h.close() })
describe('UI route', () => {
  it('redirects / to the inbox', async () => { const response = await fetch(`${h.url}/`, { redirect: 'manual' }); expect(response.status).toBe(302); expect(response.headers.get('location')).toBe('/_eum/ui/') })
  it('serves the built inbox, or explains how to build it', async () => {
    const response = await fetch(`${h.url}/_eum/ui/`); const text = await response.text()
    if (existsSync(new URL('../../ui/dist/index.html', import.meta.url))) expect(text).toContain('<div id="app">')
    else expect(text).toMatch(/bun run ui:build/)
  })
})
