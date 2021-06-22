import util from '../shared/util.ts'
import type { Application, Module } from './app.ts'
import { getAlephPkgUri } from './helper.ts'

export type DependencyGraph = {
  specifier: string
  external?: boolean
  isPreload?: boolean
  isDynamic?: boolean
  isLoop?: boolean
  isShared?: boolean
  size?: number
  sourceSize?: number
  deps: DependencyGraph[]
}

export class Analyzer {
  #app: Application
  #entries: DependencyGraph[]

  constructor(app: Application) {
    this.#app = app
    this.#entries = [
      Analyzer.blankDependencyGraph('virtual:/vendor.js', true),
      Analyzer.blankDependencyGraph('virtual:/common.js', true),
    ]
  }

  get entries() {
    return [...this.#entries]
  }

  reset() {
    const { framework } = this.#app.config
    const bootstrapModuleUrl = `${getAlephPkgUri()}/framework/${framework}/bootstrap.ts`

    this.#entries = [
      Analyzer.blankDependencyGraph('virtual:/vendor.js', true),
      Analyzer.blankDependencyGraph('virtual:/common.js', true),
    ]

    // main.js
    this.#entries.push(this.createDependencyGraph({
      specifier: 'virtual:/main.js',
      deps: [
        { specifier: bootstrapModuleUrl }
      ],
    }, true))

    // app.js
    const appMoudle = this.#app.getModule('app')
    if (appMoudle) {
      this.#entries.push(this.createDependencyGraph(appMoudle, true))
    }
  }

  addEntry(module: Module) {
    if (this.#entries.findIndex(c => module.specifier === c.specifier) === -1) {
      let isShared = false
      for (const eg of this.#entries) {
        Analyzer.walkDependencyGraph(eg, graph => {
          const eq = graph.specifier === module.specifier
          if (eq && !graph.external && !graph.isDynamic && !graph.isLoop && !graph.isShared) {
            this.#entries.push({ ...graph, isPreload: true })
            graph.isShared = true
            graph.deps = []
            isShared = true
            return false // break walking
          }
        })
        if (isShared) {
          return
        }
      }
      this.#entries.push(this.createDependencyGraph(module, false))
    }
  }

  private createDependencyGraph(
    module: Pick<Module, 'specifier' | 'deps' | 'external'>,
    isPreload?: boolean,
    __tracing = new Set<string>()
  ): DependencyGraph {
    const { specifier, external } = module
    const deps: Module["deps"] = []
    const graph: DependencyGraph = {
      specifier,
      external,
      deps: []
    }

    if (__tracing.size == 0 && isPreload) {
      graph.isPreload = true
    }

    if (external) {
      return graph
    }

    if (__tracing.has(specifier)) {
      graph.isLoop = true
      return graph
    }
    __tracing.add(specifier)

    module.deps.forEach(dep => {
      if (
        this.#app.getModule(dep.specifier) !== null &&
        deps.findIndex(({ specifier, isDynamic }) => dep.specifier === specifier && dep.isDynamic === isDynamic) === -1
      ) {
        deps.push(dep)
      }
    })
    graph.deps = deps.filter(({ specifier }) => this.#app.getModule(specifier) !== null)
      .map(dep => {
        const depMod = this.#app.getModule(dep.specifier)!
        const isRemote = util.isLikelyHttpURL(dep.specifier)
        const sharedGraph = this.#entries[isRemote ? 0 : 1]

        // external dependency
        if (depMod.external) {
          return {
            ...Analyzer.blankDependencyGraph(dep.specifier),
            external: true,
            isDynamic: dep.isDynamic,
          }
        }

        // check the dep whether it is global shared
        let isShared = false
        if (!isRemote) {
          for (const sg of this.entries) {
            if (sg.isPreload && sg.specifier === dep.specifier) {
              isShared = true
              break
            }
          }
        }
        if (!isShared) {
          for (const graph of sharedGraph.deps) {
            isShared = graph.specifier === dep.specifier
            if (isShared) {
              break
            }
          }
        }
        if (!isShared) {
          Analyzer.walkDependencyGraph(sharedGraph, graph => {
            const eq = graph.specifier === dep.specifier
            if (eq && !graph.external && !graph.isDynamic && !graph.isLoop && !graph.isShared) {
              sharedGraph.deps.push({ ...graph })
              graph.isShared = true
              graph.isLoop = true
              graph.deps = []
              isShared = true
              return false // break walking
            }
          })
        }
        if (!isShared && !dep.isDynamic) {
          if (isPreload) {
            const g = this.createDependencyGraph(depMod, isPreload, __tracing)
            sharedGraph.deps.push(g)
            isShared = true
          } else {
            for (const eg of this.#entries) {
              if (!eg.isPreload) {
                if (eg.specifier === dep.specifier) {
                  eg.isPreload = true
                  isShared = true
                } else {
                  Analyzer.walkDependencyGraph(eg, graph => {
                    const eq = graph.specifier === dep.specifier
                    if (eq && !graph.external && !graph.isDynamic && !graph.isLoop && !graph.isShared) {
                      sharedGraph.deps.push({ ...graph })
                      graph.isShared = true
                      graph.deps = []
                      isShared = true
                      return false // break walking
                    }
                  })
                }
                if (isShared) {
                  break
                }
              }
            }
          }
        }
        if (isShared) {
          return {
            ...Analyzer.blankDependencyGraph(dep.specifier),
            isShared,
            isDynamic: dep.isDynamic,
          }
        }

        // dynamic dep
        if (dep.isDynamic) {
          if (this.#entries.findIndex(c => dep.specifier === c.specifier) === -1) {
            this.#entries.push(this.createDependencyGraph(depMod))
          }
          return {
            ...Analyzer.blankDependencyGraph(dep.specifier),
            isDynamic: true,
          }
        }

        return this.createDependencyGraph(depMod, isPreload, __tracing)
      })

    return graph
  }

  static blankDependencyGraph(specifier: string, isPreload?: boolean): DependencyGraph {
    return {
      specifier,
      isPreload,
      deps: []
    }
  }

  static walkDependencyGraph(
    graph: DependencyGraph,
    callback: (graph: DependencyGraph) => void | false,
    __tracing: Set<string> = new Set()
  ): void | false {
    if (__tracing.has(graph.specifier)) {
      return
    }
    __tracing.add(graph.specifier)
    for (const dg of graph.deps) {
      if (callback(dg) === false) {
        return false
      }
      if ((Analyzer.walkDependencyGraph(dg, callback, __tracing)) === false) {
        return false
      }
    }
  }
}
