// Polls the service's in-memory status every five seconds while the page is visible; its only writes add and
// remove Claude accounts.
const POLL_MS = 5000
const STALE_MS = 15000
const $ = (id) => document.getElementById(id)

let last = null
let lastAt = 0
let clockOffset = 0
let timer = null
let signedOut = false

const time = (iso) => iso === null ? '—' : new Date(iso).toLocaleString()
const count = (n) => typeof n === 'number' ? n.toLocaleString() : '—'
const compact = (n) => typeof n === 'number' ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : '—'
const session = (percent) => `${percent < 1 ? percent.toFixed(1) : Math.round(percent)}%`
const usd = (n) => typeof n === 'number' ? `$${n.toFixed(2)}` : '—'
const shortWallet = (wallet) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`
// running turns have not reported their tokens yet, so averages count finished turns only
const perPrompt = (total, finished) => finished > 0 ? total / finished : null
// Claude counts cached prompt text apart from input; all of it is text the model read
const read = (usage) => usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function bar(percent) {
  const track = el('div', 'bar')
  if (percent >= 100) track.classList.add('full')
  else if (percent >= 80) track.classList.add('warn')
  const fill = el('span')
  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`
  track.append(fill)
  return track
}

// elapsed stops at the last update once the data is no longer live, so it never claims a turn is still running
function elapsed(iso) {
  const at = $('state').dataset.state === 'live' ? Date.now() : lastAt
  const s = Math.floor(Math.max(0, at + clockOffset - Date.parse(iso)) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function list(id, rows) {
  $(id).replaceChildren(...rows.map(([term, value]) => {
    const div = el('div')
    div.append(el('dt', '', term), el('dd', '', value))
    return div
  }))
}

function rows(id, columns, items, empty) {
  if (items.length === 0) {
    const cell = el('td', 'empty', empty)
    cell.colSpan = columns
    const row = el('tr')
    row.append(cell)
    $(id).replaceChildren(row)
    return
  }
  $(id).replaceChildren(...items.map((cells) => {
    const row = el('tr')
    for (const cell of cells) row.append(cell)
    return row
  }))
}

function setState(state, text) {
  const pill = $('state')
  pill.dataset.state = state
  pill.textContent = text
  $('signin').hidden = state !== 'signin'
  document.body.classList.toggle('stale', state !== 'live' && state !== 'loading')
}

function renderTurns() {
  if (last === null) return
  rows('turns', 4, last.turns.map((turn) => {
    const id = el('td', 'mono', turn.id.slice(0, 8))
    id.title = turn.id
    return [id, el('td', '', turn.model ?? 'resolving…'), el('td', '', time(turn.startedAt)), el('td', 'num', elapsed(turn.startedAt))]
  }), 'No turn is running.')
}

const WINDOW_NAMES = { five_hour: 'Session (5 hours)', seven_day: 'Week', seven_day_opus: 'Week · Opus', seven_day_sonnet: 'Week · Sonnet' }
const QUOTA_NOTES = {
  disabled: 'The assistant is not configured on this service.',
  unavailable: 'Appears with the next Claude reply.',
  ok: 'Shared by everything signed in to the Claude account, not only this service.'
}

function renderQuota(quota) {
  const meters = quota.windows.map((window) => {
    const meter = el('div', 'meter')
    const head = el('div', 'meter-head')
    head.append(el('span', 'meter-name', WINDOW_NAMES[window.name] ?? window.name.replaceAll('_', ' ')), el('span', 'meter-value', `${window.percent}%`))
    meter.append(head, bar(window.percent), el('span', 'hint', window.resetsAt === null ? 'Reset time unknown' : `Resets ${time(window.resetsAt)}`))
    return meter
  })
  $('quota').replaceChildren(...meters)
  $('quota').hidden = meters.length === 0
  const checked = quota.checkedAt === null ? '' : ` Last read ${time(quota.checkedAt)}.`
  $('quota-note').textContent = `${QUOTA_NOTES[quota.state] ?? quota.state}${checked}${quota.stale ? ' No reply since, so it may be out of date.' : ''}`
}

const ACCOUNT_STATES = { active: 'In use', ready: 'Ready', limited: 'At its limit', rejected: 'Token refused', 'signed-out': 'Not signed in' }
let confirming = null

function windowPercent(quota, name) {
  const window = quota.windows.find((entry) => entry.name === name)
  return window === undefined ? '—' : `${window.percent}%`
}

async function removeAccount(id) {
  const response = await fetch(`api/accounts/${id}`, { method: 'DELETE', credentials: 'same-origin' })
  confirming = null
  if (!response.ok) message(`Could not remove it (${(await response.json().catch(() => ({}))).error ?? response.status}).`, 'error')
  await poll()
}

function renderAccounts(accounts) {
  // no assistant credential, no account pool to add to
  $('add-account').hidden = last.quota.state === 'disabled'
  rows('accounts', 7, accounts.map((account) => {
    const limited = account.limitedUntil === null ? '' : ` · until ${time(account.limitedUntil)}`
    const state = el('td', 'state', `${ACCOUNT_STATES[account.state] ?? account.state}${limited}`)
    state.dataset.state = account.state
    if (account.limitedUntil !== null) state.title = `Until ${time(account.limitedUntil)}`
    const actions = el('td', 'num')
    if (account.removable) {
      const button = el('button', 'btn quiet', confirming === account.id ? 'Confirm' : 'Remove')
      button.type = 'button'
      button.addEventListener('click', () => {
        if (confirming !== account.id) { confirming = account.id; renderAccounts(last.accounts); return }
        button.disabled = true
        void removeAccount(account.id)
      })
      actions.append(button)
    }
    return [
      el('td', '', account.label), state, el('td', 'num', windowPercent(account.quota, 'five_hour')), el('td', 'num', windowPercent(account.quota, 'seven_day')),
      el('td', 'mono', account.hint === null ? '—' : `…${account.hint}`), el('td', '', account.addedAt === null ? 'configured' : time(account.addedAt)), actions
    ]
  }), 'No Claude account is configured.')
}

function message(text, tone) {
  const note = $('account-message')
  note.textContent = text
  note.dataset.tone = tone ?? ''
}

const ADD_ERRORS = {
  'invalid-token': 'That is not a token from claude setup-token.', 'invalid-label': 'Give it a name of up to 60 characters.',
  duplicate: 'That token is already added.', 'too-many': 'Remove an account before adding another.', 'rate-limited': 'Too many changes; wait a minute.'
}

$('add-account').addEventListener('submit', async (event) => {
  event.preventDefault()
  const button = event.target.querySelector('button')
  button.disabled = true
  message('Adding…')
  try {
    const response = await fetch('api/accounts', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: $('account-label').value, token: $('account-token').value })
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) { message(ADD_ERRORS[body.error] ?? `Could not add it (${body.error ?? response.status}).`, 'error'); return }
    $('account-token').value = ''
    $('account-label').value = ''
    message(`Added "${body.account.label}". It is checked on the first reply it serves.`)
    await poll()
  } catch {
    message('Could not reach the service.', 'error')
  } finally {
    button.disabled = false
  }
})

