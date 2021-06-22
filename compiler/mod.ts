import { join } from 'https://deno.land/std@0.99.0/path/mod.ts'
import { ensureDir } from 'https://deno.land/std@0.99.0/fs/ensure_dir.ts'
import { existsFile } from '../shared/fs.ts'
import { Measure } from '../shared/log.ts'
import type { ImportMap } from '../types.ts'
import { getDenoDir } from '../server/helper.ts'
import { checksum } from './dist/checksum.js'
import init, { parseExportNamesSync, stripSsrCodeSync, transformSync } from './dist/compiler.js'

export enum SourceType {
  JS = 'js',
  JSX = 'jsx',
  TS = 'ts',
  TSX = 'tsx',
  CSS = 'css',
  Unknown = '??',
}

export type SWCOptions = {
  sourceType?: SourceType
  jsxFactory?: string
  jsxFragmentFactory?: string
}

export type ReactOptions = {
  version: string,
  esmShBuildVersion: number
}

export type TransformOptions = {
  swcOptions?: SWCOptions
  workingDir?: string
  alephPkgUri?: string
  importMap?: ImportMap
  react?: ReactOptions
  sourceMap?: boolean
  isDev?: boolean
  externalRemoteDeps?: boolean
  bundleMode?: boolean
  bundleExternals?: string[]
  inlineStylePreprocess?(key: string, type: string, tpl: string): Promise<string>
}

export type TransformResult = {
  code: string
  deps?: DependencyDescriptor[]
  ssrPropsFn?: string
  ssgPathsFn?: boolean
  denoHooks?: string[]
  starExports?: string[]
  map?: string
}

type DependencyDescriptor = {
  specifier: string
  resolved: string
  isDynamic: boolean
}

type InlineStyle = {
  type: string,
  quasis: string[],
  exprs: string[]
}

type InlineStyles = Record<string, InlineStyle>

let wasmReady: Promise<void> | boolean = false

async function initWasm() {
  const cacheDir = join(await getDenoDir(), `deps/https/deno.land/aleph`)
  const cachePath = `${cacheDir}/compiler.${checksum}.wasm`
  if (await existsFile(cachePath)) {
    const wasmData = await Deno.readFile(cachePath)
    await init(wasmData)
  } else {
    const { default: getWasmData } = await import('./dist/wasm.js')
    const wasmData = getWasmData()
    await init(wasmData)
    await ensureDir(cacheDir)
    await Deno.writeFile(cachePath, wasmData)
  }
}

async function checkWasmReady() {
  let ms: Measure | null = null
  if (wasmReady === false) {
    ms = new Measure()
    wasmReady = initWasm()
  }
  if (wasmReady instanceof Promise) {
    await wasmReady
    wasmReady = true
  }
  if (ms !== null) {
    ms.stop('init compiler wasm')
  }
}

/**
 * transform module by swc.
 *
 * ```tsx
 * transform(
 *   '/app.tsx',
 *   `
 *     export default App() {
 *       return <h1>Hello World</h1>
 *     }
 *   `
 * )
 * ```
 */
export async function transform(specifier: string, code: string, options: TransformOptions = {}): Promise<TransformResult> {
  await checkWasmReady()

  const { inlineStylePreprocess, ...transformOptions } = options
  let {
    code: jsContent,
    deps,
    inlineStyles,
    denoHooks,
    starExports,
    map,
  } = transformSync(specifier, code, transformOptions)

  // resolve inline-style
  if (inlineStyles) {
    await Promise.all(Object.entries(inlineStyles as InlineStyles).map(async ([key, style]) => {
      let tpl = style.quasis.reduce((tpl, quais, i, a) => {
        tpl += quais
        if (i < a.length - 1) {
          tpl += `%%aleph-inline-style-expr-${i}%%`
        }
        return tpl
      }, '')
        .replace(/\:\s*%%aleph-inline-style-expr-(\d+)%%/g, (_, id) => `: var(--aleph-inline-style-expr-${id})`)
        .replace(/%%aleph-inline-style-expr-(\d+)%%/g, (_, id) => `/*%%aleph-inline-style-expr-${id}%%*/`)
      if (inlineStylePreprocess !== undefined) {
        tpl = await inlineStylePreprocess('#' + key, style.type, tpl)
      }
      tpl = tpl.replace(
        /\: var\(--aleph-inline-style-expr-(\d+)\)/g,
        (_, id) => ': ${' + style.exprs[parseInt(id)] + '}'
      ).replace(
        /\/\*%%aleph-inline-style-expr-(\d+)%%\*\//g,
        (_, id) => '${' + style.exprs[parseInt(id)] + '}'
      )
      jsContent = jsContent.replace(`"%%${key}-placeholder%%"`, '`' + tpl + '`')
    }))
  }

  return {
    code: jsContent,
    deps,
    denoHooks,
    starExports,
    map
  }
}

/* strip SSR code. */
export async function stripSsrCode(specifier: string, code: string, options: TransformOptions = {}): Promise<TransformResult> {
  await checkWasmReady()
  return stripSsrCodeSync(specifier, code, options)
}

/* parse export names of the module. */
export async function parseExportNames(specifier: string, code: string, options: SWCOptions = {}): Promise<string[]> {
  await checkWasmReady()
  return parseExportNamesSync(specifier, code, options)
}

/**
 * The wasm checksum.
 */
export const wasmChecksum = checksum
