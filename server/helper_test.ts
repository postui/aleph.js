import { assert, assertEquals } from 'std/testing/asserts.ts'
import util from '../shared/util.ts'
import type { LoaderPlugin, ServerPlugin } from '../types.ts'
import { VERSION } from '../version.ts'
import {
  computeHash,
  formatBytesWithColor,
  getAlephPkgUri,
  toRelativePath,
  isLoaderPlugin,
  toLocalPath
} from './helper.ts'

Deno.test('server/helper: isLoaderPlugin', () => {
  const loader: LoaderPlugin = { name: 'test', type: 'loader', test: /test/ }
  const plugin: ServerPlugin = { name: 'test', type: 'server', setup: () => { } }
  assert(isLoaderPlugin(loader))
  assert(!isLoaderPlugin(plugin))
})

Deno.test('server/helper: getAlephPkgUri dev', () => {
  const port = 3000
  Deno.env.set('ALEPH_DEV_PORT', port.toString())

  assert(getAlephPkgUri().endsWith(port.toString()))
})

Deno.test('server/helper: getAlephPkgUri non-dev', () => {
  Deno.env.delete('ALEPH_DEV_PORT')

  assert(getAlephPkgUri().endsWith(VERSION))
})

Deno.test('server/helper: toRelativePath', () => {
  assertEquals(toRelativePath('/baz/foobar', '/baz/aleph'), '../aleph')
  assertEquals(toRelativePath('baz/foobar', 'baz/aleph'), '../aleph')
  assertEquals(toRelativePath('baz/foobar', 'baz/foobar/aleph'), './aleph')
})

Deno.test('server/helper: toLocalPath', () => {
  assertEquals(toLocalPath('https://deno.land/x/aleph@v0.3.0-alpha.29/'), '/-/deno.land/x/aleph@v0.3.0-alpha.29/')
  assertEquals(toLocalPath('http://foo.com/bar?lang=us-en'), `/-/http_foo.com/bar.${util.btoaUrl('lang=us-en')}`)
  assertEquals(toLocalPath('http://foo.com:8080/bar'), '/-/http_foo.com_8080/bar')
  assertEquals(toLocalPath('file://foo/bar/'), 'foo/bar/')
  assertEquals(toLocalPath('/foo/bar/'), '/foo/bar/')
})

Deno.test('server/helper: computeHash', () => {
  assertEquals(computeHash('hello world!'), '430ce34d020724ed75a196dfc2ad67c77772d169')
  assertEquals(computeHash(new Uint8Array([21, 31])), 'b0d04c3ac51b86296251d73c20f348e9ae0042a4')
})

Deno.test('server/helper: formatBytesWithColor', () => {
  const OneLeftShift20 = 1048576   // 1 << 20 = 1048576 (1MB)
  const TenLeftShift20 = 10485760  // 10 << 20 = 10485760 (10MB)
  const OneMb = OneLeftShift20
  const OneHalfMb = OneLeftShift20 + 512 * 1024
  const ElevenMb = TenLeftShift20 + 1024

  assertEquals(formatBytesWithColor(OneMb), "\x1b[2m1MB\x1b[22m")
  assertEquals(formatBytesWithColor(OneHalfMb), "\x1b[33m1.5MB\x1b[39m")
  assertEquals(formatBytesWithColor(ElevenMb), "\x1b[31m11MB\x1b[39m")
})
