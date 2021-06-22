import { serve as stdServe, serveTLS, Server as StdServer } from 'https://deno.land/std@0.99.0/http/server.ts'
import log from '../shared/log.ts'
import type { ServerRequest } from '../types.ts'
import { Application } from './app.ts'
import compress from './compress.ts'
import { Server } from './server.ts'

/** Options for creating a standard Aleph server. */
export type ServeOptions = {
  /** The Aleph Server Application to serve. */
  app: Application
  /** The port to listen on. */
  port: number
  /** A literal IP address or host name that can be resolved to an IP address.
   * If not specified, defaults to `0.0.0.0`.
   */
  hostname?: string
  /** Server certificate file. */
  certFile?: string
  /** Server public key file. */
  keyFile?: string
  /* The signal to close the server. */
  signal?: AbortSignal
}

/** Create a standard Aleph server. */
export async function serve({ app, port, hostname, certFile, keyFile, signal }: ServeOptions) {
  const server = new Server(app)
  await app.ready

  while (true) {
    try {
      let s: AsyncIterable<ServerRequest>
      if (certFile && keyFile) {
        s = serveTLS({ port, hostname, certFile, keyFile })
      } else {
        s = stdServe({ port, hostname })
      }
      signal?.addEventListener('abort', () => {
        (s as StdServer).close()
      })
      if (!app.isDev && app.config.compress) {
        compress.init()
      }
      log.info(`Server ready on http://${hostname || 'localhost'}:${port}${app.config.basePath}`)
      for await (const r of s) {
        server.handle(r)
      }
    } catch (err) {
      if (err instanceof Deno.errors.AddrInUse) {
        if (!app.isDev) {
          log.fatal(`port ${port} already in use!`)
        }
        log.warn(`port ${port} already in use, try ${port + 1}...`)
        port++
      } else {
        log.fatal(err.message)
      }
    }
  }
}
