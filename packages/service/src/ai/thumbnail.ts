import { readFileSync } from 'node:fs'
import { Type } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { object } from '../../../contract/src/assistant.ts'
import type { ImageProvider, ImageRequest, PictureData } from './images.ts'
import type { WalletUsage } from './usage.ts'
import type { BrowserCall } from './types.ts'

export const DEFAULT_IMAGES_PER_DAY = 10

/** The image model as one wallet may use it. */
export interface WalletImages {
  /** null when an image can be made now, else what to tell the creator */
  refusal(): Promise<string | null>
  /** Counts one image against the wallet's day, whether or not the model delivers it. */
  generate(request: ImageRequest, signal?: AbortSignal): Promise<PictureData>
  /** The creator's own avatar, or null without one */
  avatar(signal?: AbortSignal): Promise<PictureData | null>
}

// a line-up of Decentraland avatars, so people on the poster look like avatars rather than film characters
const AVATAR_LINEUP: PictureData = { mimeType: 'image/jpeg', data: readFileSync(new URL('./avatar-lineup.jpg', import.meta.url)).toString('base64') }

export const IMAGES_UNAVAILABLE = 'Making thumbnails is not set up on this assistant service (no image model is signed in). ' +
  'The creator can choose an image as the thumbnail in Scene settings.'

export function createWalletImages(provider: ImageProvider | undefined, usage: WalletUsage | undefined, perDay: number,
  avatar: (signal?: AbortSignal) => Promise<PictureData | null> = async () => null): WalletImages {
  return {
    async refusal() {
      if (provider === undefined || usage === undefined) return IMAGES_UNAVAILABLE
      if (!(await usage.exhausted())) return null
      return `This account has made today's ${perDay} thumbnail images. More can be made after ${(await usage.balance()).dailyResetAt}.`
    },
    async generate(request, signal) {
      if (provider === undefined || usage === undefined) throw new Error(IMAGES_UNAVAILABLE)
      await usage.record(1)
      return provider.generate(request, signal)
    },
    avatar
  }
}

export type PictureRole = 'hero' | 'wide' | 'avatars' | 'creator' | 'current'

const ROLES: Record<PictureRole, string> = {
  hero: 'a close view of the hero subject in the game\'s 3D scene',
  wide: 'a wide view of the whole scene',
  avatars: 'a line-up of Decentraland avatars, only to show how people look; not part of the scene',
  creator: 'the creator\'s own Decentraland avatar',
  current: 'the current poster'
}

export function thumbnailPrompt({ brief, title, style, revise, pictures }:
  { brief: string; title: string; style: string; revise?: string; pictures: PictureRole[] }): string {
  return [
    'Key art for a Decentraland game: a poster that sells the game, not a screenshot.',
    `Style: ${style}.`,
    `Title text, spelled exactly: "${title}".`,
    `Art direction: ${brief}`,
    'The attached pictures, in order:',
    ...pictures.map((role, at) => `${at + 1}. ${ROLES[role]}`),
    'Keep the scene\'s setting, hero subject, shapes and palette recognisable, but redraw it as polished key art with a dynamic composition.',
    'Composition rules:',
    '- Landscape, filled edge to edge. It is cropped to 16:9, and parts of Decentraland show only the central square, ' +
      'so the title and the key subject sit inside the middle 55% of the width, clear of the top and bottom edges.',
    '- The title in large, bold, readable lettering. No other text, no small print.',
    '- No UI, HUD, buttons, cursors, frames, borders, watermarks or logos.',
    '- Show the game\'s hook: what the player does and why it is fun.',
    ...(pictures.includes('avatars') ? ['- Any people are Decentraland avatars drawn in the look of the line-up: 3D game characters with stylised, slightly anime faces, ' +
      'slim proportions, a clean game-model finish and bold, colourful streetwear and sneakers. At most three other people, each a new ' +
      'character: never redraw anyone from the line-up or their hair, goggles, ears or outfits. Not realistic people, not Pixar or Disney-style film characters, not blocky, voxel or Lego-like figures.'] : revise === undefined ? ['- No people or characters.'] : []),
    ...(pictures.includes('creator') ? ['- The creator\'s own avatar is the lead character: keep its hair, skin, face and outfit recognisable.'] : []),
    '- Original art only: no characters, logos, art styles or trademarks from other games, films or brands ' +
      '(no Minecraft, Roblox, Fortnite or Lego look), and no real brand marks on clothes or shoes.',
    ...(revise === undefined ? [] : [
      'Edit the current poster rather than painting a new one: keep its composition, characters, ' +
        `title lettering and palette, and change only this: ${revise}`
    ])
  ].join('\n')
}

const point = Type.Object({ x: Type.Number(), y: Type.Number(), z: Type.Number() })

function isPoint(value: unknown): boolean {
  return object(value) && ['x', 'y', 'z'].every((axis) => typeof value[axis] === 'number' && Number.isFinite(value[axis]))
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max ? value.trim() : null
}

type ThumbnailResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }>; details: Record<string, never> }

