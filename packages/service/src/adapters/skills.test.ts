import { beforeAll, describe, expect, it } from 'vitest'
import { createSkillsComponent } from './skills.ts'
import type { SkillsComponent } from './skills.ts'

let skills: SkillsComponent
beforeAll(async () => { skills = await createSkillsComponent() })

describe('packaged SDK skills', () => {
  it('advertises SDK guidance and retains references across skills', () => {
    expect(skills.catalog).toContain('script-components/SKILL.md')
    expect(skills.catalog).toContain('add-interactivity/SKILL.md')
    expect(skills.catalog).not.toContain('deploy-scene/SKILL.md')
    expect(skills.catalog).not.toContain('creator-hub-mcp/SKILL.md')
    const skill = JSON.parse(skills.read('add-interactivity/SKILL.md'))
    expect(skill.content).toContain('pointerEventsSystem')
    expect(skill.references).toContain('add-interactivity/references/interactivity-patterns.md')
    const shared = JSON.parse(skills.read('player-avatar/../sdk-scenes/references/components-reference.md'))
    expect(shared.content).toContain('Transform')
  })

  it('layers the editor skills over the SDK skills they replace', () => {
    expect(skills.catalog).toContain('scene-ui/SKILL.md')
    expect(skills.catalog).not.toContain('build-ui/SKILL.md')
    expect(() => skills.read('build-ui/SKILL.md')).toThrow('Unknown SDK skill document')
    const skill = JSON.parse(skills.read('scene-ui/SKILL.md'))
    expect(skill.references).toContain('scene-ui/references/layout-check.md')
    expect(skill.content).toContain('scene-ui/../build-ui/references/ui-components.md')
    expect(JSON.parse(skills.read('scene-ui/../build-ui/references/ui-components.md')).content).toContain('UiEntity')
  })

  it('advertises game sounds as a default for every game', () => {
    expect(skills.catalog).toContain('game-sounds/SKILL.md')
    const skill = JSON.parse(skills.read('game-sounds/SKILL.md'))
    expect(skill.content).toContain('addSound')
    expect(skill.content).toContain('AudioSource.playSound')
  })

  it.each([
    '../.auth.json', '../../.env', '/etc/passwd', 'C:\\secrets', 'constructor', '__proto__',
    'sdk-scenes/SKILL.md', 'deploy-worlds/SKILL.md', 'https://example.com/image.png',
    'src/index.ts', 'add-interactivity/../../.auth.json', 'add-interactivity/SKILL.md\0'
  ])('refuses paths outside the bundled guidance: %s', (path) => {
    expect(() => skills.read(path)).toThrow('Unknown SDK skill document')
  })

  it('paginates long guidance and searches large catalogs without returning the entire file', () => {
    const first = JSON.parse(skills.read('build-ui/references/ui-components.md'))
    expect(first.content.length).toBe(16_000)
    expect(first.nextOffset).toBe(16_000)
    const next = JSON.parse(skills.read('build-ui/references/ui-components.md', first.nextOffset))
    expect(next.offset).toBe(16_000)
    expect(next.content).not.toBe(first.content)
    const search = JSON.parse(skills.read('add-3d-models/references/model-catalog.md', 0, 'tree'))
    expect(search.total).toBeGreaterThan(20)
    expect(search.matches).toHaveLength(20)
    expect(search.matches[0].text.toLowerCase()).toContain('tree')
    expect(JSON.parse(skills.read('add-3d-models/references/model-catalog.md', search.matches[0].offset)).content).toMatch(/^.*tree/i)
    expect(() => skills.read('scene-ui/SKILL.md', -1)).toThrow('Invalid skill offset')
    expect(() => skills.read('scene-ui/SKILL.md', 0, '')).toThrow('Invalid skill search')
  })
})
