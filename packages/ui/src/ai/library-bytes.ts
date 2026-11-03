// The shared material images, sounds and icons buildModel, addSound and addIcon copy into a project. Each host
// fetches them its own way: the web editor from next to its bundle, held to the build's hashes;
// the desktop app from its own files through the main process.
import type { LibraryName, MaterialMap } from '../three/materials'
import type { SoundName } from '../sounds'

export interface LibraryBytes {
  material(name: LibraryName, map: MaterialMap): Promise<Uint8Array<ArrayBuffer>>
  sound(name: SoundName): Promise<Uint8Array<ArrayBuffer>>
  // the icon catalog: its index, and one block of icons.pack by byte range
  iconIndex(): Promise<Uint8Array<ArrayBuffer>>
  iconBlock(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>>
}

let library: LibraryBytes | null = null

export function setLibraryBytes(next: LibraryBytes): void {
  library = next
}

function current(): LibraryBytes {
  if (library === null) throw new Error('The shared library is not available here.')
  return library
}

export const materialBytes = (name: LibraryName, map: MaterialMap): Promise<Uint8Array<ArrayBuffer>> => current().material(name, map)
export const soundBytes = (name: SoundName): Promise<Uint8Array<ArrayBuffer>> => current().sound(name)
export const iconIndexBytes = (): Promise<Uint8Array<ArrayBuffer>> => current().iconIndex()
export const iconBlockBytes = (offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> => current().iconBlock(offset, length)
