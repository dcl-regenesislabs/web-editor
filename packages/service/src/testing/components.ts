import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getUnderlyingServer } from '@dcl/http-server'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { Lifecycle } from '@well-known-components/interfaces'
import { initComponents } from '../components.ts'
import type { ComponentOptions } from '../components.ts'
import { main } from '../service.ts'
import { createMemoryStore } from '../store.ts'

export const TEST_ORIGIN = 'http://editor.local'

export async function createTestService(options: Pick<ComponentOptions, 'store' | 'agentFactory'> & { vars?: Record<string, string> } = {}) {
  const program = await Lifecycle.run({
    main,
    initComponents: () => initComponents({
      agentFactory: options.agentFactory,
      store: options.store ?? createMemoryStore(),
      config: createConfigComponent({
        HTTP_SERVER_HOST: '127.0.0.1', HTTP_SERVER_PORT: '0',
        ALLOWED_ORIGINS: TEST_ORIGIN, BASE_PATH: '/svc',
        TICKET_SECRET: 'test-secret-test-secret-test-secret', LOG_LEVEL: 'OFF', ASSISTANT_DRAIN_SECONDS: '0',
        ...options.vars
      })
    })
  })
  const server = await getUnderlyingServer<Server>(program.components.server)
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { ...program, server, origin, base: origin + '/svc' }
}
