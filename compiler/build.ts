import { dim } from 'https://deno.land/std@0.99.0/fmt/colors.ts'
import { encode } from 'https://deno.land/std@0.99.0/encoding/base64.ts'
import { exists } from 'https://deno.land/std@0.99.0/fs/exists.ts'
import { ensureDir } from 'https://deno.land/std@0.99.0/fs/ensure_dir.ts'
import { createHash } from 'https://deno.land/std@0.99.0/hash/mod.ts'
import { compress } from 'https://deno.land/x/brotli@v0.1.4/mod.ts'
import util from '../shared/util.ts'

async function run(cmd: string[]) {
  const p = Deno.run({
    cmd,
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const status = await p.status()
  p.close()
  return status.success
}

if (import.meta.main) {
  const ok = await run(['wasm-pack', 'build', '--target', 'web'])
  if (ok) {
    const wasmData = await Deno.readFile('./pkg/aleph_compiler_bg.wasm')
    const jsCode = await Deno.readTextFile('./pkg/aleph_compiler.js')
    const hash = createHash('sha1').update(wasmData).toString()
    let prevWasmJsSize = 0
    if (await exists('./dist/checksum.js')) {
      prevWasmJsSize = (await Deno.stat('./dist/wasm.js')).size
    }
    await ensureDir('./dist')
    await Deno.writeTextFile(
      './dist/wasm.js',
      [
        `import { decode } from "https://deno.land/std@0.99.0/encoding/base64.ts";`,
        `import { decompress } from "https://deno.land/x/brotli@v0.1.4/mod.ts";`,
        `const dataRaw = "${encode(compress(wasmData))}";`,
        `export default () => decompress(decode(dataRaw));`
      ].join('\n')
    )
    await Deno.writeTextFile(
      './dist/checksum.js',
      `export const checksum = ${JSON.stringify(hash)};`
    )
    await Deno.writeTextFile(
      './dist/compiler.js',
      `import { red } from 'https://deno.land/std@0.99.0/fmt/colors.ts';` + jsCode.replace('console.error(getStringFromWasm0(arg0, arg1));', `
        const msg = getStringFromWasm0(arg0, arg1);
        if (msg.includes('DiagnosticBuffer(["')) {
          const diagnostic = msg.split('DiagnosticBuffer(["')[1].split('"])')[0]
          console.error(red("ERROR"), "swc:", diagnostic)
        } else {
          console.error(red("ERROR"), msg)
        }
      `)
    )
    await run(['deno', 'fmt', '-q', './dist/compiler.js'])
    const wasmJsSize = (await Deno.stat('./dist/wasm.js')).size
    console.log(`${dim('[INFO]')}: wasm.js (${[prevWasmJsSize, wasmJsSize].filter(Boolean).map(n => util.formatBytes(n)).join(' -> ')})`)
  }
}
