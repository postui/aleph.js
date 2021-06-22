import { serve } from 'https://deno.land/std@0.99.0/http/server.ts'
import { Application } from '../server/app.ts'
import { getFlag, parsePortNumber } from '../shared/flags.ts'
import log from '../shared/log.ts'

export const helpMessage = `
Usage:
    aleph analyze <dir> [...options]

<dir> represents the directory of Aleph.js app,
if the <dir> is empty, the current directory will be used.

Options:
    -p, --port      <port>       A port number to serve the analyze result, default is 9000
    -L, --log-level <log-level>  Set log level [possible values: debug, info]
    -r, --reload                 Reload source code cache
    -h, --help                   Prints help message
`

export default async function (workingDir: string, flags: Record<string, any>) {
  const app = new Application(workingDir, 'production', Boolean(flags.r || flags.reload))
  const port = parsePortNumber(getFlag(flags, ['p', 'port'], '9000'))
  await app.ready
  const entries = app.analyze()
  const s = serve({ port })
  log.info(`Server ready on http://localhost:${port}`)
  for await (const r of s) {
    r.respond({
      headers: new Headers({
        // todo: analyze page
        'content-type': 'application/json',
      }),
      body: JSON.stringify(entries)
    })
  }
}
