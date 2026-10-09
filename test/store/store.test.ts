import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../../src/config.ts'
import { phoneAwsId, resolveId, wabaAwsId, wabaArn, msisdn, metaNumericId, newWamid } from '../../src/domain/ids.ts'
import { paginate } from '../../src/domain/paging.ts'
import { openDb, resetDb } from '../../src/store/db.ts'
import { insertMessage, lastInboundAt, listMessages, statusHistory, updateMessageStatus } from '../../src/store/messages.ts'
import { createWaba, seedFromConfig } from '../../src/store/seed.ts'
import { findTemplate } from '../../src/store/templates.ts'
import { deleteWaba, getPhone, getWaba, listWabas } from '../../src/store/wabas.ts'

const CONFIG = parseConfig('wabas:\n  - name: Test\n    metaWabaId: "100000000000001"\n    eventDestinations: [arn:aws:sns:ap-south-1:000000000000:t]\n    phoneNumbers:\n      - phoneNumber: "+919800000001"\n        displayName: Test\n        metaPhoneNumberId: "200000000000001"\n    templates:\n      - name: hello\n        language: en\n        category: utility\n        components: [{ type: BODY, text: "Hi {{1}}" }]\n', {})

describe('ids', () => {
  it('derives stable AWS ids from Meta ids', () => {
    expect(wabaAwsId('1')).toBe(wabaAwsId('1'))
    expect(wabaAwsId('1')).toMatch(/^waba-[0-9a-f]{32}$/)
    expect(phoneAwsId('2')).toMatch(/^phone-number-id-[0-9a-f]{32}$/)
  })

  it('round-trips ids through ARNs', () => {
    const id = wabaAwsId('1')
    const arn = wabaArn('ap-south-1', '000000000000', id)
    expect(arn).toMatch(/^arn:aws:social-messaging:ap-south-1:000000000000:waba\/[0-9a-f]{32}$/)
    expect(resolveId(arn, 'waba')).toBe(id)
    expect(resolveId(id, 'waba')).toBe(id)
  })

  it('normalises phone numbers and generates Meta-shaped ids', () => {
    expect(msisdn('91 98000-00001')).toBe('+919800000001')
    expect(msisdn('abc')).toBe('')
    expect(metaNumericId()).toMatch(/^[1-9]\d{14}$/)
    expect(newWamid()).toMatch(/^wamid\.[A-Za-z0-9]+$/)
  })
})

describe('paginate', () => {
  it('pages with opaque tokens and rejects garbage tokens', () => {
    const items = [1, 2, 3, 4, 5]
    const p1 = paginate(items, undefined, 2)
    expect(p1.items).toEqual([1, 2])
    const p2 = paginate(items, p1.nextToken, 2)
    expect(p2.items).toEqual([3, 4])
    expect(paginate(items, p2.nextToken, 2)).toEqual({ items: [5], nextToken: undefined })
    expect(() => paginate(items, 'garbage', 2)).toThrow(/nextToken/)
  })
})

describe('store', () => {
  it('seeds from config with derived ids and approved templates', () => {
    const db = openDb(':memory:')
    seedFromConfig(db, CONFIG, 1000)
    const waba = getWaba(db, wabaAwsId('100000000000001'))!
    expect(waba).toMatchObject({ name: 'Test', registrationStatus: 'COMPLETE', linkDate: 1000 })
    expect(waba.eventDestinations).toEqual([{ eventDestinationArn: 'arn:aws:sns:ap-south-1:000000000000:t' }])
    expect(getPhone(db, phoneAwsId('200000000000001'))).toMatchObject({ phoneNumber: '+919800000001', wabaId: waba.id })
    expect(findTemplate(db, waba.id, 'hello', 'en')).toMatchObject({ status: 'APPROVED', category: 'UTILITY' })
  })

  it('is idempotent across restarts with a file database (Review Focus 5)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'eum-')), 'db.sqlite')
    const db1 = openDb(path)
    seedFromConfig(db1, CONFIG, 1)
    db1.close()
    const db2 = openDb(path)
    seedFromConfig(db2, CONFIG, 2)
    expect(listWabas(db2)).toHaveLength(1)
    expect(listWabas(db2)[0].id).toBe(wabaAwsId('100000000000001'))
    db2.close()
  })

  it('tracks message status history and the last inbound time', () => {
    const db = openDb(':memory:')
    seedFromConfig(db, CONFIG, 0)
    const phoneNumberId = phoneAwsId('200000000000001')
    insertMessage(db, { wamid: 'w1', phoneNumberId, direction: 'out', peer: '+1', type: 'text', body: {}, status: 'accepted', createdAt: 10 })
    updateMessageStatus(db, 'w1', 'failed', { code: 131026, title: 'Message undeliverable' }, 20)
    expect(listMessages(db, {})[0]).toMatchObject({ status: 'failed', errorCode: 131026 })
    expect(statusHistory(db, 'w1').map((h) => h.status)).toEqual(['accepted', 'failed'])
    expect(lastInboundAt(db, phoneNumberId, '+1')).toBeUndefined()
    insertMessage(db, { wamid: 'w2', phoneNumberId, direction: 'in', peer: '+1', type: 'text', body: {}, status: 'received', createdAt: 30 })
    expect(lastInboundAt(db, phoneNumberId, '+1')).toBe(30)
  })

  it('cascades WABA deletion to phones and messages, and reset empties everything', () => {
    const db = openDb(':memory:')
    const waba = createWaba(db, CONFIG, CONFIG.wabas[0], 0)
    insertMessage(db, { wamid: 'w1', phoneNumberId: phoneAwsId('200000000000001'), direction: 'out', peer: '+1', type: 'text', body: {}, status: 'accepted', createdAt: 1 })
    deleteWaba(db, waba.id)
    expect(getPhone(db, phoneAwsId('200000000000001'))).toBeUndefined()
    expect(listMessages(db, {})).toEqual([])
    createWaba(db, CONFIG, CONFIG.wabas[0], 0)
    resetDb(db)
    expect(listWabas(db)).toEqual([])
  })
})
