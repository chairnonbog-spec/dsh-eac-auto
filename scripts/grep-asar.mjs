// Search bounded files inside app.asar for a literal term; prints file:line hits.
import fs from 'node:fs'
import path from 'node:path'

const [, , root, term, maxFilesRaw] = process.argv
const maxFiles = Number(maxFilesRaw ?? 200)
const maxBytes = 2 * 1024 * 1024

function walk(dir, out) {
  let names
  try { names = fs.readdirSync(dir) } catch { return out }
  for (const name of names) {
    const full = path.join(dir, name)
    let stat
    try { stat = fs.statSync(full) } catch { continue }
    if (stat.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const files = walk(root, [])
console.log(`# scanned ${files.length} files under ${root}`)
let shown = 0
for (const file of files.slice(0, maxFiles)) {
  let stat
  try { stat = fs.statSync(file) } catch { continue }
  if (stat.size > maxBytes) continue
  if (!/\.(ts|tsx|js|mjs|jsx|vue)$/.test(file)) continue
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { continue }
  const lines = text.split('\n')
  let hits = 0
  lines.forEach((line, i) => {
    if (hits >= 8) return
    if (line.includes(term)) {
      console.log(`${file.replace('E:/Program Files/dsh/resources/app.asar/dsh/', '')}:${i + 1}: ${line.slice(0, 180)}`)
      hits += 1
      shown += 1
    }
  })
}
console.log(`# ${shown} hits`)
