import events from './events.ts'

interface Callback {
  (...args: any[]): void
}

class Module {
  private _specifier: string
  private _isLocked: boolean = false
  private _isAccepted: boolean = false
  private _acceptCallbacks: Callback[] = []

  get specifier() {
    return this._specifier
  }

  constructor(specifier: string) {
    this._specifier = specifier
  }

  lock(): void {
    this._isLocked = true
  }

  accept(callback?: Callback): void {
    if (this._isLocked) {
      return
    }
    if (!this._isAccepted) {
      sendMessage({ specifier: this._specifier, type: 'hotAccept' })
      this._isAccepted = true
    }
    if (callback) {
      this._acceptCallbacks.push(callback)
    }
  }

  async applyUpdate(url: string) {
    try {
      const module = await import(url + '?t=' + Date.now())
      this._acceptCallbacks.forEach(cb => cb(module))
    } catch (e) {
      location.reload()
    }
  }
}

const modules: Map<string, Module> = new Map()
const state: {
  socket: WebSocket | null
  messageQueue: string[]
} = {
  socket: null,
  messageQueue: []
}

function sendMessage(msg: any) {
  const json = JSON.stringify(msg)
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    state.messageQueue.push(json)
  } else {
    state.socket.send(json)
  }
}

export function connect(basePath: string) {
  const { location } = window as any
  const { protocol, host } = location
  const wsUrl = (protocol === 'https:' ? 'wss' : 'ws') + '://' + host + basePath.replace(/\/+$/, '') + '/_hmr'
  const ws = new WebSocket(wsUrl)

  ws.addEventListener('open', () => {
    state.socket = ws
    state.messageQueue.splice(0, state.messageQueue.length).forEach(msg => ws.send(msg))
    console.log('[HMR] listening for file changes...')
  })

  ws.addEventListener('close', () => {
    if (state.socket === null) {
      // re-connect
      setTimeout(() => {
        connect(basePath)
      }, 300)
    } else {
      state.socket = null
      console.log('[HMR] closed.')
      // reload the page when re-connected
      setInterval(() => {
        const ws = new WebSocket(wsUrl)
        ws.addEventListener('open', () => {
          location.reload()
        })
      }, 300)
    }
  })

  ws.addEventListener('message', ({ data }: { data?: string }) => {
    if (data) {
      try {
        const {
          type,
          specifier,
          updateUrl,
          routePath,
          isIndex,
          refetchPage
        } = JSON.parse(data)
        if (refetchPage === true) {
          location.reload()
        }
        switch (type) {
          case 'add':
            events.emit('add-module', {
              specifier,
              routePath,
              isIndex,
            })
            break
          case 'update':
            const mod = modules.get(specifier)
            if (mod) {
              mod.applyUpdate(updateUrl)
            }
            break
          case 'remove':
            if (modules.has(specifier)) {
              modules.delete(specifier)
              events.emit('remove-module', specifier)
            }
            break
        }
        console.log(`[HMR] ${type} module '${specifier}'`)
      } catch (err) {
        console.warn(err)
      }
    }
  })
}

export function createHotContext(specifier: string) {
  if (modules.has(specifier)) {
    const mod = modules.get(specifier)!
    mod.lock()
    return mod
  }

  const mod = new Module(specifier)
  modules.set(specifier, mod)
  return mod
}
