import { createHash } from 'https://deno.land/std@0.99.0/hash/mod.ts'
import { join } from 'https://deno.land/std@0.99.0/path/mod.ts'
import { acceptWebSocket, isWebSocketCloseEvent } from 'https://deno.land/std@0.99.0/ws/mod.ts'
import { SourceType, stripSsrCode } from '../compiler/mod.ts'
import { builtinModuleExts, trimBuiltinModuleExts } from '../framework/core/module.ts'
import { rewriteURL } from '../framework/core/routing.ts'
import { existsFile } from '../shared/fs.ts'
import log from '../shared/log.ts'
import util from '../shared/util.ts'
import { VERSION } from '../version.ts'
import type { ServerRequest } from '../types.ts'
import { Request } from './api.ts'
import { Application } from './app.ts'
import { getContentType } from './mime.ts'

/** The Aleph server class. */
export class Server {
  #app: Application
  #ready: boolean

  constructor(app: Application) {
    this.#app = app
    this.#ready = false
  }

  async handle(r: ServerRequest) {
    if (!this.#ready) {
      await this.#app.ready
      this.#ready = true
    }

    const app = this.#app
    const { basePath, headers, rewrites } = app.config
    const url = rewriteURL(r.url, basePath, rewrites)
    const pathname = decodeURI(url.pathname)
    const req = new Request(r, {}, url.searchParams)

    // set custom headers
    for (const key in headers) {
      req.setHeader(key, headers[key])
    }

    // in dev mode, we use `Last-Modified` and `ETag` header to control cache
    if (app.isDev) {
      req.setHeader('Cache-Control', 'max-age=0')
    }

    try {
      // serve hmr ws
      if (pathname === '/_hmr') {
        const { conn, r: bufReader, w: bufWriter, headers } = r
        const socket = await acceptWebSocket({ conn, bufReader, bufWriter, headers })
        const watcher = app.createFSWatcher()
        watcher.on('add', (mod: any) => socket.send(JSON.stringify({ ...mod, type: 'add' })))
        watcher.on('remove', (specifier: string) => {
          watcher.removeAllListeners('modify-' + specifier)
          socket.send(JSON.stringify({ type: 'remove', specifier }))
        })
        log.debug('hmr connected')
        for await (const e of socket) {
          if (util.isNEString(e)) {
            try {
              const data = JSON.parse(e)
              if (data.type === 'hotAccept' && util.isNEString(data.specifier)) {
                const mod = app.getModule(data.specifier)
                if (mod) {
                  log.debug('hmr on', mod.specifier)
                  watcher.on(`modify-${mod.specifier}`, (data) => {
                    socket.send(JSON.stringify({
                      ...data,
                      type: 'update',
                      specifier: mod.specifier,
                      updateUrl: util.cleanPath(`${basePath}/_aleph/${trimBuiltinModuleExts(mod.specifier)}.js`),
                    }))
                  })
                }
              }
            } catch (e) { }
          } else if (isWebSocketCloseEvent(e)) {
            break
          }
        }
        app.removeFSWatcher(watcher)
        log.debug('hmr closed')
        return
      }

      // serve dist files
      if (pathname.startsWith('/_aleph/')) {
        if (pathname.startsWith('/_aleph/data/') && pathname.endsWith('.json')) {
          const path = util.atobUrl(util.trimSuffix(util.trimPrefix(pathname, '/_aleph/data/'), '.json'))
          const data = await app.getSSRData({ pathname: path })
          if (data === null) {
            req.status(404).send('null', 'application/json; charset=utf-8')
          } else {
            req.send(JSON.stringify(data), 'application/json; charset=utf-8')
          }
          return
        }

        const relPath = util.trimPrefix(pathname, '/_aleph')
        if (relPath == '/main.js') {
          req.send(app.createMainJS(false), 'application/javascript; charset=utf-8')
          return
        }

        if (relPath.endsWith('.js')) {
          let module = app.findModule(({ jsFile }) => jsFile === relPath)
          if (!module && app.isDev) {
            for (const ext of [...builtinModuleExts.map(ext => `.${ext}`), '']) {
              const sepcifier = util.trimSuffix(relPath, '.js') + ext
              if (await existsFile(join(app.workingDir, sepcifier))) {
                module = await app.compile(sepcifier)
                break
              }
            }
          }
          if (module) {
            const { specifier } = module
            const content = await app.getModuleJS(module)
            if (content) {
              const etag = createHash('md5').update(VERSION).update(module.hash || module.sourceHash).toString()
              if (etag === r.headers.get('If-None-Match')) {
                req.status(304).send()
                return
              }

              req.setHeader('ETag', etag)
              if (app.isDev && app.isHMRable(specifier)) {
                let code = new TextDecoder().decode(content)
                if (module.denoHooks?.length || module.ssrPropsFn || module.ssgPathsFn) {
                  if ('csrCode' in module) {
                    code = (module as any).csrCode
                  } else {
                    const { code: csrCode } = await stripSsrCode(specifier, code, { sourceMap: true, swcOptions: { sourceType: SourceType.JS } })
                    Object.assign(module, { csrCode })
                    // todo: merge source map
                    code = csrCode
                  }
                }
                app.getCodeInjects('hmr', specifier)?.forEach(transform => {
                  const ret = transform(specifier, code)
                  code = ret.code
                })
                code = [
                  `import.meta.hot = window.$createHotContext(${JSON.stringify(specifier)});`,
                  '',
                  code,
                  '',
                  'import.meta.hot.accept();'
                ].join('\n')
                req.send(code, 'application/javascript; charset=utf-8')
              } else {
                req.send(content, 'application/javascript; charset=utf-8')
              }
              return
            }
          }
        }

        const filePath = join(app.buildDir, relPath)
        if (await existsFile(filePath)) {
          const info = Deno.lstatSync(filePath)
          const lastModified = info.mtime?.toUTCString() ?? (new Date).toUTCString()
          if (lastModified === r.headers.get('If-Modified-Since')) {
            req.status(304).send()
            return
          }

          req.setHeader('Last-Modified', lastModified)
          req.send(
            await Deno.readTextFile(filePath),
            getContentType(filePath)
          )
          return
        }

        req.status(404).send('not found')
        return
      }

      // serve public files
      const filePath = join(app.workingDir, 'public', pathname)
      if (await existsFile(filePath)) {
        const info = Deno.lstatSync(filePath)
        const lastModified = info.mtime?.toUTCString() ?? (new Date).toUTCString()
        if (lastModified === r.headers.get('If-Modified-Since')) {
          req.status(304).send()
          return
        }

        const body = Deno.readFileSync(filePath)
        req.setHeader('Last-Modified', lastModified)
        req.send(body, getContentType(filePath))
        return
      }

      // serve APIs
      if (pathname.startsWith('/api/')) {
        const route = await app.getAPIRoute({
          pathname,
          search: Array.from(url.searchParams.keys()).length > 0 ? '?' + url.searchParams.toString() : ''
        })
        if (route !== null) {
          try {
            const [{ params, query }, module] = route
            const { default: handle } = await app.importModule(module)
            if (util.isFunction(handle)) {
              await handle(new Request(req, params, query))
            } else {
              req.status(500).json({ status: 500, message: 'bad api handler' })
            }
          } catch (err) {
            req.status(500).json({ status: 500, message: err.message })
            log.error('invoke API:', err)
          }
        } else {
          req.status(404).json({ status: 404, message: 'not found' })
        }
        return
      }

      // ssr
      const [status, html] = await app.getPageHTML({
        pathname,
        search: Array.from(url.searchParams.keys()).length > 0 ? '?' + url.searchParams.toString() : ''
      })
      req.status(status).send(html, 'text/html; charset=utf-8')
    } catch (err) {
      req.status(500).send(
        [
          `<!DOCTYPE html>`,
          `<title>Server Error</title>`,
          `<h1>Error: ${err.message}</h1>`,
          `<p><pre>${err.stack}</pre></p>`
        ].join('\n'),
        'text/html; charset=utf-8'
      )
    }
  }
}
