import { dirname, join } from 'https://deno.land/std@0.99.0/path/mod.ts'
import { ensureDir } from 'https://deno.land/std@0.99.0/fs/ensure_dir.ts'
import { transform } from '../compiler/mod.ts'
import { trimBuiltinModuleExts } from '../framework/core/module.ts'
import { ensureTextFile, existsFile, lazyRemove } from '../shared/fs.ts'
import type { BrowserNames } from '../types.ts'
import { VERSION } from '../version.ts'
import type { DependencyGraph } from '../server/analyzer.ts'
import type { Application, Module } from '../server/app.ts'
import { clearBuildCache, computeHash, getAlephPkgUri } from '../server/helper.ts'
import { esbuild, stopEsbuild, esbuildUrlLoader } from './esbuild.ts'

export const bundlerRuntimeCode = `
  window.__ALEPH = {
    basePath: '/',
    pack: {},
    asyncChunks: {},
    import: function(s, r) {
      var a = this.pack,
          b = this.basePath,
          d = document,
          l = this.asyncChunks;
      if (s in a) {
        return Promise.resolve(a[s]);
      }
      return new Promise(function(y, n) {
        var e = d.createElement('script'),
            f = l[s] || l[s.replace(/\\.[a-zA-Z0-9]+$/, '')],
            p = b.replace(/\\/+$/, '') + '/_aleph';
        if (!f) {
          n(new Error('invalid specifier: ' + s));
          return;
        }
        e.onload = function() {
          y(a[s]);
        };
        e.onerror = n;
        p += f;
        if (r) {
          p += '?t=' + (new Date).getTime();
        }
        e.src = p;
        d.body.appendChild(e);
      })
    }
  }
`

/** The bundler class for aleph server. */
export class Bundler {
  #app: Application
  #chunks: Map<string, { filename: string, async?: boolean }>
  #compiled: Map<string, string>

  constructor(app: Application) {
    this.#app = app
    this.#chunks = new Map()
    this.#compiled = new Map()
  }

  async bundle(entries: DependencyGraph[]) {
    const vendorDeps = entries.find(({ specifier }) => specifier === 'virtual:/vendor.js')?.deps.map(({ specifier }) => specifier) || []
    const commonDeps = entries.find(({ specifier }) => specifier === 'virtual:/common.js')?.deps.map(({ specifier }) => specifier) || []

    if (this.#app.config.buildTarget !== 'esnext') {
      await this.bundlePolyfillsChunck()
    }
    await this.bundleChunk(
      'vendor',
      vendorDeps,
      []
    )
    if (commonDeps.length) {
      await this.bundleChunk(
        'common',
        commonDeps,
        vendorDeps,
      )
    }

    // create page/dynamic chunks
    for (const { specifier } of entries) {
      if (!specifier.startsWith('virtual:')) {
        await this.bundleChunk(
          trimBuiltinModuleExts(specifier),
          [specifier],
          [
            vendorDeps,
            commonDeps
          ].flat(),
          true
        )
      }
    }

    // create main.js after all chunks are bundled
    await this.createMainJS()

    // unlike nodejs, Deno doesn't provide the necessary APIs to allow Deno to
    // exit while esbuild's internal child process is still running.
    stopEsbuild()
  }

