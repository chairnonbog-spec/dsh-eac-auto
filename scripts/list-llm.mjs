// List the installed dsh-llm package's files through the ASAR-aware runtime.
import fs from 'node:fs'
import path from 'node:path'

const base = 'E:/Program Files/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm'
try {
  console.log('--- root ---')
  console.log(fs.readdirSync(base).join('\n'))
  const src = path.join(base, 'src')
  if (fs.existsSync(src)) {
    console.log('--- src ---')
    console.log(fs.readdirSync(src).join('\n'))
  }
} catch (error) {
  console.log('ERR', error.message)
}
