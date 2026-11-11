export function modelScriptExclusion(current: string): string {
  if (current.trimEnd().split('\n').at(-1) === 'models/src/') return current
  return `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}models/src/\n`
}
