import { describe, expect, it } from 'vitest'
import { parcelLimits, type BudgetKey } from '../../scene-budget'
import { runSceneChecks, type SceneCheckBudget } from './scene-checks'
import { context } from './scene-check-fixtures'
import { materialsGrowthWarning } from './scene-check-budget'

const UNDER = { triangles: 0, entities: 0, bodies: 0, materials: 0, textures: 0, files: 0, megabytes: 0 }

function budget(parcels: number, used: Partial<typeof UNDER>): SceneCheckBudget {
  const limits = parcelLimits(parcels)
  const counts = { ...UNDER, ...used }
  const over = (Object.keys(limits) as BudgetKey[]).filter((key) => counts[key] > limits[key])
  return { parcels, used: counts, limits, over }
}

const overBudget = (b?: SceneCheckBudget) => runSceneChecks(context({ budget: b })).filter((f) => f.id === 'scene-over-budget')

describe('the parcel budget as a scene check', () => {
  it('warns about a scene over its materials, naming the count, the limit and what to do', () => {
    const b = budget(4, { materials: 82 })
    expect(b.limits.materials).toBe(46)
    expect(overBudget(b)).toEqual([{
      id: 'scene-over-budget',
      level: 'warning',
      title: 'Too many materials (82 of 46)',
      detail: expect.stringMatching(/^The scene has 82 materials; 4 parcels allow 46\. Over the 4-parcel soft limit.*Reuse one material per colour across models.*or add parcels\.$/)
    }])
  })

  it('reports each metric over its limit, and the file limit as the one Genesis City enforces', () => {
    const found = overBudget(budget(1, { triangles: 10_001, files: 201 }))
    expect(found.map((f) => f.title)).toEqual(['Too many triangles (10001 of 10000)', 'Too many files (201 of 200)'])
    expect(found[1].detail).toContain('Genesis City refuses the deployment')
    expect(found.every((f) => f.level === 'warning')).toBe(true)
  })

  it('says nothing for a scene within budget, or one it could not count', () => {
    expect(overBudget(budget(4, { materials: 46 }))).toEqual([])
    expect(overBudget(undefined)).toEqual([])
  })
})

describe('the materials warning a build carries', () => {
  it('speaks when the build takes the scene over the limit or further over it', () => {
    expect(materialsGrowthWarning(budget(4, { materials: 45 }), budget(4, { materials: 50 }))).toMatch(/^The scene now has 50 of its 46 materials\. Reuse one material/)
    expect(materialsGrowthWarning(budget(4, { materials: 50 }), budget(4, { materials: 52 }))).toMatch(/52 of its 46/)
  })

  it('stays quiet under the limit, and for a rebuild that adds none', () => {
    expect(materialsGrowthWarning(budget(4, { materials: 40 }), budget(4, { materials: 46 }))).toBeNull()
    expect(materialsGrowthWarning(budget(4, { materials: 50 }), budget(4, { materials: 50 }))).toBeNull()
  })
})
