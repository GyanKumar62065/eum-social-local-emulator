export const WINDOW_MS = 24 * 60 * 60 * 1000
// Free-form messages can be sent only within 24 hours of the customer's last message.
export const windowOpen = (lastInboundAt: number | undefined, now: number): boolean => lastInboundAt !== undefined && now - lastInboundAt < WINDOW_MS
