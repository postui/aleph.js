import {
  ComponentType,
  createElement,
  useCallback,
  useEffect,
  useState,
} from 'https://esm.sh/react@17.0.2'
import events from '../../core/events.ts'
import { importModule, trimBuiltinModuleExts } from '../../core/module.ts'
import { Routing } from '../../core/routing.ts'
import { RouterContext } from '../context.ts'
import { isLikelyReactComponent } from '../helper.ts'
import { loadPageData } from '../pagedata.ts'
import { createPageProps } from '../pageprops.ts'
import type { PageRoute } from '../pageprops.ts'
import { E400MissingComponent, E404Page, ErrorBoundary } from './ErrorBoundary.ts'

export default function Router({
  appModule,
  pageRoute,
  routing,
}: {
  appModule: {
    default?: ComponentType
    Loading?: ComponentType
  }
  pageRoute: PageRoute
  routing: Routing
}) {
  const [app, setApp] = useState<{ Component: ComponentType<any> | null, props?: Record<string, any> }>(() => {
    const App = appModule.default
    if (App) {
      if (isLikelyReactComponent(App)) {
        return { Component: App }
      }
      return { Component: E400MissingComponent, props: { name: 'Custom App' } }
    }
    return { Component: null }
  })
  const [route, setRoute] = useState<PageRoute>(pageRoute)
  const onpopstate = useCallback(async (e: any) => {
    let [url, nestedModules] = routing.createRouter()
    if (url.routePath === '') {
      const r = routing.createRouter({ pathname: '/404' })
      nestedModules = r[1]
    }
    if (url.routePath !== '') {
      const { basePath } = routing
      const imports = nestedModules.map(async specifier => {
        const { default: Component } = await importModule(basePath, specifier, e.forceRefetch)
        return {
          specifier,
          Component
        }
      })
      const pageProps = createPageProps(await Promise.all(imports))
      await loadPageData(url)
      setRoute({ ...pageProps, url })
      if (e.resetScroll) {
        (window as any).scrollTo(0, 0)
      }
    } else {
      setRoute({ Page: null, pageProps: null, url })
    }
  }, [])

  useEffect(() => {
    window.addEventListener('popstate', onpopstate)
    events.on('popstate', onpopstate)
    events.emit('routerstate', { ready: true })

    return () => {
      window.removeEventListener('popstate', onpopstate)
      events.off('popstate', onpopstate)
    }
  }, [])

  useEffect(() => {
    const isDev = !('__ALEPH' in window)
    const { basePath } = routing
    const onAddModule = async (mod: { specifier: string, routePath?: string, isIndex?: boolean }) => {
      const name = trimBuiltinModuleExts(mod.specifier)
      if (name === '/app') {
        const { default: Component } = await importModule(basePath, mod.specifier, true)
        if (isLikelyReactComponent(Component)) {
          setApp({ Component })
        } else {
          setApp({ Component: E400MissingComponent, props: { name: 'Custom App' } })
        }
      } else {
        const { routePath, specifier, isIndex } = mod
        if (routePath) {
          routing.update(routePath, specifier, isIndex)
          events.emit('popstate', { type: 'popstate', forceRefetch: true })
        }
      }
    }
    const onRemoveModule = (specifier: string) => {
      const name = trimBuiltinModuleExts(specifier)
      if (name === '/app') {
        setApp({ Component: null })
      } else if (specifier.startsWith('/pages/')) {
        routing.removeRouteByModule(specifier)
        events.emit('popstate', { type: 'popstate' })
      }
    }
    const onFetchPageModule = async ({ href }: { href: string }) => {
      const [url, nestedModules] = routing.createRouter({ pathname: href })
      if (url.routePath !== '') {
        nestedModules.map(modUrl => {
          importModule(basePath, modUrl)
        })
      }
    }

    if (isDev) {
      events.on('add-module', onAddModule)
      events.on('remove-module', onRemoveModule)
      events.on('fetch-page-module', onFetchPageModule)
    }

    return () => {
      if (isDev) {
        events.off('add-module', onAddModule)
        events.off('remove-module', onRemoveModule)
        events.off('fetch-page-module', onFetchPageModule)
      }
    }
  }, [])

  useEffect(() => {
    const win = window as any
    const { location, document, scrollX, scrollY, scrollFixer } = win
    if (location.hash) {
      const anchor = document.getElementById(location.hash.slice(1))
      if (anchor) {
        const { left, top } = anchor.getBoundingClientRect()
        win.scroll({
          top: top + scrollY - (scrollFixer?.offset?.top || 0),
          left: left + scrollX - (scrollFixer?.offset?.left || 0),
          behavior: scrollFixer?.behavior
        })
      }
    }
  }, [route])

  return (
    createElement(
      ErrorBoundary,
      null,
      createElement(
        RouterContext.Provider,
        { value: route.url },
        ...[
          (route.Page && app.Component) && createElement(app.Component, Object.assign({}, app.props, { Page: route.Page, pageProps: route.pageProps })),
          (route.Page && !app.Component) && createElement(route.Page, route.pageProps),
          !route.Page && createElement(E404Page)
        ].filter(Boolean),
      )
    )
  )
}

Router.displayName = 'ALEPH' // show in devTools
