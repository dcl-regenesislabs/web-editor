import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sdkCapability } from './sdk-capability'

const UI_TRANSFORM = ['dist', 'components', 'generated', 'pb', 'decentraland', 'sdk', 'components', 'ui_transform.gen.d.ts']

function scene(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sdk-capability-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'))
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

const sdk = (version: string) => ({
  'node_modules/@dcl/sdk/network/index.d.ts': 'export declare function isServer(): boolean',
  'node_modules/@dcl/sdk/package.json': JSON.stringify({ name: '@dcl/sdk', version })
})
const uiTransform = (ecsDir: string, src: string) => ({ [[ecsDir, ...UI_TRANSFORM].join('/')]: src })

describe('sdkCapability', () => {
  it('is unknown without node_modules', () => {
    expect(sdkCapability(scene({}))).toEqual({ authServer: false, installed: false })
  })

  it('reads elementId from the hoisted @dcl/ecs typings, and the installed SDK version', () => {
    const dir = scene({ ...sdk('7.33.0'), ...uiTransform('node_modules/@dcl/ecs', 'export interface PBUiTransform { zIndex?: number }') })
    expect(sdkCapability(dir)).toEqual({ authServer: true, installed: true, uiElementId: false, version: '7.33.0' })
  })

  it('prefers the @dcl/ecs nested in the SDK, the copy the scene loads', () => {
    const dir = scene({
      ...sdk('7.31.1-40606969412.commit-24c05c3'),
      ...uiTransform('node_modules/@dcl/ecs', 'export interface PBUiTransform { zIndex?: number }'),
      ...uiTransform('node_modules/@dcl/sdk/node_modules/@dcl/ecs', 'export interface PBUiTransform { elementId?: string | undefined }')
    })
    expect(sdkCapability(dir)).toMatchObject({ uiElementId: true, version: '7.31.1-40606969412.commit-24c05c3' })
  })

  it('leaves elementId unknown when the typings are not where it looks', () => {
    expect(sdkCapability(scene(sdk('7.33.0')))).not.toHaveProperty('uiElementId')
  })
})
