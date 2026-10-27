// Decentraland SDK skills (github.com/decentraland/sdk-skills) for the AI
// assistant. Downloaded at runtime into a userData cache (refreshed by commit
// SHA, offline-tolerant), then linked into the open scene as .claude/skills
// (Claude Code) and .agents/skills (Codex's native discovery path) so BOTH
// provider CLIs pick them up from their cwd. Skill content is trusted: it is
// first-party Decentraland guidance, and the assistant that reads it already
// runs with the shell and the network (see ai.ts), so this module treats the
// download as a plain content sync rather than something to sandbox.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const REPO = 'decentraland/sdk-skills'
const BRANCH = 'main'
const SHA_TIMEOUT_MS = 15_000
const TARBALL_TIMEOUT_MS = 90_000 // ~4MB over hotel/mobile links; the SHA call stays snappy

// Skills that fight the assistant's mandate (script-only authoring, no shell,
// acceptEdits headless flow): scaffolding/deploy walkthroughs are npx
// instructions it can't run, sdk-scenes mandates ask-the-user-first and
// composite-first workflows that contradict DCL_SYSTEM_PROMPT. A denylist so
// new upstream skills default IN. Denylisted skills ship their supporting
// files but NOT SKILL.md: without frontmatter they can never trigger, yet
// shipped skills' {baseDir}/../<name>/references/ paths still resolve (e.g.
// player-avatar and multiplayer-sync read sdk-scenes/references/).
const SKILL_DENYLIST = new Set(['create-scene', 'deploy-scene', 'deploy-worlds', 'migrate-sdk6-to-sdk7', 'sdk-scenes'])
// Upstream skills an editor skill replaces (the editor's own skills ship in
// packages/service/skills/). Treated like the denylist: references stay, since
// the replacement links to them.
const SUPERSEDED = new Set(['build-ui'])

type Logger = (msg: string) => void
const defaultLog: Logger = (msg) => console.log(`[sdk-skills] ${msg}`)

