import { createElement } from 'https://esm.sh/react@17.0.2'
import { hydrate, render } from 'https://esm.sh/react-dom@17.0.2'
import { importModule } from '../core/module.ts'
import { Routing, RoutingOptions } from '../core/routing.ts'
import Router from './components/Router.ts'
import { loadSSRDataFromTag } from './pagedata.ts'
import { createPageProps, PageRoute } from './pageprops.ts'

type BootstrapOptions = Required<RoutingOptions> & {
  appModule?: string,
  renderMode: 'ssr' | 'spa'
}

export default async function bootstrap(options: BootstrapOptions) {
  const { basePath, defaultLocale, locales, appModule: appModuleSpcifier, routes, rewrites, renderMode } = options
  const { document } = window as any
  const appModule = appModuleSpcifier ? await importModule(basePath, appModuleSpcifier) : {}
  const routing = new Routing({ routes, rewrites, basePath, defaultLocale, locales })
  const [url, nestedModules] = routing.createRouter()
  const imports = nestedModules.map(async specifier => {
    const { default: Component } = await importModule(basePath, specifier)
    return { specifier, Component }
  })
  const pageRoute: PageRoute = { ...createPageProps(await Promise.all(imports)), url }
  const routerEl = createElement(Router, { appModule, pageRoute, routing })
  const mountPoint = document.getElementById('__aleph')

  if (renderMode === 'ssr') {
    loadSSRDataFromTag(url)
    hydrate(routerEl, mountPoint)
  } else {
    render(routerEl, mountPoint)
  }

  // remove ssr head elements, set a timmer to avoid the tab title flash
  setTimeout(() => {
    Array.from(document.head.children).forEach((el: any) => {
      const tag = el.tagName.toLowerCase()
      if (
        el.hasAttribute('ssr') &&
        tag !== 'style' &&
        !(tag === 'link' && el.getAttribute('rel') === 'stylesheet')
      ) {
        document.head.removeChild(el)
      }
    })
  }, 0)
}
