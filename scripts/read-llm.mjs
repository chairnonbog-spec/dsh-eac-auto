// Print a bounded excerpt of one file inside app.asar.
import fs from 'node:fs'

const [, , file, startLineRaw, countRaw] = process.argv
const lines = fs.readFileSync(file, 'utf8').split('\n')
const start = Number(startLineRaw ?? 1)
const count = Number(countRaw ?? 120)
console.log(`### ${file} lines ${start}-${Math.min(start + count - 1, lines.length)} of ${lines.length}`)
for (let i = start - 1; i < Math.min(start - 1 + count, lines.length); i += 1) {
  console.log(`${i + 1}\t${lines[i]}`)
}