// Extract with the system tar (bsdtar ships with macOS and Windows 10+) —
// Node has no built-in untar and this avoids a dependency.
function untar(archive: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', destDir, '--strip-components', '1'], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (e) => reject(new Error(`tar failed to spawn: ${e.message}`)))
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.trim()}`))))
  })
}

async function fetchWithTimeout(url: string, timeoutMs: number, accept?: string): Promise<Response> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: accept !== undefined ? { Accept: accept } : undefined
  })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res
}

// SHA the cache was built from, or null when there is nothing reusable (no
// tree, unreadable/foreign meta, or a meta written by another app version).
function readCachedSha(metaPath: string, skillsDir: string, appVersion: string): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { sha?: string; appVersion?: string }
    return fs.existsSync(skillsDir) && meta.appVersion === appVersion && typeof meta.sha === 'string' ? meta.sha : null
  } catch {
    return null
  }
}

// The editor's own skills, one folder per skill that holds a SKILL.md.
function editorSkillNames(editorSkillsDir: string | null): string[] {
  if (editorSkillsDir === null || !fs.existsSync(editorSkillsDir)) return []
  return fs.readdirSync(editorSkillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(editorSkillsDir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort()
}

// Content hash of the editor skills, so editing one rebuilds the cache even
// when neither upstream nor the app version moved (a dev run never bumps it).
function editorSkillsDigest(editorSkillsDir: string | null): string {
  const hash = createHash('sha256')
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, `${rel}/${entry.name}`)
      else if (entry.isFile()) hash.update(`${rel}/${entry.name}\0`).update(fs.readFileSync(full))
    }
  }
  for (const name of editorSkillNames(editorSkillsDir)) walk(path.join(editorSkillsDir as string, name), name)
  return hash.digest('hex').slice(0, 12)
}

// Ensure the cache at <cacheDir>/skills holds the latest skills, one folder per
// skill (only tarball dirs with a SKILL.md, symlink-free, frontmatter-sanitized;
// denylisted skills keep supporting files but drop SKILL.md), with the editor's
// own skills from `editorSkillsDir` laid over them. The cache is keyed on
// upstream SHA + appVersion (+ editor skills digest): a new app version rebuilds even when
// upstream didn't move, so changes to the shaping logic here always take
// effect. Never throws: offline or a failed refresh just keeps whatever cache
// already exists. Returns the skills dir, or null when there is no usable cache.
export async function ensureSkillsCache(
  cacheDir: string,
  appVersion: string,
  log: Logger = defaultLog,
  editorSkillsDir: string | null = null
): Promise<string | null> {
  const skillsDir = path.join(cacheDir, 'skills')
  const metaPath = path.join(cacheDir, 'meta.json')
  const stageNew = path.join(cacheDir, 'skills.new')
  const stageOld = path.join(cacheDir, 'skills.old')

  // Recover from a crash mid-swap: the last-good tree may be stranded in
  // skills.old (renamed out of skills before the new tree landed). Restore it
  // before anything else reads or deletes it.
  if (!fs.existsSync(skillsDir) && fs.existsSync(stageOld)) {
    try {
      fs.renameSync(stageOld, skillsDir)
    } catch {
      /* fall through — a later successful refresh will repopulate */
    }
  }

  const editorSkills = editorSkillNames(editorSkillsDir)
  const cacheVersion = editorSkills.length > 0 ? `${appVersion}+${editorSkillsDigest(editorSkillsDir)}` : appVersion
  const cached = readCachedSha(metaPath, skillsDir, cacheVersion)

  try {
    const shaRes = await fetchWithTimeout(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, SHA_TIMEOUT_MS, 'application/vnd.github.sha')
    const sha = (await shaRes.text()).trim()
    if (sha === cached) return skillsDir

    const tarRes = await fetchWithTimeout(`https://codeload.github.com/${REPO}/tar.gz/${sha}`, TARBALL_TIMEOUT_MS)
    const tarball = Buffer.from(await tarRes.arrayBuffer())
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-skills-'))
    try {
      const archive = path.join(work, 'repo.tar.gz')
      const extracted = path.join(work, 'repo')
      fs.writeFileSync(archive, tarball)
      fs.mkdirSync(extracted)
      await untar(archive, extracted)

      // Build the filtered tree directly at the swap staging dir (same volume
      // as skillsDir, so the rename below is atomic and can't EXDEV).
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.rmSync(stageNew, { recursive: true, force: true }) // stale from a prior crash
      fs.mkdirSync(stageNew)
      let count = 0
      for (const entry of fs.readdirSync(extracted, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const src = path.join(extracted, entry.name)
        if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue
        const dest = path.join(stageNew, entry.name)
        if (SKILL_DENYLIST.has(entry.name) || SUPERSEDED.has(entry.name)) {
          if (fs.readdirSync(src).every((n) => n === 'SKILL.md')) continue // nothing but the trigger — nothing to ship
          fs.cpSync(src, dest, { recursive: true, filter: (s) => path.basename(s) !== 'SKILL.md' })
          continue
        }
        fs.cpSync(src, dest, { recursive: true })
        count++
      }
      if (count === 0) throw new Error('tarball contained no skills')
      for (const name of editorSkills) {
        const dest = path.join(stageNew, name)
        fs.rmSync(dest, { recursive: true, force: true })
        fs.cpSync(path.join(editorSkillsDir as string, name), dest, { recursive: true })
      }

      // Swap via renames on the cache volume so there is never a window where
      // skillsDir is half-copied; meta.json is absent while the swap is in
      // flight, so a crash mid-swap reads as "no cache" and rebuilds. If the
      // second rename fails (e.g. Windows AV lock), restore the last-good tree
      // instead of stranding the user with no cache.
      fs.rmSync(stageOld, { recursive: true, force: true })
      fs.rmSync(metaPath, { force: true })
      const hadOld = fs.existsSync(skillsDir)
      if (hadOld) fs.renameSync(skillsDir, stageOld)
      try {
        fs.renameSync(stageNew, skillsDir)
      } catch (e) {
        if (hadOld) fs.renameSync(stageOld, skillsDir)
        throw e
      }
      fs.rmSync(stageOld, { recursive: true, force: true })
      fs.writeFileSync(metaPath, JSON.stringify({ sha, appVersion: cacheVersion, updatedAt: new Date().toISOString() }))
      log(`updated to ${REPO}@${sha.slice(0, 7)} (${count} skills)`)
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
    }
    return skillsDir
  } catch (e) {
    // check the dir itself, not `cached` — a failed swap must not report a
    // cache that is no longer there (and a corrupt meta must not hide one that is)
    const usable = fs.existsSync(skillsDir)
    log(`refresh failed (${String(e)}) — ${usable ? 'using cached copy' : 'no cache yet, skills unavailable'}`)
    return usable ? skillsDir : null
  }
}

