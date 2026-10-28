import { createConfigComponent } from '@well-known-components/env-config-provider'
import { describe, expect, it } from 'vitest'
import { initComponents } from '../components.ts'
import { createMemoryStore } from '../store.ts'

const start = (vars: Record<string, string>) => initComponents({
  store: createMemoryStore(),
  config: createConfigComponent({
    HTTP_SERVER_HOST: '127.0.0.1', HTTP_SERVER_PORT: '0', ALLOWED_ORIGINS: 'http://editor.local',
    TICKET_SECRET: 'test-secret-test-secret-test-secret', LOG_LEVEL: 'OFF', ...vars
  })
})

describe('assistant telemetry configuration', () => {
  it('refuses to start a Segment source it cannot use safely', async () => {
    await expect(start({ SEGMENT_WRITE_KEY: 'key', ANALYTICS_USER_SALT: 'short' })).rejects.toThrow('ANALYTICS_USER_SALT')
    await expect(start({ SEGMENT_WRITE_KEY: 'key', ANALYTICS_USER_SALT: 'x'.repeat(32) })).rejects.toThrow('assistant configured')
    await expect(start({ ANALYTICS_HISTORY_URL: 'http://reports.example' })).rejects.toThrow('https')
  })
})
