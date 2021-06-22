import { bold, dim } from 'https://deno.land/std@0.99.0/fmt/colors.ts'
import { indexOf, copy, equals } from 'https://deno.land/std@0.99.0/bytes/mod.ts'
import { ensureDir } from 'https://deno.land/std@0.99.0/fs/ensure_dir.ts'
import { walk } from 'https://deno.land/std@0.99.0/fs/walk.ts'
import { createHash } from 'https://deno.land/std@0.99.0/hash/mod.ts'
import { basename, dirname, extname, join, resolve } from 'https://deno.land/std@0.99.0/path/mod.ts'
import { Bundler, bundlerRuntimeCode, simpleJSMinify } from '../bundler/mod.ts'
import type { TransformOptions } from '../compiler/mod.ts'
import { wasmChecksum, parseExportNames, SourceType, transform } from '../compiler/mod.ts'
import { EventEmitter } from '../framework/core/events.ts'
import { builtinModuleExts, toPagePath, trimBuiltinModuleExts } from '../framework/core/module.ts'
import { Routing } from '../framework/core/routing.ts'
import { ensureTextFile, existsDir, existsFile, lazyRemove } from '../shared/fs.ts'
import log, { Measure } from '../shared/log.ts'
import util from '../shared/util.ts'
import type { ImportMap, RouterURL, ServerApplication } from '../types.ts'
import { VERSION } from '../version.ts'
import { Analyzer } from './analyzer.ts'
import { cache } from './cache.ts'
import type { RequiredConfig } from './config.ts'
import {
  defaultConfig, fixConfigAndImportMap, getDefaultImportMap,
  isBuiltinCSSLoader, loadConfig, loadImportMap
} from './config.ts'
import {
  checkAlephDev, checkDenoVersion, clearBuildCache, computeHash, findFile,
  getAlephPkgUri, getDenoDir, getSourceType, isLoaderPlugin, isLocalUrl,
  moduleExclude, toLocalPath, toRelativePath
} from './helper.ts'
import { getContentType } from './mime.ts'
import { Renderer } from './ssr.ts'

/** A module includes the compilation details. */
export type Module = {
  specifier: string
  deps: DependencyDescriptor[]
  external?: boolean
  isStyle?: boolean
  externalRemoteDeps?: boolean
  ssrPropsFn?: string
  ssgPathsFn?: boolean
  denoHooks?: string[]
  hash?: string
  sourceHash: string
  jsFile: string
  jsBuffer?: Uint8Array
  ready: Promise<void>
}

type ModuleSource = {
  code: string
  type: SourceType
  isStyle: boolean
  map?: string
}

type DependencyDescriptor = {
  specifier: string
  isDynamic?: boolean
  hashLoc?: number
}

type CompileOptions = {
  source?: ModuleSource,
  forceRefresh?: boolean,
  ignoreDeps?: boolean,
  externalRemoteDeps?: boolean
}

type Transformer = { test?: RegExp | string, fn: TransformFn }
type TransformFn = (specifier: string, code: string, map?: string) => { code: string, map?: string }

/** The application class for aleph server. */
export class Application implements ServerApplication {
  readonly mode: 'development' | 'production'
  readonly workingDir: string
  readonly buildDir: string
  readonly config: RequiredConfig
  readonly importMap: ImportMap
  readonly ready: Promise<void>

  #modules: Map<string, Module> = new Map()
  #appModule: Module | null = null
  #pageRouting: Routing = new Routing()
  #apiRouting: Routing = new Routing()
  #fsWatchListeners: Array<EventEmitter> = []
  #analyzer: Analyzer = new Analyzer(this)
  #bundler: Bundler = new Bundler(this)
  #renderer: Renderer = new Renderer(this)
  #dists: Set<string> = new Set()
  #injects: Map<string, Transformer[]> = new Map()
  #reloading = false

  constructor(
    workingDir = '.',
    mode: 'development' | 'production' = 'production',
    reload = false
  ) {
    checkDenoVersion()
    checkAlephDev()
    this.mode = mode
    this.workingDir = resolve(workingDir)
    this.buildDir = join(this.workingDir, '.aleph', mode)
    this.config = { ...defaultConfig() }
    this.importMap = { imports: {}, scopes: {} }
    this.ready = Deno.env.get('DENO_TESTING') ? Promise.resolve() : this.init(reload)
  }

