import { Application } from '../server/app.ts'
import { serve } from '../server/stdserver.ts'
import { getFlag, parsePortNumber } from '../shared/flags.ts'

export const helpMessage = `
Usage:
    aleph dev <dir> [...options]

<dir> represents the directory of Aleph.js app,
if the <dir> is empty, the current directory will be used.

Options:
    -p, --port      <port>       A port number to start the Aleph.js app, default is 8080
        --hostname  <hostname>   The address at which the server is to be started
    -L, --log-level <log-level>  Set log level [possible values: debug, info]
    -r, --reload                 Reload source code cache
    -h, --help                   Prints help message
`

export default async function (workingDir: string, flags: Record<string, any>) {
  const app = new Application(workingDir, 'development', Boolean(flags.r || flags.reload))
  const hostname = getFlag(flags, ['hostname'])
  const port = parsePortNumber(getFlag(flags, ['p', 'port'], '8080'))
  await serve({ app, port, hostname })
}
