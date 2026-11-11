export function createToolQueue() {
  let queued = Promise.resolve()
  return {
    run<T>(parallel: boolean, work: () => Promise<T>): Promise<T> {
      const result = (parallel ? Promise.resolve() : queued).then(work)
      // A rejected call still releases later edits; its caller receives the original rejection.
      if (!parallel) queued = result.then(() => {}, () => {})
      return result
    },
    idle: () => queued
  }
}