function allowanceCell(percent) {
  const cell = el('td')
  if (typeof percent !== 'number') { cell.textContent = '—'; return cell }
  cell.append(bar(percent), el('span', '', `${percent}%`))
  return cell
}

const mb = (bytes) => typeof bytes === 'number' ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '—'

function renderPool(pool) {
  $('pool-card').hidden = pool === null
  if (pool === null) return
  const wallet = (address) => {
    const cell = el('td', 'mono', shortWallet(address))
    cell.title = address
    return cell
  }
  rows('pool-names', 5, pool.names.map((name) => [
    el('td', 'mono', name.name), el('td', 'num', `${count(name.leases)} / ${count(pool.limits.leasesPerName)}`),
    el('td', 'num', name.whitelisted ? `${mb(name.usedSpace)} · exempt` : `${mb(name.usedSpace)} / ${mb(name.allowedSpace)}`),
    el('td', '', name.canDeploy === null ? '—' : name.canDeploy ? 'Yes' : 'Not granted'), name.owner === null ? el('td', '', '—') : wallet(name.owner)
  ]), 'No pool NAMEs.')
  rows('pool-leases', 5, pool.leases.map((lease) => [
    wallet(lease.wallet), el('td', 'mono', `${lease.name} ${lease.zone.x},${lease.zone.y}`),
    el('td', '', lease.scene?.title || (lease.scene === null ? 'No scene yet' : '—')), el('td', 'num', mb(lease.scene?.bytes)),
    el('td', '', time(lease.scene?.publishedAt ?? lease.leasedAt))
  ]), 'Nobody holds a shared world.')
  list('pool-service', [
    ['Pool wallet', pool.signer], ['Worlds server', pool.worldsContent], ['Uploads pending', `${count(pool.pending)} / ${count(pool.limits.pendingDeploys)}`],
    ['Largest scene', mb(pool.limits.maxSceneBytes)], ['Blocked wallets', pool.blocked.length === 0 ? 'None' : pool.blocked.map((b) => `${shortWallet(b.wallet)}: ${b.reason}`).join('; ')]
  ])
}

