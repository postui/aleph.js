import { join } from 'std/path/mod.ts'
import { assert, assertEquals } from 'std/testing/asserts.ts'
import { Application } from '../server/app.ts'
import { ensureTextFile } from '../shared/fs.ts'
import markdownLoader from './markdown.ts'

Deno.test('plugin: markdown loader', async () => {
  Deno.env.set('DENO_TESTING', 'true')
  const dir = await Deno.makeTempDir({ prefix: 'aleph_plugin_testing' })
  const app = new Application(dir)
  const loader = markdownLoader()
  await ensureTextFile(
    join(dir, '/pages/docs/index.md'),
    [
      '---',
      'id: mark-page-1',
      'className: mark-page',
      'style:',
      '  color: "#333"',
      'url: https://alephjs.org',
      '---',
      '',
      '# Aleph.js',
      'The Full-stack Framework in Deno.'
    ].join('\n')
  )
  const { code } = await loader.load!({ specifier: '/pages/docs/index.md', }, app)
  assert(loader.type === 'loader')
  assert(loader.test.test('/test.md'))
  assert(loader.test.test('/test.markdown'))
  assert(loader.allowPage)
  assertEquals(loader.resolve!('/pages/docs/get-started.md').pagePath, '/docs/get-started')
  assert(!loader.resolve!('/pages/docs/get-started.md').isIndex)
  assertEquals(loader.resolve!('/pages/docs/index.md').pagePath, '/docs')
  assert(loader.resolve!('/pages/docs/index.md').isIndex)
  assert(code.includes('html: "<h1 id=\\"alephjs\\">Aleph.js</h1>\\n<p>The Full-stack Framework in Deno.</p>\\n"'))
  assert(code.includes('MarkdownPage.meta = {"id":"mark-page-1","className":"mark-page","style":{"color":"#333"},"url":"https://alephjs.org"}'))
})
