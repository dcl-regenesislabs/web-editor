import type { BudgetKey } from '../../scene-budget'
import type { SceneCheck, SceneCheckBudget } from './scene-checks'

export const BUDGET_CHECK_ID = 'scene-over-budget'

const REMEDY: Record<BudgetKey, string> = {
  triangles: 'Simplify the heaviest models (Scene insights lists them) or place fewer copies, or add parcels.',
  entities: 'Merge decoration into fewer entities or remove unused ones, or add parcels.',
  bodies: 'Merge parts into fewer meshes (parts sharing a material merge), or add parcels.',
  // counted once per model file, so the same colour built into 30 models counts 30 times
  materials: 'Reuse one material per colour across models (addons.material, or the same MeshStandardMaterial in each build) and simplify models with many, or add parcels.',
  textures: 'Reuse the textures and materials the scene already has, give parts seen from afar relief:false, or add parcels.',
  files: 'Delete unused files (Assets lists them), or add parcels.'
}

function consequence(key: BudgetKey, parcels: number): string {
  const area = `${parcels}-parcel`
  return key === 'files'
    ? `Over the ${area} limit: Genesis City refuses the deployment, though a World takes up to 10,000.`
    : `Over the ${area} soft limit: explorers warn about it and slower phones stutter.`
}

// The parcel budget as a finding, so the card, the insights dock and the assistant's check all report
// it the same way. A warning, not a blocker: an over-budget scene still plays.
export const sceneBudgetCheck: SceneCheck = ({ budget }) => {
  if (budget === undefined) return []
  const { parcels, used, limits } = budget
  return budget.over.map((key) => ({
    id: BUDGET_CHECK_ID,
    level: 'warning',
    title: `Too many ${key} (${used[key]} of ${limits[key]})`,
    detail: `The scene has ${used[key]} ${key}; ${parcels} parcel${parcels === 1 ? '' : 's'} allow ${limits[key]}. ` +
      `${consequence(key, parcels)} ${REMEDY[key]}`
  }))
}

// What buildModel adds to its warnings when the model it just placed takes the scene's materials over
// the limit or further over it. Materials only: textures are refused before the build is placed.
export function materialsGrowthWarning(before: SceneCheckBudget, after: SceneCheckBudget): string | null {
  if (!after.over.includes('materials') || after.used.materials <= before.used.materials) return null
  return `The scene now has ${after.used.materials} of its ${after.limits.materials} materials. ${REMEDY.materials}`
}
