import { handle } from '../handler.ts'
import { purge } from '../purge.ts'
import type { Env } from '../config.ts'
import type { BaseComponents, ProjectStorageComponent } from '../types.ts'

export function createProjectStorageComponent(
  { assistant, logs }: Pick<BaseComponents, 'assistant' | 'logs'>,
  env: Env
): ProjectStorageComponent {
  const logger = logs.getLogger('project-storage')
  const environment: Env = {
    ...env, assistant,
    logError: () => logger.error('Project request failed')
  }
  return {
    handle: (request, client) => handle(request, environment, client),
    purge: () => purge(environment)
  }
}
