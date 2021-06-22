import { dirname } from 'https://deno.land/std@0.99.0/path/mod.ts'
import { ensureDir } from 'https://deno.land/std@0.99.0/fs/ensure_dir.ts'

/* check whether or not the given path exists as a directory. */
export async function existsDir(path: string): Promise<boolean> {
  try {
    const fi = await Deno.lstat(path)
    if (fi.isDirectory) {
      return true
    }
    return false
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return false
    }
    throw err
  }
}

/* check whether or not the given path exists as regular file. */
export async function existsFile(path: string): Promise<boolean> {
  try {
    const fi = await Deno.lstat(path)
    if (fi.isFile) {
      return true
    }
    return false
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return false
    }
    throw err
  }
}

/** ensure and write text file. */
export async function ensureTextFile(name: string, content: string): Promise<void> {
  const dir = dirname(name)
  await ensureDir(dir)
  await Deno.writeTextFile(name, content)
}

/** remove the file if it exists. */
export async function lazyRemove(name: string, options?: { recursive?: boolean }): Promise<void | Error> {
  try {
    await Deno.remove(name, options)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return
    }
    return Promise.reject(err)
  }
}