  /** initiate application */
  private async init(reload: boolean) {
    const ms = new Measure()

    let [importMapFile, configFile] = await Promise.all([
      await findFile(this.workingDir, ['import_map', 'import-map', 'importmap', 'importMap'].map(name => `${name}.json`)),
      await findFile(this.workingDir, ['ts', 'js', 'mjs', 'json'].map(ext => `aleph.config.${ext}`))
    ])
    if (importMapFile) {
      Object.assign(this.importMap, await loadImportMap(importMapFile))
    } else {
      Object.assign(this.importMap, getDefaultImportMap())
    }
    if (configFile) {
      if (!configFile.endsWith('.json')) {
        const mod = await this.compile(`/${basename(configFile)}`, { externalRemoteDeps: true })
        configFile = join(this.buildDir, mod.jsFile)
      }
      Object.assign(this.config, await loadConfig(configFile))
      this.#pageRouting = new Routing(this.config)
    }

    await fixConfigAndImportMap(this.workingDir, this.config, this.importMap)
    ms.stop('load config')

    // load .env files
    for await (const { path: p, } of walk(this.workingDir, { match: [/(^|\/|\\)\.env(\.|$)/i], maxDepth: 1 })) {
      const text = await Deno.readTextFile(p)
      text.split('\n').forEach(line => {
        let [key, value] = util.splitBy(line, '=')
        key = key.trim()
        if (key) {
          Deno.env.set(key, value.trim())
        }
      })
      log.info('load env from', basename(p))
    }
    Deno.env.set('ALEPH_ENV', this.mode)
    Deno.env.set('ALEPH_FRAMEWORK', this.config.framework)
    Deno.env.set('ALEPH_VERSION', VERSION)

    const alephPkgUri = getAlephPkgUri()
    const srcDir = join(this.workingDir, this.config.srcDir)
    const apiDir = join(srcDir, 'api')
    const pagesDir = join(srcDir, 'pages')
    const buildManifestFile = join(this.buildDir, 'build.manifest.json')
    const configHash = computeHash(JSON.stringify({
      importMap: this.importMap,
      plugins: this.config.plugins.map(({ name }) => name),
      css: {
        modules: this.config.css.modules,
        postcssPlugins: this.config.css.postcss?.plugins.map(p => {
          if (util.isString(p)) {
            return p
          } else if (util.isArray(p)) {
            return p[0]
          } else {
            return 'Plugin'
          }
        })
      },
      react: this.config.react,
    }, (key: string, value: any) => {
      if (key === 'inlineStylePreprocess') {
        return void 0
      }
      return value
    }))
    let shouldRebuild = !await existsFile(buildManifestFile)
    if (!shouldRebuild) {
      try {
        const v = JSON.parse(await Deno.readTextFile(buildManifestFile))
        shouldRebuild = (
          typeof v !== 'object' ||
          v === null ||
          v.compiler !== wasmChecksum ||
          v.configHash !== configHash
        )
      } catch (e) { }
    }

    this.#reloading = reload
    if (reload || shouldRebuild) {
      if (await existsDir(this.buildDir)) {
        await Deno.remove(this.buildDir, { recursive: true })
      }
      await ensureDir(this.buildDir)
    }

    if (shouldRebuild) {
      log.debug('rebuild...')
      ensureTextFile(buildManifestFile, JSON.stringify({
        aleph: VERSION,
        deno: Deno.version.deno,
        compiler: wasmChecksum,
        configHash,
      }, undefined, 2))
    }

    ms.stop()

    // init framework
    const { init } = await import(`../framework/${this.config.framework}/init.ts`)
    await init(this)

    // compile & import framework renderer
    if (this.config.ssr) {
      const mod = await this.compile(`${alephPkgUri}/framework/${this.config.framework}/renderer.ts`)
      const { render } = await this.importModule(mod)
      if (util.isFunction(render)) {
        this.#renderer.setFrameworkRenderer({ render })
      }
    }

    ms.stop(`init ${this.config.framework} framework`)

    // apply server plugins
    await Promise.all(
      this.config.plugins.map(async plugin => {
        if (plugin.type === 'server') {
          await plugin.setup(this)
        }
      })
    )

    ms.stop('apply plugins')

    const appFile = await findFile(this.workingDir, builtinModuleExts.map(ext => `app.${ext}`))
    const modules: string[] = []
    const moduleWalkOptions = {
      includeDirs: false,
      skip: moduleExclude
    }

    // pre-compile framework modules
    modules.push(`${alephPkgUri}/framework/${this.config.framework}/bootstrap.ts`)
    if (this.isDev) {
      modules.push(`${alephPkgUri}/framework/core/hmr.ts`)
      modules.push(`${alephPkgUri}/framework/core/nomodule.ts`)
    }
    if (appFile) {
      modules.push(`/${basename(appFile)}`)
    }

    if (await existsDir(apiDir)) {
      for await (const { path: p } of walk(apiDir, { ...moduleWalkOptions, exts: builtinModuleExts })) {
        const specifier = util.cleanPath('/api/' + util.trimPrefix(p, apiDir))
        this.#apiRouting.update(...this.createRouteUpdate(specifier))
      }
    }

    if (await existsDir(pagesDir)) {
      for await (const { path: p } of walk(pagesDir, moduleWalkOptions)) {
        const specifier = util.cleanPath('/pages/' + util.trimPrefix(p, pagesDir))
        if (this.isPageModule(specifier)) {
          this.#pageRouting.update(...this.createRouteUpdate(specifier))
          if (!this.isDev) {
            modules.push(specifier)
          }
        }
      }
    }

    // wait all compilation tasks are done
    await Promise.all(modules.map(specifier => this.compile(specifier)))

    // bundle
    if (!this.isDev) {
      await this.bundle()
    }

    // end reload
    if (reload) {
      this.#reloading = false
    }

    ms.stop('init project')

    if (this.isDev) {
      this.watch()
    }
  }

  /** watch file changes, re-compile modules, and send HMR signal to client. */
  private async watch() {
    const srcDir = join(this.workingDir, this.config.srcDir)
    const w = Deno.watchFs(srcDir, { recursive: true })
    log.info('Start watching code changes...')
    for await (const event of w) {
      for (const path of event.paths) {
        const specifier = util.cleanPath(util.trimPrefix(path, srcDir))
        if (this.isScopedModule(specifier)) {
          util.debounceX(
            specifier,
            () => this.watchHandler(path, specifier),
            50
          )
        }
      }
    }
  }

