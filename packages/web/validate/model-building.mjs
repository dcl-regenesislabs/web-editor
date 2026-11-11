// node packages/web/validate/model-building.mjs [--cdp http://localhost:9222] [--out /tmp/model-building]
// Exercises the actual sandbox, exporter and preview worker; writes inspectable GLBs and contact sheets.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const { values } = parseArgs({ options: { cdp: { type: 'string' }, out: { type: 'string', default: '/tmp/model-building' } } })
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const out = path.resolve(values.out)
await fs.mkdir(path.join(out, 'models/materials'), { recursive: true })
const scripts = {
  tree: 'root.add(addons.tree({height:5,width:3.4,seed:7}));',
  rock: "root.add(new THREE.Mesh(addons.rock({size:[1.8,1.1,1.4],seed:12}),addons.material('rock')));",
  planter: "root.add(new THREE.Mesh(addons.lathe([[0,0],[0.23,0],[0.25,0.025],[0.27,0.08],[0.36,0.49],[0.38,0.51],[0.38,0.55],[0.36,0.57],[0.32,0.57],[0.30,0.53],[0.22,0.09],[0,0.09]]),new THREE.MeshStandardMaterial({color:'#ad694b',roughness:0.72,metalness:0})));",
  handle: "root.add(new THREE.Mesh(addons.tube({points:[[-0.4,0,0],[-0.55,0.65,0],[0,1,0],[0.55,0.65,0],[0.4,0,0]],radii:[0.07,0.055,0.05,0.055,0.07],segments:32}),addons.material('wood')));"
}
const bundled = await build({
  stdin: { contents: `
    import {setThreeWorker,startThreeWorker} from './packages/ui/src/three/client.ts';
    import {buildCodeModel,overBudget} from './packages/ui/src/ai/code-model.ts';
    import {inspectModel} from './packages/ui/src/model-info.ts';
    setThreeWorker(() => fetch('/worker.js').then(r=>r.text()));
    window.run = async (name, code) => {
      const start = performance.now();
      const built = await buildCodeModel(code,name,new AbortController().signal);
      const modelBuildMs = performance.now()-start;
      const info = inspectModel(built.bytes);
      const stats = {triangles:info.triangles,materials:info.materials.length,textures:info.textures-info.sharedImages.length,largestTexture:info.largestImage};
      const over = overBudget(stats,info.textureProblems);
      if (over.length) throw new Error(over.join(', '));
      const files = Object.fromEntries(await Promise.all(info.sharedImages.map(async uri => [uri,await fetch('/'+uri).then(r=>r.arrayBuffer())])));
      const worker = await startThreeWorker('view');
      let reply;
      const previewStart = performance.now();
      try {
        reply = await new Promise((resolve,reject)=>{
          const timer = setTimeout(()=>reject(new Error('Preview timed out')),15000);
          worker.onmessage = ({data})=>{clearTimeout(timer);data.kind==='previewed'?resolve(data):reject(new Error(data.error||data.kind));};
          worker.postMessage({kind:'preview',bytes:built.bytes.buffer,files});
        });
      } finally { worker.terminate(); }
      const image = document.createElement('img');
      image.src='data:image/jpeg;base64,'+reply.preview.image;
      image.alt=name;
      document.body.append(image);
      let glb=''; for (const byte of built.bytes) glb+=String.fromCharCode(byte);
      return {name,stats,modelBuildMs,previewMs:performance.now()-previewStart,kb:built.bytes.length/1024,scriptCharacters:code.length,sharedImages:info.sharedImages,warnings:built.warnings,preview:reply.preview,glb:btoa(glb)};
    };`, resolveDir: repo, loader: 'ts' },
  bundle: true, write: false, format: 'iife', target: 'es2022'
})
const worker = await build({ entryPoints: [path.join(repo, 'packages/ui/src/three/worker.ts')], bundle: true, write: false, format: 'iife', target: 'es2022' })
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/') return res.setHeader('Content-Type', 'text/html').end('<!doctype html><body style="background:#eee"><script src="/main.js"></script>')
    if (url.pathname === '/main.js') return res.setHeader('Content-Type', 'text/javascript').end(bundled.outputFiles[0].contents)
    if (url.pathname === '/worker.js') return res.setHeader('Content-Type', 'text/javascript').end(worker.outputFiles[0].contents)
    if (/^\/materials\/T_[A-Za-z]+_[DN]\.jpg$/.test(url.pathname)) {
      const file = path.basename(url.pathname)
      return res.setHeader('Content-Type', 'image/jpeg').end(await fs.readFile(path.join(repo, 'packages/ui/src/three/materials', file)))
    }
    res.writeHead(404).end()
  } catch (error) { res.writeHead(500).end(String(error)) }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const browser = values.cdp ? await chromium.connectOverCDP(values.cdp) : await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
page.on('pageerror', (error) => console.error(error.message))
const results = []
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => typeof window.run === 'function')
  for (const [name, code] of Object.entries(scripts)) {
    const { glb, preview, ...result } = await page.evaluate(([name, code]) => window.run(name, code), [name, code])
    assert.equal(preview.mimeType, 'image/jpeg')
    assert.equal(preview.width, 1152)
    assert.ok(preview.image.length > 1000)
    await fs.writeFile(path.join(out, `${name}.jpg`), Buffer.from(preview.image, 'base64'))
    await fs.writeFile(path.join(out, 'models', `${name}.glb`), Buffer.from(glb, 'base64'))
    await fs.writeFile(path.join(out, `${name}.js`), code)
    for (const uri of result.sharedImages) await fs.copyFile(path.join(repo, 'packages/ui/src/three', uri), path.join(out, 'models', uri))
    results.push(result)
    console.log(`PASS ${name}: ${result.stats.triangles} triangles, ${Math.round(result.kb)} KB, build ${Math.round(result.modelBuildMs)} ms, preview ${Math.round(result.previewMs)} ms, ${code.length} script characters`)
  }
  await page.screenshot({ path: path.join(out, 'models.png'), fullPage: true })
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(results, null, 2))
} finally {
  await page.close()
  await browser.close()
  server.close()
}
