export interface Clock { now(): number; schedule(ms: number, fn: () => void | Promise<void>): void; cancelAll(): void }

export class RealClock implements Clock {
  private timers = new Set<ReturnType<typeof setTimeout>>()
  now(): number { return Date.now() }
  schedule(ms: number, fn: () => void | Promise<void>): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      Promise.resolve().then(fn).catch((error) => console.error('eum-local: scheduled task failed', error))
    }, ms)
    this.timers.add(timer)
  }
  cancelAll(): void { for (const timer of this.timers) clearTimeout(timer); this.timers.clear() }
}

interface Task { at: number; seq: number; fn: () => void | Promise<void> }
export class FakeClock implements Clock {
  private t: number
  private seq = 0
  private tasks: Task[] = []
  constructor(start = Date.UTC(2026, 9, 7, 10, 0, 0)) { this.t = start }
  now(): number { return this.t }
  schedule(ms: number, fn: () => void | Promise<void>): void { this.tasks.push({ at: this.t + Math.max(0, ms), seq: this.seq++, fn }) }
  cancelAll(): void { this.tasks = [] }
  pending(): number { return this.tasks.length }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    for (;;) {
      this.tasks.sort((a, b) => a.at - b.at || a.seq - b.seq)
      const next = this.tasks[0]
      if (!next || next.at > end) break
      this.tasks.shift()
      this.t = next.at
      await next.fn()
    }
    this.t = end
  }
}
