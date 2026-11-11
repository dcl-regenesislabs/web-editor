import { describe, expect, it } from 'vitest'
import { swallowedRequests } from './swallowed-requests'

const IMPORT = "import { game } from './runtime/game'\n"

function scan(body: string) {
  return swallowedRequests(`${IMPORT}${body}`)
}

describe('a game.request whose refusal is dropped', () => {
  it('reads the generic, the .then and the .catch that only resets a flag', () => {
    expect(
      scan(`game.request<{ ok: boolean }>('use', { s }).then((r) => { busy = false; play('ok') }).catch(() => { busy = false })`)
    ).toEqual([{ name: 'use', form: 'catch' }])
  })

  it('an empty arrow, an expression body and an empty function all drop it', () => {
    expect(scan(`game.request('a').catch(() => {})`)).toHaveLength(1)
    expect(scan(`game.request('a').catch(() => (busy = false))`)).toHaveLength(1)
    expect(scan(`game.request('a').catch(async function () {})`)).toHaveLength(1)
    expect(scan(`game.request('a').catch((_e: unknown): void => { if (busy) busy = false })`)).toHaveLength(1)
  })

  it('a call, a throw or a read of the error counts as handling it', () => {
    expect(scan(`game.request('a').catch((e) => { busy = false; showToast(msg('busy')) })`)).toEqual([])
    expect(scan(`game.request('a').catch(() => console.warn('refused'))`)).toEqual([])
    expect(scan(`game.request('a').catch((e) => { throw e })`)).toEqual([])
    expect(scan(`game.request('a').catch((e) => { lastError = e })`)).toEqual([])
    expect(scan(`game.request('a').catch(retryLater)`)).toEqual([])
    expect(scan(`game.request('a').catch(this.onRefused)`)).toEqual([])
  })

  it('a string or a comment that looks like a call is not one', () => {
    expect(scan(`game.request('a').catch(() => { status = 'retry()' /* log(e) */ })`)).toHaveLength(1)
  })

  it('reads a try around an awaited request', () => {
    expect(scan(`async function f() { try { await game.request('a') } catch { busy = false } }`)).toEqual([
      { name: 'a', form: 'try' }
    ])
    expect(scan(`async function f() { try { await game.request('a') } catch (e) { console.error(e) } }`)).toEqual([])
    // not awaited: the catch never sees the rejection
    expect(scan(`function f() { try { void game.request('a') } catch {} }`)).toEqual([])
    // the inner try is the one that catches it
    expect(
      scan(`async function f() { try { try { await game.request('a') } catch (e) { toast(e) } } catch {} }`)
    ).toEqual([])
  })

  it('says nothing without the game import, or for an unchained request', () => {
    expect(swallowedRequests(`game.request('a').catch(() => {})`)).toEqual([])
    expect(scan(`const answer = await game.request('a')`)).toEqual([])
  })
})
