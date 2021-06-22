import type { LoaderPlugin } from '../../types.ts'

export default (): LoaderPlugin => ({
  type: 'loader',
  name: 'wasm-loader',
  test: /\.wasm$/i,
  load: async ({ url }, app) => {
    const { content } = await app.fetch(url)
    return {
      code: [
        `const wasmBytes = new Uint8Array([${content.join(',')}])`,
        'const wasmModule = new WebAssembly.Module(wasmBytes)',
        'const { exports } = new WebAssembly.Instance(wasmModule)',
        'export default exports',
      ].join('\n')
    }
  }
})
