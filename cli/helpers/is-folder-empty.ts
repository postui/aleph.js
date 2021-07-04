import { green, blue } from 'https://deno.land/std@0.96.0/fmt/colors.ts'
import { join } from 'https://deno.land/std/path/mod.ts'

export default function (root: string, name: string): boolean {
  const validFiles = [
    '.DS_Store',
    '.git',
    '.gitattributes',
    '.gitignore',
    '.gitlab-ci.yml',
    '.hg',
    '.hgcheck',
    '.hgignore',
    '.idea',
    '.travis.yml',
    'LICENSE',
    'Thumbs.db',
    'docs',
    'mkdocs.yml',
  ]

  const conflicts = []

  for (const { name: file } of Deno.readDirSync(root)) {
    // Support IntelliJ IDEA-based editors
    if (validFiles.includes(file) || /\.iml$/.test(file)) {
      conflicts.push(file)
    }
  }

  if (conflicts.length > 0) {
    console.log(
      `The directory ${green(name)} contains files that could conflict:`
    )
    console.log()

    for (const file of conflicts) {
      try {
        const stats = Deno.lstatSync(join(root, file))
        if (stats.isDirectory) {
          console.log(`  ${blue(file)}/`)
        } else {
          console.log(`  ${file}`)
        }
      } catch {
        console.log(`  ${file}`)
      }
    }

    console.log()
    console.log(
      'Either try using a new directory name, or remove the files listed above.'
    )
    console.log()

    return false
  }

  return true

}
