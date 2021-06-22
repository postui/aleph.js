import { ComponentType } from 'https://esm.sh/react@17.0.2'
import type { RouterURL } from '../../types.ts'
import { E400MissingComponent } from './components/ErrorBoundary.ts'
import { isLikelyReactComponent } from './helper.ts'

export type PageProps = {
  Page: ComponentType<any> | null
  pageProps: (Partial<PageProps> & { name?: string }) | null
}

export type PageRoute = PageProps & {
  url: RouterURL
}

export function createPageProps(nestedComponents: { specifier: string, Component?: ComponentType<any> }[]): PageProps {
  const pageProps: PageProps = {
    Page: null,
    pageProps: null
  }
  if (nestedComponents.length > 0) {
    Object.assign(pageProps, createPagePropsSegment(nestedComponents[0]))
  }
  if (nestedComponents.length > 1) {
    nestedComponents.slice(1).reduce((p, seg) => {
      const c = createPagePropsSegment(seg)
      p.pageProps = c
      return c
    }, pageProps)
  }
  return pageProps
}

function createPagePropsSegment(seg: { specifier: string, Component?: ComponentType<any> }): PageProps {
  const pageProps: PageProps = {
    Page: null,
    pageProps: null
  }
  if (seg.Component) {
    if (isLikelyReactComponent(seg.Component)) {
      pageProps.Page = seg.Component
    } else {
      pageProps.Page = E400MissingComponent
      pageProps.pageProps = { name: 'Page Component: ' + seg.specifier }
    }
  }
  return pageProps
}
