import '../es2020/mod.ts'

if (!('fromEntries' in Object)) {
  Object.fromEntries = function fromEntries(iterable) {
    if (iterable && typeof iterable.next === 'function') {
      return Array.from(iterable).reduce((obj, [key, val]) => {
        obj[key] = val
        return obj
      }, {})
    }
    return {}
  }
}

/**
 * Available in:
 * Edge: never
 * Firefox: 61
 * Chrome: 66
 * Safari: 12
 *
 * https://caniuse.com/mdn-javascript_builtins_string_trimstart
 * https://caniuse.com/mdn-javascript_builtins_string_trimend
 */
// Copied from https://github.com/vercel/next.js/blob/canary/packages/next-polyfill-module/src/index.js
// Licensed MIT
if (!('trimStart' in String.prototype)) {
  String.prototype.trimStart = String.prototype.trimLeft
}
if (!('trimEnd' in String.prototype)) {
  String.prototype.trimEnd = String.prototype.trimRight
}

/**
 * Available in:
 * Edge: never
 * Firefox: 63
 * Chrome: 70
 * Safari: 12.1
 *
 * https://caniuse.com/mdn-javascript_builtins_symbol_description
 */
// Copied from https://github.com/vercel/next.js/blob/canary/packages/next-polyfill-module/src/index.js
// Licensed MIT
if (!('description' in Symbol.prototype)) {
  Object.defineProperty(Symbol.prototype, 'description', {
    configurable: true,
    get: function get() {
      var m = /\((.*)\)/.exec(this.toString())
      return m ? m[1] : undefined
    },
  })
}

/**
 * Available in:
 * Edge: never
 * Firefox: 62
 * Chrome: 69
 * Safari: 12
 *
 * https://caniuse.com/array-flat
 */
// Copied from https://gist.github.com/developit/50364079cf0390a73e745e513fa912d9
// Licensed Apache-2.0
if (!('flat' in Array.prototype)) {
  Array.prototype.flat = function flat(d, c) {
    return (
      (c = this.concat.apply([], this)),
      d > 1 && c.some(Array.isArray) ? c.flat(d - 1) : c
    )
  }
  Array.prototype.flatMap = function flatMap(c, a) {
    return this.map(c, a).flat()
  }
}
