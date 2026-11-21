// Search bounded files inside app.asar for a literal term.
import fs from 'node:fs'
import path from 'node:path'

const [, , root, term, maxFilesRaw] = process.argv
const maxFiles = Number(maxFilesRaw ?? 40)
const maxBytes = 1024 * 1024

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    let stat
    try { stat = fs.statSync(full) } catch { continue }
    if (stat.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const files = walk(root, []).slice(0, maxFiles)
for (const file of files) {
  let stat
  try { stat = fs.statSync(file) } catch { continue }
  if (stat.size > maxBytes) continue
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { continue }
  const lines = text.split('\n')
  let hits = 0
  lines.forEach((line, i) => {
    if (hits >= 20) return
    if (line.includes(term)) {
      console.log(`${file}:${i + 1}: ${line.slice(0, 200)}`)
      hits += 1
    }
  })
}
