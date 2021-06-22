import { Untar } from 'https://deno.land/std@0.99.0/archive/tar.ts'
import { green, dim } from 'https://deno.land/std@0.99.0/fmt/colors.ts'
import { ensureDir } from 'https://deno.land/std@0.99.0/fs/ensure_dir.ts'
import { join } from 'https://deno.land/std@0.99.0/path/mod.ts'
import { gunzip } from 'https://deno.land/x/denoflate@1.2.1/mod.ts'
import { ensureTextFile } from '../shared/fs.ts'
import util from '../shared/util.ts'
import { defaultReactVersion } from '../shared/constants.ts'
import { VERSION } from '../version.ts'
import { x_brotli, x_flate } from '../server/compress.ts'

export const helpMessage = `
Usage:
    aleph init <name> [...options]

<name> represents the name of new app.

Options:
    -h, --help  Prints help message
`

export default async function (nameArg?: string) {
  const cwd = Deno.cwd()
  const rev = 'master'

  const name = nameArg || (await ask('Name:')).trim()
  if (name === '') {
    return
  }

  const template = 'hello-world' // todo: add template select ui
  const vscode = await confirm('Add recommended workspace settings of VS Code?')

  console.log('Downloading template...')
  const resp = await fetch('https://codeload.github.com/alephjs/alephjs-templates/tar.gz/' + rev)
  const gzData = await Deno.readAll(new Deno.Buffer(await resp.arrayBuffer()))

  console.log('Saving template...')
  const tarData = gunzip(gzData)
  const entryList = new Untar(new Deno.Buffer(tarData))

  for await (const entry of entryList) {
    if (entry.fileName.startsWith(`alephjs-templates-${rev}/${template}/`)) {
      const fp = join(cwd, name, util.trimPrefix(entry.fileName, `alephjs-templates-${rev}/${template}/`))
      if (entry.type === 'directory') {
        await ensureDir(fp)
        continue
      }
      await ensureTextFile(fp, '')
      const file = await Deno.open(fp, { write: true })
      await Deno.copy(entry, file)
    }
  }

  const gitignore = [
    '.DS_Store',
    'Thumbs.db',
    '.aleph/',
    'dist/',
  ]
  const importMap = {
    imports: {
      '~/': './',
      'aleph/': `https://deno.land/x/aleph@v${VERSION}/`,
      'aleph/types': `https://deno.land/x/aleph@v${VERSION}/types.ts`,
      'framework': `https://deno.land/x/aleph@v${VERSION}/framework/core/mod.ts`,
      'framework/react': `https://deno.land/x/aleph@v${VERSION}/framework/react/mod.ts`,
      'react': `https://esm.sh/react@${defaultReactVersion}`,
      'react-dom': `https://esm.sh/react-dom@${defaultReactVersion}`,
    },
    scopes: {}
  }
  await Promise.all([
    Deno.writeTextFile(join(cwd, name, '.gitignore'), gitignore.join('\n')),
    Deno.writeTextFile(join(cwd, name, 'import_map.json'), JSON.stringify(importMap, undefined, 2))
  ])

  const urls = Object.values(importMap.imports).filter(v => !v.endsWith('/'))
  const p = Deno.run({
    cmd: [Deno.execPath(), 'cache', ...urls, x_brotli, x_flate]
  })
  await p.status()
  p.close()

  if (vscode) {
    const extensions = {
      'recommendations': [
        'denoland.vscode-deno'
      ]
    }
    const settigns = {
      'deno.enable': true,
      'deno.unstable': true,
      'deno.importMap': './import_map.json'
    }
    await ensureDir(join(name, '.vscode'))
    await Promise.all([
      Deno.writeTextFile(join(name, '.vscode', 'extensions.json'), JSON.stringify(extensions, undefined, 2)),
      Deno.writeTextFile(join(name, '.vscode', 'settings.json'), JSON.stringify(settigns, undefined, 2))
    ])
  }

  console.log('Done')
  console.log(dim('---'))
  console.log(green('Aleph.js is ready to go!'))
  console.log(`${dim('$')} cd ${name}`)
  console.log(`${dim('$')} aleph dev     ${dim('# start the app in `development` mode')}`)
  console.log(`${dim('$')} aleph start   ${dim('# start the app in `production` mode')}`)
  console.log(`${dim('$')} aleph build   ${dim('# build the app to a static site (SSG)')}`)
  console.log(dim('---'))
  Deno.exit(0)
}

async function ask(question: string = ':', stdin = Deno.stdin, stdout = Deno.stdout) {
  await stdout.write(new TextEncoder().encode(question + ' '))
  const buf = new Uint8Array(1024)
  const n = <number>await stdin.read(buf)
  const answer = new TextDecoder().decode(buf.subarray(0, n))
  return answer.trim()
}

async function confirm(question: string = 'are you sure?') {
  let a: string
  while (!/^(y(es)?|no?)$/i.test(a = (await ask(question + ' ' + dim('[y/n]'))).trim())) { }
  return a.charAt(0).toLowerCase() === 'y'
}
