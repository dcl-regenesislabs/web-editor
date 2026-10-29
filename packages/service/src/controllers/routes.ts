import { fromNativeResponse, Router } from '@dcl/http-server'
import { createMobilePreviewHandler } from '@dcl-editor/mobile-preview/server'
import { clientAddress } from '../client-ip.ts'
import { clientIpHeader } from '../config.ts'
import type { GlobalContext } from '../types.ts'

export async function setupRouter({ components }: GlobalContext): Promise<Router<GlobalContext>> {
  const base = (await components.config.getString('BASE_PATH') ?? '').replace(/\/$/, '')
  const ipHeader = clientIpHeader(await components.config.getString('CLIENT_IP_HEADER'))
  const router = new Router<GlobalContext>()
  const mobile = createMobilePreviewHandler(undefined, `${base}/mobile-preview/`)
  router.all(`${base}/mobile-preview/:path(.*)`, async ({ request }) => {
    const response = await mobile(request)
    // Local artifact bytes are streamed unchanged; preserve their declared length.
    return { ...fromNativeResponse(response), headers: response.headers }
  })
  // ahead of the catch-all below; admin answers 404 until Cloudflare Access is configured
  for (const path of ['/admin', '/admin/:path(.*)']) {
    router.all(base + path, async ({ request, components }) =>
      fromNativeResponse(await components.admin.handle(request) ?? new Response(null, { status: 404 })))
  }
  router.get(`${base}/assistant/socket`, async ({ request, components, remoteAddress }) =>
    components.assistant.upgrade(request, clientAddress(request, remoteAddress, ipHeader)))
  const paths = [
    '/health', '/projects', '/projects/:id', '/projects/:id/manifest',
    '/projects/:id/uploads', '/projects/:id/restore', '/projects/:id/files/:hash',
    '/prefabs', '/prefabs/:name', '/prefabs/:name/manifest', '/prefabs/:name/uploads', '/prefabs/:name/files/:hash',
    '/blobs/:hash', '/assistant/:action', '/:path(.*)'
  ]
  for (const path of paths) {
    router.all(base + path, async ({ request, components, remoteAddress }) =>
      fromNativeResponse(await components.projectStorage.handle(request, clientAddress(request, remoteAddress, ipHeader))))
  }
  return router
}
