import { getAlephPkgUri } from '../../server/helper.ts'
import type { ServerApplication } from '../../types.ts'

export async function init(app: ServerApplication) {
  if (app.mode === 'development') {
    const alephPkgUri = getAlephPkgUri()
    const alephPkgPath = alephPkgUri.replace('https://', '').replace('http://localhost:', 'http_localhost_')
    await app.addModule(`${alephPkgUri}/framework/react/refresh.ts`)
    app.injectCode('compilation', '/main.js', (_: string, code: string) => ({
      code: [
        `import { RefreshRuntime, performReactRefresh } from "./-/${alephPkgPath}/framework/react/refresh.js";`,
        `Object.assign(window, { RefreshRuntime, performReactRefresh });`,
        code
      ].join('\n')
    }))
    app.injectCode('hmr', (specifier: string, code: string) => ({
      code: code.includes('$RefreshReg$(') ? [
        'const prevRefreshReg = window.$RefreshReg$;',
        'const prevRefreshSig = window.$RefreshSig$;',
        `window.$RefreshReg$ = (type, id) => window.RefreshRuntime.register(type, ${JSON.stringify(specifier)} + "#" + id);`,
        'window.$RefreshSig$ = RefreshRuntime.createSignatureFunctionForTransform;',
        '',
        code,
        'window.$RefreshReg$ = prevRefreshReg;',
        'window.$RefreshSig$ = prevRefreshSig;',
        'import.meta.hot.accept(window.performReactRefresh);'
      ].join('\n') : code
    }))
    // support ssr
    Object.assign(globalThis, {
      $RefreshReg$: () => { },
      $RefreshSig$: () => (type: any) => type,
    })
  }
}