  private async watchHandler(path: string, specifier: string): Promise<void> {
    if (await existsFile(path)) {
      if (this.#modules.has(specifier)) {
        try {
          const prevModule = this.#modules.get(specifier)!
          const module = await this.compile(specifier, {
            forceRefresh: true,
            ignoreDeps: true,
            externalRemoteDeps: specifier.startsWith('/api/')
          })
          const refetchPage = (
            this.config.ssr &&
            (
              !(
                util.isNEArray(prevModule.denoHooks) &&
                util.isNEArray(module.denoHooks) &&
                prevModule.denoHooks.join(';') === module.denoHooks.join(';')
              ) ||
              prevModule.ssrPropsFn !== module.ssrPropsFn
            )
          )
          const hmrable = this.isHMRable(specifier)
          if (hmrable) {
            this.#fsWatchListeners.forEach(e => {
              e.emit('modify-' + module.specifier, { refetchPage: refetchPage || undefined })
            })
          }
          this.applyCompilationSideEffect(module, ({ specifier }) => {
            if (!hmrable && this.isHMRable(specifier)) {
              log.debug('compilation side-effect:', specifier, dim('<-'), module.specifier)
              this.#fsWatchListeners.forEach(e => {
                e.emit('modify-' + specifier, { refetchPage: refetchPage || undefined })
              })
            }
          })
          log.info('modify', specifier)
        } catch (err) {
          log.error(`compile(${specifier}):`, err.message)
        }
      } else {
        let routePath: string | undefined = undefined
        let isIndex: boolean | undefined = undefined
        let emit = false
        if (this.isPageModule(specifier)) {
          let isNewModule = true
          this.#pageRouting.lookup(routes => {
            routes.forEach(({ module }) => {
              if (module === specifier) {
                isNewModule = false
                return false
              }
            })
          })
          if (isNewModule) {
            const [path, _, index] = this.createRouteUpdate(specifier)
            routePath = path
            isIndex = index
            emit = true
          }
        }
        if (trimBuiltinModuleExts(specifier) === '/app') {
          await this.compile(specifier)
          emit = true
        }
        if (emit) {
          this.#fsWatchListeners.forEach(e => {
            e.emit('add', { specifier, routePath, isIndex })
          })
        }
      }
    } else if (this.#modules.has(specifier)) {
      this.#modules.delete(specifier)
      if (trimBuiltinModuleExts(specifier) === '/app') {
        this.#renderer.clearCache()
        this.#fsWatchListeners.forEach(e => e.emit('remove', specifier))
      } else if (specifier.startsWith('/pages/') && this.isPageModule(specifier)) {
        const [routePath] = this.createRouteUpdate(specifier)
        this.#pageRouting.removeRouteByModule(specifier)
        this.#renderer.clearCache(routePath)
        this.#fsWatchListeners.forEach(e => e.emit('remove', specifier))
      } else if (specifier.startsWith('/api/')) {
        this.#apiRouting.removeRouteByModule(specifier)
      }
      log.info('remove', specifier)
    }
  }

  /** check the file whether it is a scoped module. */
  private isScopedModule(specifier: string) {
    // is compiled module
    if (this.#modules.has(specifier)) {
      return true
    }

    if (moduleExclude.some(r => r.test(specifier))) {
      return false
    }

    // is page module by plugin
    if (this.isPageModule(specifier)) {
      return true
    }

    for (const ext of builtinModuleExts) {
      if (
        specifier.endsWith('.' + ext) &&
        (
          specifier.startsWith('/api/') ||
          util.trimSuffix(specifier, '.' + ext) === '/app'
        )
      ) {
        return true
      }
    }

    return false
  }

  get isDev() {
    return this.mode === 'development'
  }

  get loaders() {
    return this.config.plugins.filter(isLoaderPlugin)
  }

  /** get the module by given specifier. */
  getModule(specifier: string): Module | null {
    if (specifier === 'app') {
      return this.#appModule
    }
    if (this.#modules.has(specifier)) {
      return this.#modules.get(specifier)!
    }
    return null
  }

  /** get the first module in the modules map where predicate is true, and null otherwise. */
  findModule(predicate: (module: Module) => boolean): Module | null {
    for (const specifier of this.#modules.keys()) {
      const module = this.#modules.get(specifier)!
      if (predicate(module)) {
        return module
      }
    }
    return null
  }

  /** get api route by given location. */
  async getAPIRoute(location: { pathname: string, search?: string }): Promise<[RouterURL, Module] | null> {
    const router = this.#apiRouting.createRouter(location)
    if (router !== null) {
      const [url, nestedModules] = router
      if (url.routePath !== '') {
        const specifier = nestedModules.pop()!
        if (this.#modules.has(specifier)) {
          return [url, this.#modules.get(specifier)!]
        }
        const module = await this.compile(specifier, { externalRemoteDeps: true })
        return [url, module]
      }
    }
    return null
  }

  /** add a module by given path and optional source code. */
  async addModule(specifier: string, sourceCode?: string): Promise<void> {
    const source = sourceCode ? {
      code: sourceCode,
      type: SourceType.TSX,
      external: false,
      isStyle: false,
    } : undefined
    if (source !== undefined) {
      const type = getSourceType(specifier)
      if (type !== SourceType.Unknown) {
        source.type = type
      }
    }
    await this.compile(specifier, { source })
    if (specifier.startsWith('/pages/')) {
      this.#pageRouting.update(...this.createRouteUpdate(specifier))
    } else if (specifier.startsWith('/api/')) {
      this.#apiRouting.update(...this.createRouteUpdate(specifier))
    }
    return
  }

  /** add a dist. */
  async addDist(path: string, content: Uint8Array): Promise<void> {
    const pathname = util.cleanPath(path)
    const savePath = join(this.buildDir, pathname)
    if (!await existsFile(savePath)) {
      const saveDir = dirname(savePath)
      await ensureDir(saveDir)
      await clearBuildCache(savePath, extname(savePath).slice(1))
      await Deno.writeFile(savePath, content)
    }
    this.#dists.add(pathname)
  }

  /** inject code */
  injectCode(phase: 'compilation' | 'hmr' | 'ssr', test: string | RegExp, transform: TransformFn): void
  injectCode(phase: 'compilation' | 'hmr' | 'ssr', transform: TransformFn): void
  injectCode(phase: 'compilation' | 'hmr' | 'ssr', ...rest: any[]): void {
    let inject: Transformer = {
      fn: rest[0],
    }
    if (rest.length === 2) {
      inject.test = rest[0]
      inject.fn = rest[1]
    }
    if (util.isFunction(inject.fn)) {
      if (this.#injects.has(phase)) {
        this.#injects.get(phase)!.push(inject)
      } else {
        this.#injects.set(phase, [inject])
      }
    }
  }

  /** get code injects */
  getCodeInjects(phase: 'compilation' | 'hmr' | 'ssr', specifier: string): TransformFn[] {
    return this.#injects.get(phase)?.filter(({ test }) => {
      if (test === undefined || test === '') {
        return true
      }
      if (test instanceof RegExp) {
        return test.test(specifier)
      }
      return test === specifier
    }).map(({ fn }) => fn) || []
  }

  /** get ssr data */
  async getSSRData(loc: { pathname: string, search?: string }): Promise<any> {
    const [router, nestedModules] = this.#pageRouting.createRouter(loc)
    const { routePath } = router
    if (routePath === '' || !this.isSSRable(router.pathname)) {
      return null
    }

    await Promise.all(
      nestedModules
        .filter(specifier => !this.#modules.has(specifier))
        .map(specifier => this.compile(specifier))
    )

    let useDeno = false
    let ssrProps = false
    for (const specifier of ['app', ...nestedModules]) {
      const mod = this.getModule(specifier)
      if (mod) {
        if (mod.denoHooks?.length) {
          useDeno = true
        } else {
          this.lookupDeps(mod.specifier, dep => {
            const depMod = this.getModule(dep.specifier)
            if (depMod?.denoHooks?.length) {
              useDeno = true
              return false
            }
          })
        }
        if (useDeno) {
          break
        }
      }
    }
    const mod = this.getModule(nestedModules[nestedModules.length - 1])
    if (mod && mod.ssrPropsFn) {
      ssrProps = true
    }
    if (!useDeno && !ssrProps) {
      return {}
    }

    const path = loc.pathname + (loc.search || '')
    const [_, data] = await this.#renderer.cache(routePath, path, async () => {
      return await this.#renderer.renderPage(router, nestedModules)
    })
    return data
  }

  /** get ssr page */
  async getPageHTML(loc: { pathname: string, search?: string }): Promise<[number, string]> {
    const [router, nestedModules] = this.#pageRouting.createRouter(loc)
    const { routePath } = router
    const status = routePath !== '' ? 200 : 404
    const path = loc.pathname + (loc.search || '')

    if (!this.isSSRable(loc.pathname)) {
      const [html] = await this.#renderer.cache('-', 'spa-index', async () => {
        return [await this.#renderer.renderSPAIndexPage(), null]
      })
      return [status, html]
    }

    if (routePath === '') {
      const [html] = await this.#renderer.cache('404', path, async () => {
        const [_, nestedModules] = this.#pageRouting.createRouter({ pathname: '/404' })
        if (nestedModules.length > 0) {
          await this.compile(nestedModules[0])
        }
        return await this.#renderer.renderPage(router, nestedModules.slice(0, 1))
      })
      return [status, html]
    }

    const [html] = await this.#renderer.cache(routePath, path, async () => {
      await Promise.all(
        nestedModules
          .filter(specifier => !this.#modules.has(specifier))
          .map(specifier => this.compile(specifier))
      )
      return await this.#renderer.renderPage(router, nestedModules)
    })
    return [status, html]
  }



  /** create a fs watcher.  */
  createFSWatcher(): EventEmitter {
    const e = new EventEmitter()
    this.#fsWatchListeners.push(e)
    return e
  }

  /** remove the fs watcher.  */
  removeFSWatcher(e: EventEmitter) {
    e.removeAllListeners()
    const index = this.#fsWatchListeners.indexOf(e)
    if (index > -1) {
      this.#fsWatchListeners.splice(index, 1)
    }
  }

  /** check the module whether it is page. */
  isPageModule(specifier: string): boolean {
    if (!specifier.startsWith('/pages/')) {
      return false
    }
    if (builtinModuleExts.some(ext => specifier.endsWith('.' + ext))) {
      return true
    }
    return this.loaders.some(p => p.type === 'loader' && p.test.test(specifier) && p.allowPage)
  }

  /** check the module whether it is hmrable. */
  isHMRable(specifier: string): boolean {
    if (util.isLikelyHttpURL(specifier)) {
      return false
    }

    for (const ext of builtinModuleExts) {
      if (specifier.endsWith('.' + ext)) {
        return (
          specifier.startsWith('/pages/') ||
          specifier.startsWith('/components/') ||
          util.trimSuffix(specifier, '.' + ext) === '/app'
        )
      }
    }

    const mod = this.#modules.get(specifier)
    if (mod && mod.isStyle) {
      return true
    }

    return this.loaders.some(p => (
      p.test.test(specifier) &&
      (p.acceptHMR || p.allowPage)
    ))
  }

  /** create main bootstrap script in javascript. */
  createMainJS(bundleMode = false): string {
    const alephPkgUri = getAlephPkgUri()
    const alephPkgPath = alephPkgUri.replace('https://', '').replace('http://localhost:', 'http_localhost_')
    const { basePath: basePath, defaultLocale, framework } = this.config
    const { routes } = this.#pageRouting
    const config: Record<string, any> = {
      basePath,
      appModule: this.#appModule?.specifier,
      routes,
      renderMode: this.config.ssr ? 'ssr' : 'spa',
      defaultLocale,
      locales: [],
      rewrites: this.config.rewrites,
    }

    if (bundleMode) {
      return [
        `__ALEPH.basePath = ${JSON.stringify(basePath)};`,
        `__ALEPH.pack["${alephPkgUri}/framework/${framework}/bootstrap.ts"].default(${JSON.stringify(config)});`
      ].join('')
    }

    let code = [
      `import bootstrap from "./-/${alephPkgPath}/framework/${framework}/bootstrap.js";`,
      this.isDev && `import { createHotContext, connect } from "./-/${alephPkgPath}/framework/core/hmr.js";`,
      this.isDev && `window.$createHotContext = createHotContext;`,
      this.isDev && `connect(${JSON.stringify(basePath)});`,
      `bootstrap(${JSON.stringify(config, undefined, this.isDev ? 2 : undefined)});`
    ].filter(Boolean).join('\n')
    this.getCodeInjects('compilation', '/main.js').forEach(transform => {
      const ret = transform('/main.js', code)
      code = ret.code
    })
    return code
  }

  /** get ssr html scripts */
  getSSRHTMLScripts(entryFile?: string) {
    const { framework } = this.config
    const basePath = util.trimSuffix(this.config.basePath, '/')
    const alephPkgPath = getAlephPkgUri().replace('https://', '').replace('http://localhost:', 'http_localhost_')

    if (this.isDev) {
      const preload: string[] = [
        `/framework/core/module.js`,
        `/framework/core/events.js`,
        `/framework/core/routing.js`,
        `/framework/core/hmr.js`,
        `/framework/${framework}/bootstrap.js`,
        `/shared/util.js`,
      ].map(p => `${basePath}/_aleph/-/${alephPkgPath}${p}`)

      if (this.#appModule) {
        preload.push(`${basePath}/_aleph/app.js`)
      }

      if (entryFile) {
        preload.push(`${basePath}/_aleph${entryFile}`)
      }

      return [
        ...preload.map(src => ({ src, type: 'module', preload: true })),
        { src: `${basePath}/_aleph/main.js`, type: 'module' },
        { src: `${basePath}/_aleph/-/${alephPkgPath}/nomodule.js`, nomodule: true },
      ]
    }

    return [
      simpleJSMinify(bundlerRuntimeCode),
      ... this.#bundler.getSyncChunks().map(filename => ({
        src: `${basePath}/_aleph/${filename}`
      }))
    ]
  }

  /** parse the export names of the module. */
  async parseModuleExportNames(specifier: string): Promise<string[]> {
    const { content, contentType } = await this.fetch(specifier)
    const sourceType = getSourceType(specifier, contentType || undefined)
    if (sourceType === SourceType.Unknown || sourceType === SourceType.CSS) {
      return []
    }
    const code = (new TextDecoder).decode(content)
    const names = await parseExportNames(specifier, code, { sourceType })
    return (await Promise.all(names.map(async name => {
      if (name.startsWith('{') && name.startsWith('}')) {
        return await this.parseModuleExportNames(name.slice(1, -1))
      }
      return name
    }))).flat()
  }

  /** common compiler options */
  get commonCompileOptions(): TransformOptions {
    return {
      workingDir: this.workingDir,
      alephPkgUri: getAlephPkgUri(),
      importMap: this.importMap,
      inlineStylePreprocess: async (key: string, type: string, tpl: string) => {
        if (type !== 'css') {
          for (const loader of this.loaders) {
            if (loader.test.test(`.${type}`) && loader.load) {
              const { code, type } = await loader.load({ specifier: key, data: (new TextEncoder).encode(tpl) }, this)
              if (type === 'css') {
                tpl = code
              }
            }
          }
        }
        for (const loader of this.loaders) {
          if (loader.test.test('.css') && loader.load) {
            const { code, type } = await loader.load({ specifier: key, data: (new TextEncoder).encode(tpl) }, this)
            if (type === 'css') {
              return code
            }
          }
        }
        return tpl
      },
      isDev: this.isDev,
      react: this.config.react,
    }
  }

  analyze() {
    this.#analyzer.reset()
    this.#pageRouting.lookup(routes => {
      routes.forEach(({ module: specifier }) => {
        const module = this.getModule(specifier)
        if (module) {
          this.#analyzer.addEntry(module)
        }
      })
    })
    return this.#analyzer.entries
  }

  /** build the application to a static site(SSG) */
  async build() {
    const start = performance.now()

    // wait for app ready
    await this.ready

    const outputDir = join(this.workingDir, this.config.outputDir)
    const distDir = join(outputDir, '_aleph')

    // clean previous build
    if (await existsDir(outputDir)) {
      for await (const entry of Deno.readDir(outputDir)) {
        await Deno.remove(join(outputDir, entry.name), { recursive: entry.isDirectory })
      }
    }

    // copy bundle dist
    await this.#bundler.copyDist()

    // ssg
    await this.ssg()

    // copy public assets
    const publicDir = join(this.workingDir, 'public')
    if (await existsDir(publicDir)) {
      for await (const { path: p } of walk(publicDir, { includeDirs: false, skip: [/(^|\/|\\)\./] })) {
        const rp = util.trimPrefix(p, publicDir)
        const fp = join(outputDir, rp)
        await ensureDir(dirname(fp))
        await Deno.copyFile(p, fp)
      }
    }

    // copy custom dist files
    if (this.#dists.size > 0) {
      Promise.all(Array.from(this.#dists.values()).map(async path => {
        const src = join(this.buildDir, path)
        if (await existsFile(src)) {
          const dest = join(distDir, path)
          await ensureDir(dirname(dest))
          return Deno.copyFile(src, dest)
        }
      }))
    }

    log.info(`Done in ${Math.round(performance.now() - start)}ms`)
  }

  private createRouteUpdate(specifier: string): [string, string, boolean | undefined] {
    const isBuiltinModuleType = builtinModuleExts.some(ext => specifier.endsWith('.' + ext))
    let routePath = isBuiltinModuleType ? toPagePath(specifier) : util.trimSuffix(specifier, '/pages')
    let isIndex: boolean | undefined = undefined

    if (!isBuiltinModuleType) {
      for (const loader of this.loaders) {
        if (loader.test.test(specifier) && loader.allowPage && loader.resolve) {
          const { pagePath, isIndex: _isIndex } = loader.resolve(specifier)
          if (util.isNEString(pagePath)) {
            routePath = pagePath
            if (!!_isIndex) {
              isIndex = true
            }
            break
          }
        }
      }
    } else if (routePath !== '/') {
      for (const ext of builtinModuleExts) {
        if (specifier.endsWith('/index.' + ext)) {
          isIndex = true
          break
        }
      }
    }

    return [routePath, specifier, isIndex]
  }

  /** fetch resource by the url. */
  async fetch(url: string): Promise<{ content: Uint8Array, contentType: string | null }> {
    if (!util.isLikelyHttpURL(url)) {
      const filepath = join(this.workingDir, this.config.srcDir, util.trimPrefix(url, 'file://'))
      if (await existsFile(filepath)) {
        const content = await Deno.readFile(filepath)
        return { content, contentType: getContentType(filepath) }
      } else {
        return Promise.reject(new Error(`No such file`))
      }
    }

    // append `dev` query for development mode
    if (this.isDev && url.startsWith('https://esm.sh/')) {
      const u = new URL(url)
      if (!u.searchParams.has('dev')) {
        u.searchParams.set('dev', '')
        u.search = u.search.replace('dev=', 'dev')
        url = u.toString()
      }
    }

    return await cache(url, {
      forceRefresh: this.#reloading,
      retryTimes: 10
    })
  }

  async importModule<T = any>({ jsFile, hash, sourceHash }: Module): Promise<T> {
    return await import(`file://${join(this.buildDir, jsFile)}#${(hash || sourceHash).slice(0, 6)}`)
  }

  async getModuleJS(module: Module): Promise<Uint8Array | null> {
    const { jsFile, jsBuffer } = module
    if (jsBuffer) {
      return jsBuffer
    }

    const cacheFp = join(this.buildDir, jsFile)
    if (await existsFile(cacheFp)) {
      const content = await Deno.readFile(cacheFp)
      module.jsBuffer = content
      log.debug(`load '${jsFile}'` + dim(' • ' + util.formatBytes(content.length)))
      return content
    }

    return null
  }

  async loadModuleSource(specifier: string, data?: any): Promise<ModuleSource> {
    let sourceCode: string = ''
    let sourceType: SourceType = SourceType.Unknown
    let sourceMap: string | null = null
    let loader = this.loaders.find(l => l.test.test(specifier))
    let isStyle = loader !== undefined && isBuiltinCSSLoader(loader)

    if (loader && util.isFunction(loader.load)) {
      const { code, type = 'js', map } = await loader.load({ specifier, data }, this)
      switch (type) {
        case 'js':
          sourceType = SourceType.JS
          break
        case 'jsx':
          sourceType = SourceType.JSX
          break
        case 'ts':
          sourceType = SourceType.TS
          break
        case 'tsx':
          sourceType = SourceType.TSX
          break
        case 'css':
          sourceType = SourceType.CSS
          break
      }
      sourceCode = code
      sourceMap = map || null
    } else {
      const source = await this.fetch(specifier)
      sourceType = getSourceType(specifier, source.contentType || undefined)
      if (sourceType !== SourceType.Unknown) {
        sourceCode = (new TextDecoder).decode(source.content)
      }
    }

    if (sourceType === SourceType.CSS) {
      isStyle = true
      for (const loader of this.loaders) {
        if (loader.test.test('.css') && util.isFunction(loader.load)) {
          // todo: covert source map
          const { code, type = 'js' } = await loader.load({ specifier, data: sourceCode }, this)
          if (type === 'js') {
            sourceCode = code
            sourceType = SourceType.JS
          }
        }
      }
    }

    return {
      code: sourceCode,
      type: sourceType,
      isStyle,
      map: sourceMap ? sourceMap : undefined
    }
  }

  /** compile the module by given specifier */
  async compile(specifier: string, options: CompileOptions = {}) {
    const [module, source] = await this.initModule(specifier, options)
    if (!module.external) {
      await this.transpileModule(module, source, options.ignoreDeps)
    }
    return module
  }

  private async initModule(specifier: string, { source: customSource, forceRefresh, externalRemoteDeps }: CompileOptions = {}): Promise<[Module, ModuleSource | null]> {
    let external = false
    let data: any = null

    if (customSource === undefined) {
      for (const l of this.loaders) {
        if (util.isFunction(l.resolve) && l.test.test(specifier)) {
          const ret = l.resolve(specifier)
          specifier = ret.specifier
          external = Boolean(ret.external)
          data = ret.data
          break
        }
      }
    }

    if (external) {
      return [{
        specifier,
        deps: [],
        external,
        sourceHash: '',
        jsFile: '',
        ready: Promise.resolve()
      }, null]
    }

    let mod = this.#modules.get(specifier)
    if (mod && !forceRefresh && !(!externalRemoteDeps && mod.externalRemoteDeps)) {
      await mod.ready
      return [mod, null]
    }

    const isRemote = util.isLikelyHttpURL(specifier) && !isLocalUrl(specifier)
    const localPath = toLocalPath(specifier)
    const name = trimBuiltinModuleExts(basename(localPath))
    const jsFile = join(dirname(localPath), `${name}.js`)
    const cacheFp = join(this.buildDir, jsFile)
    const metaFp = cacheFp.slice(0, -3) + '.meta.json'

    let defer = (err?: Error) => { }
    let source: ModuleSource | null = null
    mod = {
      specifier,
      deps: [],
      sourceHash: '',
      externalRemoteDeps,
      jsFile,
      ready: new Promise((resolve, reject) => {
        defer = (err?: Error) => {
          if (err) {
            this.#modules.delete(specifier)
            reject(err)
          } else {
            resolve()
          }
        }
      })
    }

    this.#modules.set(specifier, mod)
    if (trimBuiltinModuleExts(specifier) === '/app') {
      this.#appModule = mod
    }

    if (isRemote && !this.#reloading) {
      if (!await existsFile(metaFp) || !await existsFile(cacheFp)) {
        const globalCacheFp = join(await getDenoDir(), `gen/aleph-${wasmChecksum}`, jsFile)
        const globalMetaFp = `${globalCacheFp.slice(0, -3)}.meta.json`
        if (await existsFile(globalCacheFp) && await existsFile(globalMetaFp)) {
          await ensureDir(dirname(cacheFp))
          await Promise.all([
            Deno.copyFile(globalCacheFp, cacheFp),
            Deno.copyFile(globalMetaFp, metaFp)
          ])
          if (await existsFile(`${globalCacheFp}.map`)) {
            await Deno.copyFile(`${globalCacheFp}.map`, `${cacheFp}.map`)
          }
        }
      }
    }

    if (await existsFile(metaFp)) {
      try {
        const { specifier: _specifier, sourceHash, deps, isStyle, ssrPropsFn, ssgPathsFn, denoHooks } = JSON.parse(await Deno.readTextFile(metaFp))
        if (_specifier === specifier && util.isNEString(sourceHash) && util.isArray(deps)) {
          mod.sourceHash = sourceHash
          mod.deps = deps
          mod.isStyle = Boolean(isStyle) || undefined
          mod.ssrPropsFn = util.isNEString(ssrPropsFn) ? ssrPropsFn : undefined
          mod.ssgPathsFn = Boolean(ssgPathsFn) || undefined
          mod.denoHooks = util.isNEArray(denoHooks) ? denoHooks : undefined
        } else {
          log.warn(`removing invalid metadata '${name}.meta.json'`)
          Deno.remove(metaFp)
        }
      } catch (e) { }
    }

    const shouldLoad = !(
      (isRemote && !this.#reloading && mod.sourceHash !== '') &&
      await existsFile(cacheFp)
    )
    if (shouldLoad) {
      try {
        const src = customSource || await this.loadModuleSource(specifier, data)
        const sourceHash = computeHash(src.code)
        if (mod.sourceHash === '' || mod.sourceHash !== sourceHash) {
          mod.sourceHash = sourceHash
          source = src
        }
        mod.isStyle = src.isStyle
      } catch (err) {
        log.error(`load module '${specifier}':`, err.message)
        defer(err)
        return [mod, null]
      }
    }

    defer()
    return [mod, source]
  }

  private async transpileModule(
    module: Module,
    source: ModuleSource | null,
    ignoreDeps = false,
    __tracing: Set<string> = new Set()
  ): Promise<void> {
    const { specifier, jsFile, externalRemoteDeps } = module

    // ensure the module only be transppiled once in current compilation context,
    // to avoid dead-loop caused by cicular imports
    if (__tracing.has(specifier)) {
      return
    }
    __tracing.add(specifier)

    if (source) {
      if (source.type === SourceType.Unknown) {
        log.error(`Unsupported module '${specifier}'`)
        return
      }

      const ms = new Measure()
      const encoder = new TextEncoder()
      const { code, deps, ssrPropsFn, ssgPathsFn, denoHooks, starExports, map } = await transform(specifier, source.code, {
        ...this.commonCompileOptions,
        sourceMap: this.isDev,
        swcOptions: {
          sourceType: source.type
        },
        externalRemoteDeps
      })

      let jsCode = code

      // in production(bundle) mode we need to replace the star export with names
      if (!this.isDev && starExports && starExports.length > 0) {
        for (let index = 0; index < starExports.length; index++) {
          const exportSpecifier = starExports[index]
          const names = await this.parseModuleExportNames(exportSpecifier)
          jsCode = jsCode.replace(
            `export * from "[${exportSpecifier}]:`,
            `export {${names.filter(name => name !== 'default').join(',')}} from "`
          )
        }
      }

      // revert external imports
      if (deps && this.loaders.length > 0) {
        deps.forEach(({ specifier }) => {
          if (specifier !== module.specifier && util.isLikelyHttpURL(specifier)) {
            let external = false
            for (const l of this.loaders) {
              if (util.isFunction(l.resolve) && l.test.test(specifier)) {
                const ret = l.resolve(specifier)
                external = Boolean(ret.external)
                specifier = ret.specifier
                break
              }
            }
            if (external) {
              const importSpecifier = toRelativePath(
                dirname(toLocalPath(module.specifier)),
                toLocalPath(specifier)
              )
              jsCode.replaceAll(`"${importSpecifier}"`, `"${specifier}"`)
            }
          }
        })
      }

      // add source mapping url
      if (map) {
        jsCode += `\n//# sourceMappingURL=${basename(jsFile)}.map`
      }

      module.jsBuffer = encoder.encode(jsCode)
      module.deps = deps?.filter(({ specifier }) => specifier !== module.specifier).map(({ specifier, resolved, isDynamic }) => {
        const dep: DependencyDescriptor = { specifier }
        if (isDynamic) {
          dep.isDynamic = true
        }
        if (specifier.startsWith('/')) {
          const mark = encoder.encode(resolved)
          const idx = indexOf(module.jsBuffer!, mark)
          if (idx > 0) {
            dep.hashLoc = idx + mark.length - 6
          }
        }
        return dep
      }) || []

      module.ssrPropsFn = ssrPropsFn
      module.ssgPathsFn = ssgPathsFn
      if (util.isNEArray(denoHooks)) {
        module.denoHooks = denoHooks.map(id => util.trimPrefix(id, 'useDeno-'))
        if (!this.config.ssr) {
          log.error(`'useDeno' hook in SPA mode is illegal: ${specifier}`)
        }
      }

      ms.stop(`transpile '${specifier}'`)

      const cacheFp = join(this.buildDir, jsFile)
      const metaFp = cacheFp.slice(0, -3) + '.meta.json'
      const metaJSON = JSON.stringify({
        specifier,
        sourceHash: module.sourceHash,
        isStyle: module.isStyle,
        ssrPropsFn: module.ssrPropsFn,
        ssgPathsFn: module.ssgPathsFn,
        denoHooks: module.denoHooks,
        deps: module.deps,
      }, undefined, 2)
      await ensureDir(dirname(cacheFp))
      await Promise.all([
        Deno.writeFile(cacheFp, module.jsBuffer),
        Deno.writeTextFile(metaFp, metaJSON),
        map ? Deno.writeTextFile(`${cacheFp}.map`, map) : Promise.resolve(),
      ])
      // cache remote module compilation forever
      if (util.isLikelyHttpURL(specifier) && !isLocalUrl(specifier)) {
        const globalCacheFp = join(await getDenoDir(), `gen/aleph-${wasmChecksum}`, jsFile)
        const globalMetaFp = `${globalCacheFp.slice(0, -3)}.meta.json`
        await ensureDir(dirname(globalCacheFp))
        await Promise.all([
          Deno.writeFile(globalCacheFp, module.jsBuffer),
          Deno.writeTextFile(globalMetaFp, metaJSON),
          map ? Deno.writeTextFile(`${globalCacheFp}.map`, map) : Promise.resolve(),
        ])
      }
    }

    if (ignoreDeps) {
      return
    }

    if (module.deps.length > 0) {
      let fsync = false
      const encoder = new TextEncoder()
      const hasher = createHash('md5').update(module.sourceHash)
      // preload js buffer
      if (module.deps.findIndex(dep => dep.hashLoc !== undefined) >= 0) {
        await this.getModuleJS(module)
      }
      await Promise.all(module.deps.map(async ({ specifier, hashLoc }) => {
        const [depModule, depSource] = await this.initModule(specifier, { externalRemoteDeps })
        if (!depModule.external) {
          await this.transpileModule(depModule, depSource, false, __tracing)
        }
        const hash = depModule.hash || depModule.sourceHash
        if (hashLoc !== undefined) {
          const { jsBuffer } = module
          const hashData = encoder.encode((hash).substr(0, 6))
          if (jsBuffer && !equals(hashData, jsBuffer.slice(hashLoc, hashLoc + 6))) {
            copy(hashData, jsBuffer, hashLoc)
            if (!fsync) {
              fsync = true
            }
          }
        }
        hasher.update(hash)
      }))
      module.hash = hasher.toString()
      if (fsync) {
        await this.cacheModule(module)
      }
    } else {
      module.hash = module.sourceHash
    }
  }

  /** apply compilation side-effect caused by dependency graph updating. */
  private async applyCompilationSideEffect(by: Module, callback: (mod: Module) => void) {
    const hash = by.hash || by.sourceHash
    const hashData = (new TextEncoder()).encode(hash.substr(0, 6))
    this.applyModuleSideEffect(by.specifier)
    for (const mod of this.#modules.values()) {
      const { deps } = mod
      if (deps.length > 0) {
        let fsync = false
        for (const dep of deps) {
          const { specifier, hashLoc } = dep
          if (specifier === by.specifier && hashLoc !== undefined) {
            const jsCode = await this.getModuleJS(mod)
            if (jsCode && !equals(hashData, jsCode.slice(hashLoc, hashLoc + 6))) {
              copy(hashData, jsCode, hashLoc)
              if (!fsync) {
                fsync = true
              }
            }
          }
        }
        if (fsync) {
          const hasher = createHash('md5').update(mod.sourceHash)
          deps.forEach(({ specifier }) => {
            const depMod = specifier === by.specifier ? by : this.#modules.get(specifier)
            if (depMod) {
              hasher.update(depMod.hash || depMod.sourceHash)
            }
          })
          mod.hash = hasher.toString()
          await this.cacheModule(mod)
          this.applyModuleSideEffect(mod.specifier)
          callback(mod)
          await this.applyCompilationSideEffect(mod, callback)
        }
      }
    }
  }

  private applyModuleSideEffect(specifier: string) {
    if (trimBuiltinModuleExts(specifier) === '/app') {
      this.#renderer.clearCache()
    } else if (specifier.startsWith('/pages/')) {
      const [routePath] = this.createRouteUpdate(specifier)
      this.#renderer.clearCache(routePath)
      this.#pageRouting.update(...this.createRouteUpdate(specifier))
    } else if (specifier.startsWith('/api/')) {
      this.#apiRouting.update(...this.createRouteUpdate(specifier))
    }
  }

  private async cacheModule(module: Module) {
    const { specifier, jsBuffer, jsFile } = module
    if (jsBuffer) {
      const cacheFp = join(this.buildDir, jsFile)
      const metaFp = cacheFp.slice(0, -3) + '.meta.json'
      await ensureDir(dirname(cacheFp))
      await Promise.all([
        Deno.writeFile(cacheFp, jsBuffer),
        Deno.writeTextFile(metaFp, JSON.stringify({
          specifier,
          sourceHash: module.sourceHash,
          isStyle: module.isStyle,
          ssrPropsFn: module.ssrPropsFn,
          ssgPathsFn: module.ssgPathsFn,
          denoHooks: module.denoHooks,
          deps: module.deps,
        }, undefined, 2)),
        lazyRemove(cacheFp.slice(0, -3) + '.client.js'),
      ])
    }
  }

  /** create bundled chunks for production. */
  private async bundle() {
    const entries = this.analyze()
    await this.#bundler.bundle(entries)
  }

  /** render all pages in routing. */
  private async ssg() {
    const { ssr } = this.config
    const outputDir = join(this.workingDir, this.config.outputDir)

    if (ssr === false) {
      const html = await this.#renderer.renderSPAIndexPage()
      await ensureTextFile(join(outputDir, 'index.html'), html)
      await ensureTextFile(join(outputDir, '404.html'), html)
      return
    }

    log.info(bold('- Pages (SSG)'))

    // render pages
    const paths = new Set(this.#pageRouting.paths)
    // todo: check getStaticPaths
    await Promise.all(Array.from(paths).map(async pathname => {
      if (this.isSSRable(pathname)) {
        const [router, nestedModules] = this.#pageRouting.createRouter({ pathname })
        if (router.routePath !== '') {
          let [html, data] = await this.#renderer.renderPage(router, nestedModules)
          this.getCodeInjects('ssr', pathname)?.forEach(transform => {
            const ret = transform(pathname, html)
            html = ret.code
          })
          await ensureTextFile(join(outputDir, pathname, 'index.html'), html)
          if (data) {
            const dataFile = join(
              outputDir,
              `_aleph/data/${util.btoaUrl(pathname)}.json`
            )
            await ensureTextFile(dataFile, JSON.stringify(data))
          }
          log.info('  ○', pathname, dim('• ' + util.formatBytes(html.length)))
        } else {
          log.error('Page not found:', pathname)
        }
      }
    }))

    // render 404 page
    {
      const [router, nestedModules] = this.#pageRouting.createRouter({ pathname: '/404' })
      if (nestedModules.length > 0) {
        await this.compile(nestedModules[0])
      }
      let [html] = await this.#renderer.renderPage(router, nestedModules.slice(0, 1))
      this.getCodeInjects('ssr', '/404').forEach(transform => {
        const ret = transform('/404', html)
        html = ret.code
      })
      await ensureTextFile(join(outputDir, '404.html'), html)
    }
  }

  /** check the page whether it supports SSR. */
  private isSSRable(pathname: string): boolean {
    const { ssr } = this.config
    if (util.isPlainObject(ssr)) {
      if (ssr.include) {
        for (let r of ssr.include) {
          if (!r.test(pathname)) {
            return false
          }
        }
      }
      if (ssr.exclude) {
        for (let r of ssr.exclude) {
          if (r.test(pathname)) {
            return false
          }
        }
      }
      return true
    }
    return ssr
  }

  /** lookup app deps recurively. */
  lookupDeps(
    specifier: string,
    callback: (dep: DependencyDescriptor) => false | void,
    __tracing: Set<string> = new Set()
  ) {
    const mod = this.getModule(specifier)
    if (mod === null) {
      return
    }
    if (__tracing.has(specifier)) {
      return
    }
    __tracing.add(specifier)
    for (const dep of mod.deps) {
      if (callback(dep) === false) {
        return false
      }
    }
    for (const { specifier } of mod.deps) {
      if ((this.lookupDeps(specifier, callback, __tracing)) === false) {
        return false
      }
    }
  }
}