  getSyncChunks(): string[] {
    return Array.from(this.#chunks.values())
      .filter(chunk => !chunk.async)
      .map(chunk => chunk.filename)
  }

  async copyDist() {
    await Promise.all(
      Array.from(this.#chunks.values()).map(({ filename }) => this.copyBundleFile(filename))
    )
  }

  private async copyBundleFile(jsFilename: string) {
    const { workingDir, buildDir, config } = this.#app
    const outputDir = join(workingDir, config.outputDir)
    const bundleFile = join(buildDir, jsFilename)
    const saveAs = join(outputDir, '_aleph', jsFilename)
    await ensureDir(dirname(saveAs))
    await Deno.copyFile(bundleFile, saveAs)
  }

  private async compile(mod: Module, externals: string[]): Promise<string> {
    if (this.#compiled.has(mod.specifier)) {
      return this.#compiled.get(mod.specifier)!
    }

    const jsFile = join(this.#app.buildDir, mod.jsFile.slice(0, -3) + '.client.js')
    this.#compiled.set(mod.specifier, jsFile)

    if (await existsFile(jsFile)) {
      return jsFile
    }

    const source = await this.#app.loadModuleSource(mod.specifier)
    if (source === null) {
      this.#compiled.delete(mod.specifier)
      throw new Error(`Unsupported module '${mod.specifier}'`)
    }

    try {
      let { code, starExports } = await transform(
        mod.specifier,
        source.code,
        {
          ...this.#app.commonCompileOptions,
          swcOptions: {
            sourceType: source.type,
          },
          bundleMode: true,
          bundleExternals: externals,
        }
      )

      if (starExports && starExports.length > 0) {
        for (let index = 0; index < starExports.length; index++) {
          const specifier = starExports[index]
          const names = await this.#app.parseModuleExportNames(specifier)
          code = code.replaceAll(`export * from "[${specifier}]:`, `export {${names.filter(name => name !== 'default').join(',')}} from "`)
          code = code.replaceAll(`export const $$star_${index}`, `export const {${names.filter(name => name !== 'default').join(',')}}`)
        }
      }

      // compile deps
      await Promise.all(mod.deps.map(async dep => {
        if (!dep.specifier.startsWith('#') && !externals.includes(dep.specifier)) {
          const depMod = this.#app.getModule(dep.specifier)
          if (depMod !== null) {
            await this.compile(depMod, externals)
          }
        }
      }))

      await ensureTextFile(jsFile, code)
      return jsFile
    } catch (e) {
      this.#compiled.delete(mod.specifier)
      throw new Error(`Can't compile module '${mod.specifier}': ${e.message}`)
    }
  }

  private async createMainJS() {
    const asyncChunks = Array.from(this.#chunks.entries())
      .filter(([_, chunk]) => !!chunk.async)
      .reduce((r, [name, chunk]) => {
        r[name] = chunk.filename
        return r
      }, {} as Record<string, string>)
    const mainJS = `__ALEPH.asyncChunks=${JSON.stringify(asyncChunks)};` + this.#app.createMainJS(true)
    const hash = computeHash(mainJS)
    const bundleFilename = `main.bundle.${hash.slice(0, 8)}.js`
    const bundleFilePath = join(this.#app.buildDir, bundleFilename)
    await Deno.writeTextFile(bundleFilePath, mainJS)
    this.#chunks.set('main', { filename: bundleFilename })
  }

  /** create polyfills bundle. */
  private async bundlePolyfillsChunck() {
    const alephPkgUri = getAlephPkgUri()
    const { buildTarget } = this.#app.config
    const polyfillTarget = 'es' + (parseInt(buildTarget.slice(2)) + 1) // buildTarget + 1
    const hash = computeHash(polyfillTarget + '/esbuild@v0.11.11/' + VERSION)
    const bundleFilename = `polyfills.bundle.${hash.slice(0, 8)}.js`
    const bundleFilePath = join(this.#app.buildDir, bundleFilename)
    if (!await existsFile(bundleFilePath)) {
      const rawPolyfillsFile = `${alephPkgUri}/bundler/polyfills/${polyfillTarget}/mod.ts`
      await this.build(rawPolyfillsFile, bundleFilePath)
    }
    this.#chunks.set('polyfills', { filename: bundleFilename })
  }

  /** create bundle chunk. */
  private async bundleChunk(name: string, entry: string[], external: string[], asyncChunk: boolean = false) {
    const entryCode = (await Promise.all(entry.map(async (specifier, i) => {
      const { buildDir } = this.#app
      let mod = this.#app.getModule(specifier)
      if (mod && mod.jsFile !== '') {
        if (external.length === 0) {
          return [
            `import * as mod_${i} from ${JSON.stringify('file://' + join(buildDir, mod.jsFile))}`,
            `__ALEPH.pack[${JSON.stringify(specifier)}] = mod_${i}`
          ]
        } else {
          const jsFile = await this.compile(mod, external)
          return [
            `import * as mod_${i} from ${JSON.stringify('file://' + jsFile)}`,
            `__ALEPH.pack[${JSON.stringify(specifier)}] = mod_${i}`
          ]
        }
      }
      return []
    }))).flat().join('\n')
    const hash = computeHash(entryCode + VERSION + Deno.version.deno)
    const bundleFilename = `${name}.bundle.${hash.slice(0, 8)}.js`
    const bundleEntryFile = join(this.#app.buildDir, `${name}.bundle.entry.js`)
    const bundleFilePath = join(this.#app.buildDir, bundleFilename)
    if (!await existsFile(bundleFilePath)) {
      await Deno.writeTextFile(bundleEntryFile, entryCode)
      await this.build(bundleEntryFile, bundleFilePath)
      lazyRemove(bundleEntryFile)
    }
    this.#chunks.set(name, { filename: bundleFilename, async: asyncChunk })
  }

  /** run deno bundle and compress the output using terser. */
  private async build(entryFile: string, bundleFile: string) {
    const { buildTarget, browserslist } = this.#app.config

    await clearBuildCache(bundleFile)
    await esbuild({
      entryPoints: [entryFile],
      outfile: bundleFile,
      platform: 'browser',
      format: 'iife',
      target: [String(buildTarget)].concat(Object.keys(browserslist).map(name => {
        return `${name}${browserslist[name as BrowserNames]}`
      })),
      bundle: true,
      minify: true,
      treeShaking: true,
      sourcemap: false,
      plugins: [esbuildUrlLoader],
    })
  }
}

export function simpleJSMinify(code: string) {
  return code.split('\n').map(l => l.trim()
    .replace(/\s*([,:=|+]{1,2})\s+/g, '$1')
    .replaceAll(') {', '){')
  ).join('')
}
