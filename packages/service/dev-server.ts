import { parseArgs } from 'node:util'
import { Lifecycle } from '@well-known-components/interfaces'
import { initComponents } from './src/components.ts'
import { main } from './src/service.ts'
import { createServiceConfig } from './src/adapters/config.ts'

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    data: { type: 'string' },
    origin: { type: 'string' },
    'base-path': { type: 'string' },
    'ai-auth': { type: 'string' },
    'ai-image-auth': { type: 'string' },
    'ai-model': { type: 'string' }
  }
})
const config = await createServiceConfig({
  HTTP_SERVER_PORT: values.port,
  HTTP_SERVER_HOST: values.host,
  STORAGE_DIR: values.data,
  ALLOWED_ORIGINS: values.origin,
  BASE_PATH: values['base-path'],
  AI_AUTH_PATH: values['ai-auth'],
  AI_IMAGE_AUTH_PATH: values['ai-image-auth'],
  AI_MODEL: values['ai-model'],
  ASSISTANT_DRAIN_SECONDS: '0'
})

void Lifecycle.run({ main, initComponents: () => initComponents({ config }) })
