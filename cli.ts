import { parse } from 'https://deno.land/std@0.96.0/flags/mod.ts'
import { resolve } from 'https://deno.land/std@0.96.0/path/mod.ts'
import { existsDir } from './shared/fs.ts'
import log, { LevelNames } from './shared/log.ts'
import util from './shared/util.ts'
import { VERSION } from './version.ts';

const commands = {
  'init': 'Create a new app',
  'dev': 'Start the app in development mode',
  'start': 'Start the app in production mode',
  'build': 'Build the app to a static site (SSG)',
  'analyze': 'Analyze the app deps',
  'upgrade': 'Upgrade Aleph.js command',
};

const helpMessage = `Aleph.js v${VERSION}
The Full-stack Framework in Deno.

Docs: https://alephjs.org/docs
Bugs: https://github.com/alephjs/aleph.js/issues

Usage:
    aleph <command> [...options]

Commands:
    ${
  Object.entries(commands).map(([name, desc]) => `${name.padEnd(15)}${desc}`)
  .join('\n    ')
}

Options:
    -v, --version  Prints version number
    -h, --help     Prints help message
`;

async function main() {
  const { _: args, ...options } = parse(Deno.args);

  // prints aleph.js version
  if (options.v) {
    console.log(`aleph.js v${VERSION}`);
    Deno.exit(0);
  }

  // prints aleph.js and deno version
  if (options.version) {
    const { deno, v8, typescript } = Deno.version;
    console.log([
      `aleph.js ${VERSION}`,
      `deno ${deno}`,
      `v8 ${v8}`,
      `typescript ${typescript}`,
    ].join('\n'));
    Deno.exit(0);
  }

  // prints help message when the command not found
  if (!(args.length > 0 && args[0] in commands)) {
    console.log(helpMessage);
    Deno.exit(0);
  }

  const command = String(args.shift()) as keyof typeof commands;

  // prints command help message
  if (options.h || options.help) {
    import(`./cli/${command}.ts`).then(({ helpMessage }) => {
      console.log(commands[command]);
      console.log(helpMessage);
      Deno.exit(0);
    });
    return;
  }

  // import command module
  const { default: cmd } = await import(`./cli/${command}.ts`);

  // execute `init` command
  if (command === 'init') {
    await cmd(options?.template, args[0]);
    return;
  }

  // execute `upgrade` command
  if (command === 'upgrade') {
    await cmd(options.v || options.version || args[0] || 'latest');
    return;
  }

  // set log level
  const l = options.L || options['log-level'];
  if (util.isNEString(l)) {
    log.setLevel(l.toLowerCase() as LevelNames);
  }

  // check working dir
  const workingDir = resolve(String(args[0] || '.'));
  if (!await existsDir(workingDir)) {
    log.fatal('No such directory:', workingDir);
  }

  await cmd(workingDir, options);
}

if (import.meta.main) {
  main();
}
