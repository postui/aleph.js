import { join } from 'https://deno.land/std@0.99.0/path/mod.ts'
import { serve } from 'https://deno.land/std@0.99.0/http/server.ts'
import log from '../shared/log.ts'
import { Request } from './api.ts'
import { getContentType } from './mime.ts'

/** proxy https://deno.land/x/aleph on localhost */
export async function localProxy(cwd: string, port: number) {
  const s = serve({ port })

  // ALEPH_DEV_PORT env tells the server we are in dev mode
  // for Aleph.js development
  if (Deno.env.get('ALEPH_DEV_PORT') !== port.toString()) {
    Deno.env.set('ALEPH_DEV_PORT', port.toString())
  }

  log.debug(`Proxy https://deno.land/x/aleph on http://localhost:${port}`)
  for await (const r of s) {
    const url = new URL('http://localhost' + r.url)
    const resp = new Request(r, {}, url.searchParams)
    const filepath = join(cwd, url.pathname)
    try {
      const info = await Deno.lstat(filepath)
      if (info.isDirectory) {
        const r = Deno.readDir(filepath)
        const items: string[] = []
        for await (const item of r) {
          if (!item.name.startsWith('.')) {
            items.push(`<li><a href='${join(url.pathname, encodeURI(item.name))}'>${item.name}${item.isDirectory ? '/' : ''}<a></li>`)
          }
        }
        resp.send(
          `<!DOCTYPE html><title>aleph.js/</title><h1>&nbsp;aleph.js/</h1><ul>${Array.from(items).join('')}</ul>`,
          'text/html; charset=utf-8'
        )
        return
      }
      resp.send(await Deno.readFile(filepath), getContentType(filepath))
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        resp.status(404).send('file not found')
        return
      }
      resp.status(500).send(err.message)
    }
  }
}
