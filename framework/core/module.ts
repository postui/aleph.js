import util from '../../shared/util.ts'

export const builtinModuleExts = ['tsx', 'jsx', 'ts', 'js', 'mjs']

export function importModule(basePath: string, url: string, forceRefetch = false): Promise<any> {
  const { __ALEPH: ALEPH } = window as any

  if (ALEPH) {
    return ALEPH.import(url, forceRefetch)
  }

  let src = util.cleanPath(basePath + '/_aleph/' + trimBuiltinModuleExts(url) + '.js')
  if (forceRefetch) {
    src += '?t=' + Date.now()
  }
  return import(src)
}

export function toPagePath(url: string): string {
  let pathname = trimBuiltinModuleExts(url)
  if (pathname.startsWith('/pages/')) {
    pathname = util.trimPrefix(pathname, '/pages')
  }
  if (pathname.endsWith('/index')) {
    pathname = util.trimSuffix(pathname, '/index')
  }
  if (pathname === '') {
    pathname = '/'
  }
  return pathname
}

export function trimBuiltinModuleExts(url: string) {
  for (const ext of builtinModuleExts) {
    if (url.endsWith('.' + ext)) {
      return url.slice(0, -(ext.length + 1))
    }
  }
  return url
}
