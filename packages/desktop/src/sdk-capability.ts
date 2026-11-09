// Does the scene's installed SDK have the auth-server APIs?
//
// A server-aware prefab's script calls isServer / registerMessages. Dropped into
// a scene on an older SDK it still bundles — sdk-commands skips the type check in
// --watch mode — and then throws at runtime, inside a file the creator never wrote
// and just dragged in.
//
// Probe the capability rather than compare versions: any build carrying the API
// works, so a creator already on a newer auth-server build is never told to change.
// The same probe tells ui_layout whether uiTransform has elementId: published SDK
// releases drop it, and then the explorer measures none of the scene's UI.
import fs from 'node:fs'
import path from 'node:path'
import type { SdkCapability } from '@dcl-editor/contract'
import { spawnNpm } from './servers'


const UI_TRANSFORM_DTS = ['dist', 'components', 'generated', 'pb', 'decentraland', 'sdk', 'components', 'ui_transform.gen.d.ts']

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// the @dcl/ecs the scene's @dcl/sdk loads: its own nested copy first, else the hoisted one
function uiElementId(projectDir: string): boolean | undefined {
  const modules = path.join(projectDir, 'node_modules')
  for (const ecs of [path.join(modules, '@dcl', 'sdk', 'node_modules', '@dcl', 'ecs'), path.join(modules, '@dcl', 'ecs')]) {
    const src = readOrNull(path.join(ecs, ...UI_TRANSFORM_DTS))
    if (src !== null) return src.includes('elementId')
  }
  return undefined
}

function sdkVersion(projectDir: string): string | undefined {
  const src = readOrNull(path.join(projectDir, 'node_modules', '@dcl', 'sdk', 'package.json'))
  if (src === null) return undefined
  try {
    const pkg: unknown = JSON.parse(src)
    return typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

export function sdkCapability(projectDir: string): SdkCapability {
  const src = readOrNull(path.join(projectDir, 'node_modules', '@dcl', 'sdk', 'network', 'index.d.ts'))
  if (src === null) return { authServer: false, installed: false }
  const elementId = uiElementId(projectDir)
  const version = sdkVersion(projectDir)
  return {
    authServer: src.includes('isServer'),
    installed: true,
    ...(elementId === undefined ? {} : { uiElementId: elementId }),
    ...(version === undefined ? {} : { version })
  }
}

export async function installAuthServerSdk(
  projectDir: string,
  onLog: (line: string) => void
): Promise<{ ok: boolean; message: string }> {
  const args = ['install', '@dcl/sdk@auth-server', '@dcl/sdk-commands@auth-server', '--no-audit', '--no-fund']
  onLog(`● installing the auth-server SDK in ${projectDir}…`)
  return await new Promise((resolve) => {
    const child = spawnNpm(args, { cwd: projectDir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (d: Buffer) => onLog(String(d).trimEnd()))
    child.stderr?.on('data', (d: Buffer) => onLog(String(d).trimEnd()))
    child.on('error', (e) => resolve({ ok: false, message: `npm could not start — ${e.message}` }))
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve({ ok: false, message: `npm install exited with ${code} — see the logs` })
        return
      }
      resolve(
        sdkCapability(projectDir).authServer
          ? { ok: true, message: 'Installed the auth-server SDK' }
          : { ok: false, message: 'The install finished but the SDK still has no auth-server API' }
      )
    })
  })
}
