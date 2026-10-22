// Model catalog and imports: the Assets panel's mutation surface. Every path
// that lands geometry in the scene ends the same way — resync, re-select, and
// hand the new entity to the move gizmo.
import { state } from '@scene/state'
import {
  loadModelCatalog,
  modelById,
  importModel,
  dropPosition,
  loadLocalModels,
  placeLocalModel,
  placeLocalSound,
  importFiles,
  missingModelRefs
} from '../assets'
import { trackCreator } from '../analytics'
import { sendToScene } from '../engine/bus'
import { syncSelectionToScene, ensureTransformTool, focusPlaced } from './selection'

export const uiFetchCatalog = async (): Promise<void> => {
  state.assetBusy = true
  try {
    const models = await loadModelCatalog()
    state.assetCatalog = models.map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      tags: m.tags,
      pack: m.collection,
      thumbnail: m.thumbnailUrl ?? null
    }))
    state.assetCatalogFailed = false
  } catch (e) {
    state.assetCatalogFailed = true
    throw e
  } finally {
    state.assetBusy = false
  }
}

export const uiImportAsset = async (assetId: string, _name: string): Promise<void> => {
  const asset = modelById(assetId)
  if (asset === undefined) return
  state.assetBusy = true
  try {
    await importModel(asset, await dropPosition())
    trackCreator('asset_added', { source: 'catalog', kind: 'model', via: 'assets_panel', asset_id: asset.id })
    focusPlaced()
    state.saveStatus = `Imported ${asset.name}`
  } catch (e) {
    state.saveStatus = `import failed: ${String(e)}`
  } finally {
    state.assetBusy = false
    // resync, not refresh: registering new content can re-instance the scene,
    // which drops the editor's engine-only pick colliders — resync clears the
    // applied-markers so they get re-written (else click-select/gizmo go dead)
    void sendToScene({ type: 'resync' })
    syncSelectionToScene()
    ensureTransformTool()
  }
}

// List the project's local model files (gltf/glb already in scene content).
export const uiLoadLocalModels = async (): Promise<string[]> => {
  return await loadLocalModels()
}

// Place a model that's already in the project content into the scene.
const placeFile = async (rel: string, place: typeof placeLocalModel, kind: 'model' | 'sound'): Promise<void> => {
  state.assetBusy = true
  try {
    const name = rel.split('/').pop()?.replace(/\.[^.]+$/, '') ?? rel
    await place(rel, name, await dropPosition())
    trackCreator('asset_added', { source: 'project', kind, via: 'assets_panel' })
    focusPlaced()
    state.saveStatus = `Placed ${name}`
  } catch (e) {
    state.saveStatus = `place failed: ${String(e)}`
  } finally {
    state.assetBusy = false
    void sendToScene({ type: 'resync' })
    syncSelectionToScene()
    ensureTransformTool()
  }
}
export const uiPlaceLocalModel = (rel: string): Promise<void> => placeFile(rel, placeLocalModel, 'model')
export const uiPlaceLocalSound = (rel: string): Promise<void> => placeFile(rel, placeLocalSound, 'sound')

// Referenced files the picked set doesn't satisfy — checked before importing so
// the panel can warn first. Fail-open: the post-upload status warning backstops.
export const uiCheckModelRefs = async (files: File[]): Promise<string[]> => {
  try {
    return await missingModelRefs(files)
  } catch {
    return []
  }
}

// Import files from disk (browser or electron): a model is placed, other media and data files are added.
export const uiImportFiles = async (files: File[]): Promise<void> => {
  state.assetBusy = true
  try {
    const { placed, added, missing, skipped } = await importFiles(files, await dropPosition())
    if (placed !== null || added.length > 0) {
      trackCreator('asset_added', { source: 'upload', via: 'assets_panel', kind: placed === null ? 'file' : 'model', files: added.length + (placed === null ? 0 : 1) })
    }
    const parts: string[] = []
    if (placed !== null) parts.push(`Added ${placed}`)
    if (added.length > 0) parts.push(`${placed === null ? 'Added' : 'and'} ${added.length === 1 ? added[0] : `${added.length} files under assets/`}`)
    if (missing.length > 0) parts.push(`— it references files not in the project: ${missing.join(', ')}. Select them together with the model to include them`)
    if (skipped.length > 0) parts.push(`${parts.length > 0 ? '— ' : ''}left out ${skipped.join(', ')}`)
    state.saveStatus = parts.length > 0 ? parts.join(' ') : 'Nothing to import'
  } catch (e) {
    state.saveStatus = `import failed: ${String(e)}`
  } finally {
    state.assetBusy = false
    void sendToScene({ type: 'resync' })
    syncSelectionToScene()
    ensureTransformTool()
  }
}
