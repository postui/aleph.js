import { parse } from 'https://deno.land/std@0.99.0/flags/mod.ts'
import { red } from 'https://deno.land/std@0.99.0/fmt/colors.ts'
import { dirname, join } from 'https://deno.land/std@0.99.0/path/mod.ts'
import { existsSync } from 'https://deno.land/std@0.99.0/fs/exists.ts'

export async function checkVersion(version: string): Promise<string> {
  console.log('Looking up latest version...')

  const versionMetaUrl = 'https://cdn.deno.land/aleph/meta/versions.json'
  const { latest, versions } = await (await fetch(versionMetaUrl)).json()

  if (version === 'latest') {
    version = latest
  } else if (!versions.includes(version)) {
    version = 'v' + version
    if (!versions.includes(version)) {
      console.log(`${red('error')}: version(${version}) not found!`)
      Deno.exit(1)
    }
  }

  return version
}

export async function install(version: string, forceUpgrade = false) {
  const denoExecPath = Deno.execPath()
  const cmdExists = existsSync(join(dirname(denoExecPath), 'aleph'))
  const p = Deno.run({
    cmd: [
      denoExecPath,
      'install',
      '-A',
      '--unstable',
      '--location', 'http://localhost',
      '-n', 'aleph',
      '-f',
      `https://deno.land/x/aleph@${version}/cli.ts`
    ],
    stdout: 'null',
    stderr: 'inherit'
  })
  const status = await p.status()
  if (status.success) {
    if (cmdExists && !forceUpgrade) {
      console.log(`Aleph.js is up to ${version}`)
    } else {
      console.log('Aleph.js was installed successfully')
      console.log(`Run 'aleph -h' to get started`)
    }
  }
  Deno.exit(status.code)
}

if (import.meta.main) {
  const { _: args, ...options } = parse(Deno.args)
  const version = await checkVersion(options.v || options.version || args[0] || 'latest')
  await install(version, true)
}
