import { blue, green, yellow, red, dim } from 'https://deno.land/std@0.99.0/fmt/colors.ts'

export type LevelNames = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export enum Level {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
  Fatal = 4,
}

export class Logger {
  #level: Level = Level.Info

  get level(): Level {
    return this.#level
  }

  setLevel(level: LevelNames): void {
    switch (level) {
      case 'debug':
        this.#level = Level.Debug
        break
      case 'info':
        this.#level = Level.Info
        break
      case 'warn':
        this.#level = Level.Warn
        break
      case 'error':
        this.#level = Level.Error
        break
      case 'fatal':
        this.#level = Level.Fatal
        break
    }
  }

  debug(...args: unknown[]): void {
    if (this.#level <= Level.Debug) {
      console.debug(blue('DEBUG'), ...args)
    }
  }

  info(...args: unknown[]): void {
    if (this.#level <= Level.Info) {
      console.log(green('INFO'), ...args)
    }
  }

  warn(...args: unknown[]): void {
    if (this.#level <= Level.Warn) {
      console.warn(yellow('WARN'), ...args)
    }
  }

  error(...args: unknown[]): void {
    if (this.#level <= Level.Error) {
      console.error(red('ERROR'), ...args)
    }
  }

  fatal(...args: unknown[]): void {
    if (this.#level <= Level.Fatal) {
      console.error(red('FATAL'), ...args)
      Deno.exit(1)
    }
  }
}

export class Measure {
  #t: number

  constructor() {
    this.#t = logger.level === Level.Debug ? performance.now() : 0
  }

  stop(message?: string) {
    if (this.#t > 0) {
      const now = performance.now()
      if (message) {
        const d = Math.round(now - this.#t)
        let cf = green
        if (d > 10000) {
          cf = red
        } else if (d > 1000) {
          cf = yellow
        }
        console.debug(dim('TIMING'), message, 'in', cf(d + 'ms'))
      }
      this.#t = now
    }
  }
}

const logger = new Logger()

export default logger
