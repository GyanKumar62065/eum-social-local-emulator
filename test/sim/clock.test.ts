import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../src/sim/clock.ts'

describe('FakeClock', () => {
  it('runs due tasks in time order and awaits async tasks', async () => {
    const clock = new FakeClock(1000)
    const seen: string[] = []
    clock.schedule(200, async () => { seen.push(`b@${clock.now()}`) })
    clock.schedule(100, () => { seen.push(`a@${clock.now()}`); clock.schedule(50, () => { seen.push(`c@${clock.now()}`) }) })
    clock.schedule(500, () => { seen.push('late') })
    await clock.advance(300)
    expect(seen).toEqual(['a@1100', 'c@1150', 'b@1200'])
    expect(clock.now()).toBe(1300)
    expect(clock.pending()).toBe(1)
    clock.cancelAll()
    await clock.advance(1000)
    expect(seen).not.toContain('late')
  })
})
