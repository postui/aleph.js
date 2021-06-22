import { delay } from 'std/async/delay.ts'
import { exists } from 'std/fs/exists.ts'
import { join } from 'std/path/mod.ts'
import { assert, assertEquals } from 'std/testing/asserts.ts'
import { stopEsbuild } from '../bundler/esbuild.ts'
import { Application } from '../server/app.ts'
import { computeHash } from '../server/helper.ts'
import { ensureTextFile } from '../shared/fs.ts'
import cssLoader from './css.ts'

Deno.test('plugin: css loader', async () => {
  Deno.env.set('DENO_TESTING', 'true')
  const dir = await Deno.makeTempDir({ prefix: 'aleph_plugin_testing' })
  const app = new Application(dir, 'development')
  await ensureTextFile(
    join(dir, '/style/index.css'),
    'h1 { font-size: 18px; }'
  )
  const loader = cssLoader()
  const { code } = await loader.load!({ specifier: '/style/index.css', }, app)
  assert(loader.type === 'loader')
  assert(loader.test.test('/style/index.css'))
  assert(loader.test.test('/style/index.pcss'))
  assert(loader.test.test('/style/index.postcss'))
  assert(!loader.test.test('/style/index.less'))
  assert(!loader.test.test('/style/index.sass'))
  assert(loader.acceptHMR)
  assertEquals(code, [
    'import { applyCSS } from "https://deno.land/x/aleph/framework/core/style.ts"',
    'export const css = "h1 { font-size: 18px; }"',
    'export default {}',
    'applyCSS("/style/index.css", { css })',
  ].join('\n'))
})

Deno.test({
  name: 'plugin: css loader in production mode',
  fn: async () => {
    Deno.env.set('DENO_TESTING', 'true')
    const dir = await Deno.makeTempDir({ prefix: 'aleph_plugin_testing' })
    const app = new Application(dir, 'production')
    await ensureTextFile(
      join(dir, '/style/index.css'),
      'h1 { font-size: 18px; }'
    )
    const loader = cssLoader()
    const { code } = await loader.load!({ specifier: '/style/index.css', }, app)
    assertEquals(code, [
      'import { applyCSS } from "https://deno.land/x/aleph/framework/core/style.ts"',
      'export const css = "h1{font-size:18px}"',
      'export default {}',
      'applyCSS("/style/index.css", { css })',
    ].join('\n'))

    stopEsbuild()
    await delay(150) // wait esbuild stop
  },
  sanitizeResources: false,
})

Deno.test('plugin: css loader with extract size option', async () => {
  Deno.env.set('DENO_TESTING', 'true')
  const dir = await Deno.makeTempDir({ prefix: 'aleph_plugin_testing' })
  const app = new Application(dir, 'development')
  app.config.css.extract = { limit: 10 }
  await ensureTextFile(
    join(dir, '/style/index.css'),
    'h1 { font-size: 18px; }'
  )
  const loader = cssLoader()
  const { code } = await loader.load!({ specifier: '/style/index.css', }, app)
  const distPath = `/style/index.${computeHash('h1 { font-size: 18px; }').slice(0, 8)}.css`
  assertEquals(code, [
    'import { applyCSS } from "https://deno.land/x/aleph/framework/core/style.ts"',
    `export const href = "/_aleph${distPath}"`,
    'export default {}',
    'applyCSS("/style/index.css", { href })',
  ].join('\n'))
  assert(await exists(join(app.buildDir, distPath)))
})

Deno.test('plugin: css loader for remote external', async () => {
  Deno.env.set('DENO_TESTING', 'true')
  const dir = await Deno.makeTempDir({ prefix: 'aleph_plugin_testing' })
  const app = new Application(dir, 'development')
  const loader = cssLoader()
  const { code } = await loader.load!({ specifier: 'https://esm.sh/tailwindcss/dist/tailwind.min.css', }, app)
  assertEquals(code, [
    'import { applyCSS } from "https://deno.land/x/aleph/framework/core/style.ts"',
    'export const href = "https://esm.sh/tailwindcss/dist/tailwind.min.css"',
    'export default {}',
    'applyCSS("https://esm.sh/tailwindcss/dist/tailwind.min.css", { href })',
  ].join('\n'))
})

Deno.test('plugin: css loader for inline styles', async () => {
  Deno.env.set('DENO_TESTING', 'true')
  const dir = await Deno.makeTempDir({ prefix: 'aleph_plugin_testing' })
  const app = new Application(dir, 'development')
  const loader = cssLoader()
  const { code, type } = await loader.load!({
    specifier: '#inline-style-{}',
    data: 'h1 { font-size: 18px; }'
  }, app)
  assertEquals(code, 'h1 { font-size: 18px; }')
  assertEquals(type, 'css')
})

Deno.test({
  name: 'plugin: css loader enables css modules feature',
  fn: async () => {
    Deno.env.set('DENO_TESTING', 'true')
    const dir = await Deno.makeTempDir({ prefix: 'aleph_plugin_testing' })
    const app = new Application(dir, 'development')
    app.config.css.modules = {
      scopeBehaviour: 'local',
      generateScopedName: '[name]_[local]'
    }
    await ensureTextFile(
      join(dir, '/style/index.css'),
      '.name { font-size: 18px; }'
    )
    const loader = cssLoader()
    const { code } = await loader.load!({ specifier: '/style/index.css', }, app)
    assertEquals(code, [
      'import { applyCSS } from "https://deno.land/x/aleph/framework/core/style.ts"',
      'export const css = ".index_name { font-size: 18px; }"',
      'export default {"name":"index_name"}',
      'applyCSS("/style/index.css", { css })',
    ].join('\n'))
  },
  sanitizeResources: false
})

Deno.test('plugin: css loader with postcss plugins', async () => {
  Deno.env.set('DENO_TESTING', 'true')
  const dir = await Deno.makeTempDir({ prefix: 'aleph_plugin_testing' })
  const app = new Application(dir, 'development')
  app.config.css.postcss = {
    plugins: ['postcss-nested']
  }
  await ensureTextFile(
    join(dir, '/style/index.css'),
    '.foo { .bar { font-size: 100%; } }'
  )
  const loader = cssLoader()
  const { code } = await loader.load!({ specifier: '/style/index.css' }, app)
  assertEquals(code, [
    'import { applyCSS } from "https://deno.land/x/aleph/framework/core/style.ts"',
    'export const css = ".foo .bar { font-size: 100%; }"',
    'export default {}',
    'applyCSS("/style/index.css", { css })',
  ].join('\n'))
})
