import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { baseline: { type: 'string' }, current: { type: 'string' }, out: { type: 'string' }, cases: { type: 'string', default: 'tree,chair,shed,cartoon' } } })
if (!values.baseline || !values.current || !values.out) throw new Error('Use --baseline RUN_DIR --current RUN_DIR --out NEW_REPORT_DIR')
const out = path.resolve(values.out)
await fs.mkdir(out)
const escape = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const rows = []
for (const name of values.cases.split(',')) {
  if (!['tree', 'chair', 'shed', 'cartoon'].includes(name)) throw new Error(`Unknown benchmark case: ${name}`)
  const pair = {}
  for (const variant of ['baseline', 'current']) {
    const dir = path.resolve(values[variant], name)
    const turn = JSON.parse(await fs.readFile(path.join(dir, 'turn.json'), 'utf8'))
    const frames = JSON.parse(await fs.readFile(path.join(dir, 'frames.json'), 'utf8'))
    const operations = turn.tools.flatMap((tool) => tool.args?.request?.type === 'batch'
      ? tool.args.request.requests.map((request, index) => ({ request, ...tool.result?.results?.[index] }))
      : [{ request: tool.args?.request, result: tool.result, error: tool.error }])
    const builds = operations.filter((operation) => operation.request?.type === 'buildModel')
    const imports = operations.filter((operation) => operation.request?.type === 'placeModel')
    const last = operations.filter((tool) => tool.result?.model && tool.result?.id).at(-1)
    let glbBytes = 0, sharedTextureBytes = 0
    if (last) {
      const file = path.join(dir, 'project', last.result.model)
      const bytes = await fs.readFile(file)
      glbBytes = bytes.length
      const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString().trim())
      for (const uri of new Set((gltf.images ?? []).map((image) => image.uri).filter(Boolean))) {
        if (uri.includes(':') || uri.split('/').includes('..')) throw new Error(`Unexpected model image URI: ${uri}`)
        sharedTextureBytes += (await fs.stat(path.join(path.dirname(file), uri))).size
      }
    }
    pair[variant] = { prompt: turn.prompt, model: turn.model, effort: turn.effort, seconds: turn.totalMs / 1000,
      firstModelSeconds: turn.firstModelMs / 1000, failure: turn.failure, buildAttempts: builds.length,
      source: last ? (last.result.script ? 'Generated in code' : 'Imported from catalog') : 'No model placed',
      importAttempts: imports.length, errors: operations.filter((operation) => operation.error).length,
      triangles: last?.result.stats?.triangles ?? last?.result.triangles,
      materials: last?.result.stats?.materials ?? last?.result.materials, glbBytes, sharedTextureBytes, frames }
    await fs.copyFile(path.join(dir, 'bevy.png'), path.join(out, `${name}-${variant}.png`))
  }
  if (pair.baseline.prompt !== pair.current.prompt || pair.baseline.model !== pair.current.model) throw new Error(`The ${name} prompts or models do not match`)
  rows.push({ name, ...pair })
}
await fs.writeFile(path.join(out, 'comparison.json'), JSON.stringify(rows, null, 2))
const number = (n, digits = 1) => Number.isFinite(n) ? n.toFixed(digits) : '—'
const cell = (value) => `<td>${escape(value)}</td>`
const table = (row) => {
  const fields = [
    ['Assistant status', (d) => d.failure ?? 'Completed'],
    ['Final model source', (d) => d.source],
    ['Reasoning effort', (d) => d.effort ?? 'Not recorded'],
    ['Completed answer', (d) => `${number(d.seconds)} s`],
    ['First saved model', (d) => `${number(d.firstModelSeconds)} s`],
    ['Builds / imports / tool errors', (d) => `${d.buildAttempts} / ${d.importAttempts} / ${d.errors}`],
    ['Triangles / materials', (d) => `${d.triangles ?? '—'} / ${d.materials ?? '—'}`],
    ['GLB / shared images', (d) => `${number(d.glbBytes / 1024, 0)} / ${number(d.sharedTextureBytes / 1024, 0)} KiB`],
    ['Frame interval / p95', (d) => `${number(d.frames?.frameMs)} / ${number(d.frames?.p95Ms)} ms`]
  ]
  return `<table><thead><tr><th>Measurement</th><th>Before</th><th>After</th></tr></thead><tbody>${fields.map(([label, fn]) => `<tr><th>${label}</th>${cell(fn(row.baseline))}${cell(fn(row.current))}</tr>`).join('')}</tbody></table>`
}
await fs.writeFile(path.join(out, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Model quality comparison</title>
<style>body{font:16px/1.5 system-ui,sans-serif;color:#20252b;background:#f5f4f0;max-width:1300px;margin:40px auto;padding:0 24px}h1,h2{line-height:1.1}h1{font-size:40px}h2{font-size:28px}section{margin:48px 0 72px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0}img{width:100%;display:block;border-radius:8px}figcaption{font-weight:700;margin:8px 0}table{border-collapse:collapse;width:100%;margin:24px 0}th,td{text-align:left;padding:9px;border-bottom:1px solid #ccc}p{max-width:85ch}summary{cursor:pointer}@media(max-width:700px){.pair{grid-template-columns:1fr}body{padding:0 14px}}</style>
<h1>How the models look, and how long they took</h1>
<p>One fresh assistant conversation per asset and version, using ${escape(rows[0].current.model)}, the same prompt, Bevy engine and camera. Times include tool calls, corrections and the final answer; they exclude editor startup. These are individual observations, not a statistical speed estimate.</p>
<p>Frame intervals cover five seconds of the entire scene, including the editor and background environment. They are affected by frame caps and do not isolate the asset's GPU cost. Shared images are stored once and reused by other models; old builds retained for undo are excluded from the sizes below.</p>
${rows.map((row) => `<section><h2>${escape(row.name)}</h2><p>${escape(row.current.prompt)}</p><div class="pair">${['baseline', 'current'].map((variant) => `<figure><figcaption>${variant === 'baseline' ? 'Before' : 'After'} · ${number(row[variant].seconds)} seconds · ${escape(row[variant].source)}</figcaption><a href="${row.name}-${variant}.png"><img src="${row.name}-${variant}.png" alt="${escape(row.name)} in Bevy, ${variant}"></a></figure>`).join('')}</div>${table(row)}</section>`).join('')}
<p>Exact measurements: <a href="comparison.json">comparison.json</a>. Source runs keep the prompts, generated scripts, tool errors, studio views and saved assets for inspection.</p></html>`)
console.log(path.join(out, 'index.html'))
