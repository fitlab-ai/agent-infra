import pc from 'picocolors';

function info(...args: unknown[]) {
  const msg = args.join(' ');
  process.stdout.write(`  ${pc.bold(pc.blue('>'))} ${msg}\n`);
}

function ok(...args: unknown[]) {
  const msg = args.join(' ');
  process.stdout.write(`  ${pc.bold(pc.green('\u2713'))} ${msg}\n`);
}

function err(...args: unknown[]) {
  const msg = args.join(' ');
  process.stderr.write(`  ${pc.bold(pc.red('\u2717'))} ${msg}\n`);
}

function ask(text: string) {
  process.stdout.write(`  ${pc.bold(pc.yellow('?'))} ${text}`);
}

export { info, ok, err, ask };
