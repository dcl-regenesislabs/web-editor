// The shared material images, sounds and icon catalog, served next to editor.js and held to the hashes written into it.
// icons.pack is read by byte range, so its blocks are held to the sha256 in the (verified) index instead.
import { fetchVerified } from '@dcl-editor/scene-compiler'
import { materialFile, type LibraryName, type MaterialMap } from '@ui/three/materials'
import { soundFile, type SoundName } from '@ui/sounds'
import { fileIntegrity } from '../workers'

let base: string | null = null
export function setLibraryBase(editorBase: string): void {
  base = editorBase
}

async function libraryBytes(file: string): Promise<Uint8Array<ArrayBuffer>> {
  if (base === null) throw new Error('The shared library is not available here.')
  const response = await fetchVerified(new URL(file, base).href, fileIntegrity(file), file)
  return new Uint8Array(await response.arrayBuffer())
}

export const materialBytes = (name: LibraryName, map: MaterialMap): Promise<Uint8Array<ArrayBuffer>> => libraryBytes(materialFile(name, map))
export const soundBytes = (name: SoundName): Promise<Uint8Array<ArrayBuffer>> => libraryBytes(soundFile(name))

export const ICON_INDEX_FILE = 'icons/icons.index.json'
export const ICON_PACK_FILE = 'icons/icons.pack'

export const iconIndexBytes = (): Promise<Uint8Array<ArrayBuffer>> => libraryBytes(ICON_INDEX_FILE)

// A server that ignores Range answers the whole pack: it is kept, and every block after is cut out of it.
let wholePack: Uint8Array<ArrayBuffer> | null = null

export async function iconBlockBytes(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  if (base === null) throw new Error('The shared library is not available here.')
  if (wholePack !== null) return wholePack.slice(offset, offset + length)
  const response = await fetch(new URL(ICON_PACK_FILE, base).href, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } })
  if (response.status !== 206 && response.status !== 200) throw new Error(`The icon catalog answered HTTP ${response.status}.`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (response.status === 206) return bytes
  wholePack = bytes
  return bytes.slice(offset, offset + length)
}
