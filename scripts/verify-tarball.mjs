/**
 * Verify a packed tarball: the file list, and that the package loads.
 *
 * Run: node scripts/verify-tarball.mjs <tarball>
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const tarball = process.argv[2]
if (!tarball) {
  console.error('usage: node scripts/verify-tarball.mjs <tarball>')
  process.exit(1)
}

const absolute = path.resolve(tarball)
if (!fs.existsSync(absolute)) {
  console.error(`no such file: ${absolute}`)
  process.exit(1)
}

/** The files the tarball must carry for the plugin to work. */
const REQUIRED = [
  'package.json',
  'index.js',
  'cordis.patch.yml',
  'icon.svg',
  'LICENSE',
  'README.md',
  'INSTALL.md',
  'src/adapter.js',
  'src/discovery.js',
  'src/failover.js',
  'locale/en.json',
  'locale/zh.json',
]

// ── the tarball's own file list ──────────────────────────────────────────────

const listing = execFileSync('tar', ['-tzf', absolute], { encoding: 'utf8' })
const entries = listing.split('\n').map(line => line.trim()).filter(Boolean)
const names = entries.map(entry => entry.replace(/^package\//, ''))

console.log(`tarball: ${absolute}`)
console.log(`size: ${fs.statSync(absolute).size} bytes`)
console.log(`entries: ${entries.length}`)
for (const name of names.sort()) console.log(`  ${name}`)

const missing = REQUIRED.filter(name => !names.includes(name))
if (missing.length > 0) {
  console.error(`MISSING: ${missing.join(', ')}`)
  process.exit(1)
}
console.log('\nall required files are present')

// ── the package must load ────────────────────────────────────────────────────

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-auto-verify-'))
const unpacked = path.join(work, 'package')
fs.mkdirSync(unpacked, { recursive: true })
execFileSync('tar', ['-xzf', absolute, '-C', unpacked], { stdio: 'ignore' })

// pnpm strips the `package/` prefix, but a plain `tar` archive keeps it.
// The unpacked root is whichever directory holds the manifest.
const manifestPath = [
  path.join(unpacked, 'package.json'),
  path.join(unpacked, 'package', 'package.json'),
].find(candidate => fs.existsSync(candidate))
if (manifestPath === undefined) {
  console.error('the tarball does not contain a package.json')
  process.exit(1)
}
const root = path.dirname(manifestPath)

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
console.log(`\nname: ${manifest.name}`)
console.log(`version: ${manifest.version}`)
console.log(`bundle patch: ${manifest.dsh?.bundle?.patch}`)
console.log(`exports: ${Object.keys(manifest.exports ?? {}).join(', ')}`)

// The plugin's own modules must import cleanly from the unpacked copy.
const entry = await import(pathToFileURL(path.join(root, 'index.js')).href)
const expected = ['apply', 'name', 'inject', 'normalizeConfig', 'buildState']
const absent = expected.filter(key => entry[key] === undefined)
if (absent.length > 0) {
  console.error(`MISSING EXPORTS: ${absent.join(', ')}`)
  process.exit(1)
}
console.log(`\nexports ok: ${expected.join(', ')}`)

// The plugin must not depend on anything outside the standard library.
const sources = ['index.js', 'src/adapter.js', 'src/discovery.js', 'src/failover.js']
const external = new Set()
for (const rel of sources) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8')
  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const specifier = match[1]
    if (specifier.startsWith('node:') || specifier.startsWith('.')) continue
    external.add(specifier)
  }
}
console.log(`external dependencies: ${external.size === 0 ? 'none' : [...external].join(', ')}`)
if (external.size > 0) {
  console.error('a profile plugin cannot resolve host packages; the package must be dependency-free')
  process.exit(1)
}

fs.rmSync(work, { recursive: true, force: true })
console.log('\ntarball verified')
