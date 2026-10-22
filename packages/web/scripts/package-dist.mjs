// Turns dist/ into the npm package the explorer page loads the editor from (by version, through
// jsDelivr). Run after the editor scene's export and `build`; CI stamps the version with oddish.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
for (const file of ['editor.js', 'scene-compiler/index.js', 'scene/about']) {
  if (!fs.existsSync(path.join(dist, file))) {
    console.error(`dist/${file} is missing: run the scene export and the web build first`)
    process.exit(1)
  }
}

const manifest = {
  name: '@dcl-regenesislabs/web-editor',
  version: '0.0.0',
  license: 'Apache-2.0',
  description: 'The Decentraland scene editor for the web explorer: editor.js plus the files it loads beside it. Served by version, not installed.',
  repository: { type: 'git', url: 'git+https://github.com/dcl-regenesislabs/web-editor.git', directory: 'packages/web' }
}
fs.writeFileSync(path.join(dist, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`dist/package.json written for ${manifest.name}`)