// A directory symlink; junction on Windows (no admin/dev-mode needed there).
function linkDir(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

// Only repoint symlinks WE created — recognized by their target resolving into
// the current cache dir (Windows junction targets carry a \\?\ prefix). A
// user's own symlink — including one pointing at their own sdk-skills checkout
// — must never be destroyed, so ownership is an exact cache-path match, not a
// name heuristic.
function isOwnedLink(linkPath: string, cacheSkillsDir: string): boolean {
  let target: string
  try {
    target = fs.readlinkSync(linkPath)
  } catch {
    return false
  }
  const norm = path.normalize(target.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '')
  const cache = path.normalize(cacheSkillsDir).replace(/[\\/]+$/, '')
  return norm === cache || norm.startsWith(cache + path.sep)
}

// Make sure <dir>/.gitignore covers `entry` — appending to an existing file (a
// pre-existing .claude/.gitignore is common) so the machine-local absolute
// symlink can never be committed.
function ensureGitignored(dir: string, entry: string): void {
  const gi = path.join(dir, '.gitignore')
  let content = ''
  try {
    content = fs.readFileSync(gi, 'utf8')
  } catch {
    /* new file */
  }
  const covered = content.split('\n').some((l) => [entry, `/${entry}`, `${entry}/`].includes(l.trim()))
  if (covered) return
  const head = content === '' || content.endsWith('\n') ? content : `${content}\n`
  fs.writeFileSync(gi, `${head}${entry}\n`)
}

// Link the cached skills into one agent dir of the project (.claude or
// .agents). Preferred shape: <project>/<dir>/skills is a single symlink to the
// cache. If the user already has a real skills dir of their own, we link each
// skill individually and skip any name they already have — theirs win. In both
// shapes every app-created link is .gitignore-covered so it can't be committed.
function linkAgentDir(projectDir: string, agentDir: string, cacheSkillsDir: string, log: Logger): void {
  const dir = path.join(projectDir, agentDir)
  const skillsPath = path.join(dir, 'skills')

  if (isSymlink(skillsPath)) {
    if (!isOwnedLink(skillsPath, cacheSkillsDir)) {
      log(`${agentDir}/skills is a user-made symlink — leaving it alone`)
      return
    }
    fs.rmSync(skillsPath) // ours from a previous open — repoint in case the cache moved
  }
  if (!fs.existsSync(skillsPath)) {
    fs.mkdirSync(dir, { recursive: true })
    ensureGitignored(dir, 'skills')
    linkDir(cacheSkillsDir, skillsPath)
    return
  }

  // Merge into the user's own real skills dir. Ignore each name we inject (not
  // the whole dir — theirs stay tracked), and prune owned links whose skill is
  // gone from the cache (denylisted/removed upstream) so no dangling links linger.
  const cacheNames = new Set(fs.readdirSync(cacheSkillsDir))
  for (const name of fs.readdirSync(skillsPath)) {
    const linkPath = path.join(skillsPath, name)
    if (!cacheNames.has(name) && isSymlink(linkPath) && isOwnedLink(linkPath, cacheSkillsDir)) fs.rmSync(linkPath)
  }
  for (const name of cacheNames) {
    const linkPath = path.join(skillsPath, name)
    if (isSymlink(linkPath)) {
      if (!isOwnedLink(linkPath, cacheSkillsDir)) continue // their symlink
      fs.rmSync(linkPath)
    } else if (fs.existsSync(linkPath)) {
      continue // their own skill of the same name
    }
    linkDir(path.join(cacheSkillsDir, name), linkPath)
    ensureGitignored(skillsPath, name)
  }
}

// The game-sounds skill plays the app's sound library, which ships once for both assistants
// (resources/sounds, packages/ui/src/sounds in dev) rather than inside the skill: copied in after
// each refresh, so the agent copies {baseDir}/sounds/<name>.mp3 into the scene.
export function addSoundLibrary(skillsDir: string, soundsDir: string, log: Logger = defaultLog): void {
  const skill = path.join(skillsDir, 'game-sounds')
  if (!fs.existsSync(path.join(skill, 'SKILL.md')) || !fs.existsSync(soundsDir)) return
  try {
    fs.cpSync(soundsDir, path.join(skill, 'sounds'), {
      recursive: true,
      filter: (src) => src === soundsDir || src.endsWith('.mp3') || path.basename(src) === 'CREDITS.md'
    })
  } catch (e) {
    log(`could not add the sound library: ${String(e)}`)
  }
}

// Best-effort: a scene without skills still works, the assistant just loses
// the SDK7 guidance for that session.
export function linkSkillsIntoProject(projectDir: string, cacheSkillsDir: string, log: Logger = defaultLog): void {
  for (const agentDir of ['.claude', '.agents']) {
    try {
      linkAgentDir(projectDir, agentDir, cacheSkillsDir, log)
    } catch (e) {
      log(`could not link skills into ${agentDir}: ${String(e)}`)
    }
  }
}
