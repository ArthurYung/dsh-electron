import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDirectory = join(root, '.electron-runtime')
const sourceDirectory = dirname(process.execPath)
const files = [
  ['node.exe', 'node.exe'],
  ['LICENSE', 'NODE-LICENSE.txt'],
]

mkdirSync(runtimeDirectory, { recursive: true })
for (const [sourceName, targetName] of files) {
  const source = join(sourceDirectory, sourceName)
  const target = join(runtimeDirectory, targetName)
  copyFileSync(source, target)
  console.log(`Copied ${sourceName} (${statSync(target).size} bytes)`)
}
writeFileSync(join(runtimeDirectory, 'VERSION.txt'), `${process.version}\n`, 'utf8')
console.log(`Prepared bundled Node runtime ${process.version}.`)