export async function makeThumbnail(args: unknown, call: BrowserCall, images: WalletImages, signal?: AbortSignal): Promise<ThumbnailResult> {
  if (!object(args)) throw new Error('Invalid thumbnail arguments')
  const brief = text(args.brief, 2000)
  const title = text(args.title, 60)
  const style = text(args.style, 80)
  const revise = args.revise === undefined ? undefined : text(args.revise, 500)
  const avatars = args.avatars === true
  const shots = Array.isArray(args.shots) ? args.shots : []
  if (brief === null || title === null || style === null || revise === null || shots.length !== 2 ||
    !shots.every((shot) => object(shot) && isPoint(shot.from) && isPoint(shot.lookAt))) {
    throw new Error('make_thumbnail needs brief, title, style and 2 shots of {from, lookAt}: the hero subject close, then the whole scene wide.')
  }
  const refused = await images.refusal()
  if (refused !== null) return { content: [{ type: 'text', text: refused }], details: {} }
  const pictures: Array<{ role: PictureRole; picture: PictureData }> = []
  for (const [at, shot] of (shots as Array<Record<string, unknown>>).entries()) {
    const view: unknown = JSON.parse(await call('view', { from: shot.from, lookAt: shot.lookAt, label: 'Framing the thumbnail' }, signal))
    if (!object(view) || typeof view.image !== 'string' || view.mimeType !== 'image/jpeg') throw new Error('The browser sent no picture.')
    pictures.push({ role: at === 0 ? 'hero' : 'wide', picture: { mimeType: 'image/jpeg', data: view.image } })
  }
  if (avatars) {
    pictures.push({ role: 'avatars', picture: AVATAR_LINEUP })
    const creator = await images.avatar(signal)
    if (creator !== null) pictures.push({ role: 'creator', picture: creator })
  }
  if (revise !== undefined) {
    const current: unknown = JSON.parse(await call('scene_request', { request: { type: 'readThumbnail' }, label: 'Reading the thumbnail' }, signal))
    if (!object(current) || typeof current.image !== 'string' || (current.mimeType !== 'image/jpeg' && current.mimeType !== 'image/png')) {
      throw new Error('The browser sent no thumbnail to revise.')
    }
    pictures.push({ role: 'current', picture: { mimeType: current.mimeType, data: current.image } })
  }
  const prompt = thumbnailPrompt({ brief, title, style, revise, pictures: pictures.map(({ role }) => role) })
  const image = await images.generate({ prompt, references: pictures.map(({ picture }) => picture) }, signal)
  const saved: unknown = JSON.parse(await call('scene_request', {
    request: { type: 'saveThumbnail', image: image.data, mimeType: image.mimeType, preview: true },
    label: 'Saving the thumbnail'
  }, signal))
  if (!object(saved)) throw new Error('The browser did not save the thumbnail.')
  const { preview, ...result } = saved
  const summary = { type: 'text' as const, text: `Saved as the scene thumbnail: ${JSON.stringify(result)}` }
  if (!object(preview) || typeof preview.image !== 'string') return { content: [summary], details: {} }
  return { content: [{ type: 'image', mimeType: 'image/jpeg', data: preview.image }, summary], details: {} }
}

export function thumbnailTool(call: BrowserCall, images: WalletImages): ToolDefinition {
  return {
    name: 'make_thumbnail', label: 'Make thumbnail',
    description: 'Make the scene\'s thumbnail: 16:9 key art painted by an image model from your brief and 2 views of the scene ' +
      '(from, lookAt in world metres): the hero subject close, then the whole scene wide. Each one is saved as a new version, ' +
      'assets/images/thumbnail-N.jpg, and set in scene.json; earlier versions stay. revise edits the current thumbnail instead ' +
      'of painting a new one: say only what to change. Every call paints a new image and returns a small copy of it; ' +
      'never call it just to look at a thumbnail. Call it only when the creator asks, and retry at most once unless they ask for more.',
    parameters: Type.Object({
      brief: Type.String({ maxLength: 2000, description: 'Written as an art director: the game hook, the hero subject, the mood and a palette from the scene. Never name other games, films or brands' }),
      title: Type.String({ maxLength: 60, description: 'The game\'s name, exactly as it should read' }),
      style: Type.String({ maxLength: 80 }),
      revise: Type.Optional(Type.String({ maxLength: 500, description: 'Only what to change in the current thumbnail' })),
      avatars: Type.Optional(Type.Boolean({ description: 'Show Decentraland avatars, led by the creator\'s own, when players are the hook (a game they play, race, fight or meet in); leave it off for a place, a gallery, an object or scenery, and follow the creator if they say. Without it the poster has no people' })),
      shots: Type.Array(Type.Object({ from: point, lookAt: point }), { minItems: 2, maxItems: 2 }),
      label: Type.Optional(Type.String({ description: 'What you are doing now, for the creator, at most six words' }))
    }),
    execute: (_id, args, signal) => makeThumbnail(args, call, images, signal)
  }
}
