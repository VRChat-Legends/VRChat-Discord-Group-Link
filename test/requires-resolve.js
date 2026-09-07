'use strict'

// Pre-commit guard: every relative require in src/ must resolve, and the app must load rather than merely parse.

const fs = require('fs')
const path = require('path')

const root = process.argv[2] || path.join(__dirname, '..')
const srcDir = path.join(root, 'src')

const problems = []
let scanned = 0

for (const name of fs.readdirSync(srcDir)) {
  if (!name.endsWith('.js')) continue
  scanned += 1
  const file = path.join(srcDir, name)
  const text = fs.readFileSync(file, 'utf8')
  for (const match of text.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
    const base = path.resolve(path.dirname(file), match[1])
    const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]
    if (!candidates.some((c) => fs.existsSync(c))) {
      problems.push(`${name}: require('${match[1]}') resolves to nothing`)
    }
  }
}

console.log(`Scanned ${scanned} files in src/`)

try {
  require(path.join(srcDir, 'commands.js')).buildCommands()
  require(path.join(srcDir, 'interactions.js'))
  require(path.join(srcDir, 'index.js').replace('index.js', 'sync.js'))
  require(path.join(srcDir, 'groupLogs.js'))
  require(path.join(srcDir, 'feeds.js'))
  require(path.join(srcDir, 'vrcAdmin.js'))
  require(path.join(srcDir, 'setupBackup.js'))
} catch (err) {
  problems.push(`load failed: ${err.message}`)
}

if (problems.length) {
  console.log('\nFAIL')
  for (const p of problems) console.log(`  ${p}`)
  process.exit(1)
}
console.log('PASS (every require resolves and every module loads)')
