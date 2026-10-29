import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AccountError, CLAUDE_PROVIDER, createAccountPool } from './accounts.ts'
import { seedSetupToken } from './setup-token.ts'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function pool(now?: () => number) {
  const root = await mkdtemp(join(tmpdir(), 'claude-accounts-'))
  directories.push(root)
  const primaryPath = join(root, '.auth.json')
  await seedSetupToken(primaryPath, 'sk-ant-oat-first')
  const options = { primaryPath, dir: join(root, 'claude-accounts'), now }
  return { options, primaryPath, accounts: await createAccountPool(options) }
}

const token = async (accounts: Awaited<ReturnType<typeof createAccountPool>>) => {
  const credential = await accounts.store.read(CLAUDE_PROVIDER)
  return credential?.type === 'oauth' ? credential.access : undefined
}

it('keeps added accounts in their own private files across a restart, and only those can be removed', async () => {
  const { options, primaryPath, accounts } = await pool()
  const added = await accounts.add('Team 2', 'sk-ant-oat-second')
  await expect(accounts.add('Again', 'sk-ant-oat-second')).rejects.toThrow(new AccountError('duplicate'))
  await expect(accounts.add('Bad', 'not-a-token')).rejects.toThrow(new AccountError('invalid-token'))
  await expect(accounts.remove('primary')).rejects.toThrow(new AccountError('not-removable'))
  expect(await readFile(primaryPath, 'utf8')).not.toContain('sk-ant-oat-second')
  const [file] = await readdir(options.dir)
  expect((await stat(join(options.dir, file))).mode & 0o777).toBe(0o600)

  const restarted = await createAccountPool(options)
  expect((await restarted.list()).map(({ label, hint }) => ({ label, hint }))).toEqual([
    { label: 'Configured account', hint: 'irst' }, { label: 'Team 2', hint: 'cond' }
  ])
  await restarted.remove(added.id)
  expect((await (await createAccountPool(options)).list()).map((account) => account.label)).toEqual(['Configured account'])
})

it('parks a burst briefly, a plan limit until its reset, and skips a token Claude refuses', async () => {
  let clock = Date.parse('2026-10-28T12:00:00Z')
  const { accounts } = await pool(() => clock)
  await accounts.add('Second', 'sk-ant-oat-second')
  await accounts.add('Third', 'sk-ant-oat-third')

  expect(await token(accounts)).toBe('sk-ant-oat-first')
  accounts.responded(accounts.current(), 429, {})
  expect(await token(accounts)).toBe('sk-ant-oat-second')
  clock += 61_000
  // the first is free again, but the pool stays on the account that works
  expect(await token(accounts)).toBe('sk-ant-oat-second')

  const reset = clock / 1000 + 5 * 3600
  accounts.responded(accounts.current(), 429, {
    'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(reset)
  })
  expect(await token(accounts)).toBe('sk-ant-oat-first')
  accounts.responded(accounts.current(), 401, {})
  expect(await token(accounts)).toBe('sk-ant-oat-third')
  accounts.responded(accounts.current(), 429, { 'anthropic-ratelimit-unified-7d-utilization': '1.0', 'anthropic-ratelimit-unified-7d-reset': String(reset + 3600) })
  expect(accounts.blockedUntil()).toBe(reset * 1000)
  expect((await accounts.list()).map((account) => account.state)).toEqual(['rejected', 'limited', 'limited'])
})