function render(status) {
  const usage = status.sinceStart.usage
  $('sessions').textContent = count(status.sessions)
  $('running').textContent = count(status.turns.length)
  $('prompts').textContent = count(usage.prompts)
  $('tokens').textContent = compact(usage.inputTokens + usage.outputTokens)
  const tokens = read(usage) + usage.outputTokens
  const average = perPrompt(tokens, usage.finishedTurns)
  const rate = status.quota.sessionPercentPerUsd
  const costPerPrompt = perPrompt(usage.estimatedCostUsd, usage.finishedTurns)
  const perPromptSession = rate === null || costPerPrompt === null ? null : costPerPrompt * rate
  $('prompts-hint').textContent = perPromptSession === null ? 'since the service started' : `≈ ${session(perPromptSession)} of a session each`
  $('tokens-hint').textContent = usage.incompleteTurns > 0 ? `${usage.incompleteTurns} turns without usage` : 'read + written, cache included'
  $('usage-note').textContent = rate === null
    ? 'Session % appears once the Claude plan reading has moved with this service\'s use.'
    : 'Session % is estimated from how the plan\'s 5-hour reading moved with this service\'s use; other use of the account inflates it.'
  renderTurns()
  renderQuota(status.quota)
  renderAccounts(status.accounts)

  rows('users', 10, status.users.map((user) => {
    const wallet = el('td', 'mono', shortWallet(user.wallet))
    wallet.title = user.wallet
    return [
      wallet, el('td', 'num', count(user.prompts)), el('td', 'num', compact(read(user))), el('td', 'num', compact(user.outputTokens)),
      el('td', 'num', rate === null ? '—' : `≈ ${session(user.estimatedCostUsd * rate)}`),
      el('td', 'num', usd(user.estimatedCostUsd)), allowanceCell(user.allowance?.dailyPercent), allowanceCell(user.allowance?.weeklyPercent),
      el('td', 'num', count(user.running)), el('td', '', time(user.lastActiveAt))
    ]
  }), 'Nobody has used the assistant since the service started.')

  list('usage', [
    ['Prompts', count(usage.prompts)], ['Input tokens', count(usage.inputTokens)], ['Output tokens', count(usage.outputTokens)],
    ['Cache reads', count(usage.cacheReadTokens)], ['Cache writes', count(usage.cacheWriteTokens)],
    ['Est. API cost', `${usd(usage.estimatedCostUsd)} (not the plan's bill)`],
    ['Tokens per prompt', compact(average)],
    ['Session per prompt', perPromptSession === null ? '—' : `≈ ${session(perPromptSession)}`]
  ])

  const t = status.sinceStart.turns
  const r = status.sinceStart.rejected
  list('since', [
    ['Completed', count(t.completed)], ['Failed', count(t.failed)], ['Cancelled', count(t.cancelled)],
    ['Disconnected', count(t.disconnected)], ['Timed out', count(t.timed_out)],
    ['Refused', count(r.invalid + r.busy + r.limited + r.allowance + r.unavailable)]
  ])

  const tel = status.telemetry
  list('service', [
    ['Service started', time(status.startedAt)], ['Version', status.version ?? '—'], ['Last update', time(status.now)],
    ['Telemetry', tel.enabled ? 'Segment' : 'Off'], ['Queued events', count(tel.queued)], ['Delivered', count(tel.delivered)],
    ['Failed attempts', count(tel.failedAttempts)], ['Dropped events', count(tel.dropped)],
    ['Last delivery', time(tel.lastDeliveryAt)], ['Last failure', tel.lastFailure === null ? '—' : `${tel.lastFailure} · ${time(tel.lastFailureAt)}`]
  ])

  renderPool(status.pool)

  const history = $('history')
  history.hidden = status.historyUrl === null
  if (status.historyUrl !== null) history.href = status.historyUrl
}

async function poll() {
  try {
    // An expired Access session answers with a redirect to the sign-in page, not with this API.
    const response = await fetch('api/status', { credentials: 'same-origin', cache: 'no-store', redirect: 'manual' })
    const type = response.headers.get('content-type') ?? ''
    if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403 || (response.ok && !type.includes('application/json'))) {
      signedOut = true
      setState('signin', 'Signed out — showing the last update')
      stop()
      return
    }
    if (!response.ok) throw new Error(String(response.status))
    const status = await response.json()
    last = status
    lastAt = Date.now()
    clockOffset = Date.parse(status.now) - Date.now()
    setState('live', 'Live')
    render(status)
  } catch {
    if (last === null) setState('disconnected', 'Cannot reach the service')
    else setState('disconnected', `Disconnected — last update ${time(new Date(lastAt).toISOString())}`)
  }
}

function tick() {
  if (last !== null && !signedOut && Date.now() - lastAt > STALE_MS && $('state').dataset.state === 'live') {
    setState('stale', `Stale — last update ${time(new Date(lastAt).toISOString())}`)
  }
  renderTurns()
}

function start() {
  if (timer !== null || signedOut) return
  void poll()
  timer = setInterval(() => { void poll() }, POLL_MS)
}

function stop() {
  if (timer !== null) clearInterval(timer)
  timer = null
}

document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start() })
$('signin').addEventListener('click', () => { location.reload() })
setInterval(tick, 1000)
if (!document.hidden) start()
