import { delay } from 'std/async/delay.ts'
import { assertEquals } from 'std/testing/asserts.ts'
import util from './util.ts'

Deno.test(`util`, async () => {
  // test isLikelyHttpURL
  assertEquals(util.isLikelyHttpURL('https://deno.land'), true)
  assertEquals(util.isLikelyHttpURL('http://deno.land'), true)
  assertEquals(util.isLikelyHttpURL('//deno.land'), false)
  assertEquals(util.isLikelyHttpURL('file:///deno.land'), false)
  assertEquals(util.isLikelyHttpURL('www.deno.land'), false)

  // test trimPrefix
  assertEquals(util.trimPrefix('foobar', 'foo'), 'bar')
  assertEquals(util.trimPrefix('foobar', 'baz'), 'foobar')
  assertEquals(util.trimSuffix('foobar', 'bar'), 'foo')
  assertEquals(util.trimSuffix('foobar', 'baz'), 'foobar')

  // test splitBy
  assertEquals(util.splitBy('/app.tsx', '.'), ['/app', 'tsx'])
  assertEquals(util.splitBy('foo.bar.', '.'), ['foo', 'bar.'])
  assertEquals(util.splitBy('foobar.', '.'), ['foobar', ''])
  assertEquals(util.splitBy('.foobar.', '.'), ['', 'foobar.'])
  assertEquals(util.splitBy('foobar', '.'), ['foobar', ''])

  // test formatBytes
  assertEquals(util.formatBytes(1000), '1000B')
  assertEquals(util.formatBytes(1024), '1KB')
  assertEquals(util.formatBytes(2048), '2KB')
  assertEquals(util.formatBytes(3000), '2.9KB')
  assertEquals(util.formatBytes(1024 ** 2), '1MB')
  assertEquals(util.formatBytes(1024 ** 3), '1GB')
  assertEquals(util.formatBytes(1024 ** 4), '1TB')
  assertEquals(util.formatBytes(1024 ** 5), '1PB')

  // test cleanPath
  assertEquals(util.cleanPath('./'), '/')
  assertEquals(util.cleanPath('./a/./b/./c/.'), '/a/b/c')
  assertEquals(util.cleanPath('../'), '/')
  assertEquals(util.cleanPath('../a/b/c'), '/a/b/c')
  assertEquals(util.cleanPath('/a/../b/c'), '/b/c')
  assertEquals(util.cleanPath('/a/b/../c'), '/a/c')
  assertEquals(util.cleanPath('\\a\\b\\c'), '/a/b/c')
  assertEquals(util.cleanPath('\\a\\b\\.\\..\\c'), '/a/c')
  assertEquals(util.cleanPath('//a//b//c//'), '/a/b/c')

  // test debounce
  let n = 0
  const plus = util.debounce(() => n++, 50)
  plus()
  assertEquals(n, 0)
  await delay(75)
  assertEquals(n, 1)
  plus()
  plus()
  plus()
  assertEquals(n, 1)
  await delay(75)
  assertEquals(n, 2)

  // test debounceX
  n = 0
  util.debounceX('key', () => n++, 50)
  assertEquals(n, 0)
  await delay(75)
  assertEquals(n, 1)
  util.debounceX('key', () => n += 1, 50)
  util.debounceX('key', () => n += 2, 50)
  util.debounceX('key', () => n += 3, 50)
  assertEquals(n, 1)
  await delay(75)
  assertEquals(n, 4)
})
