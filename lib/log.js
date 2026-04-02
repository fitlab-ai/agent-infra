import pc from 'picocolors';

function info(...args) {
  const msg = args.join(' ');
  process.stdout.write(`  ${pc.bold(pc.blue('>'))} ${msg}\n`);
}

function ok(...args) {
  const msg = args.join(' ');
  process.stdout.write(`  ${pc.bold(pc.green('\u2713'))} ${msg}\n`);
}

function err(...args) {
  const msg = args.join(' ');
  process.stderr.write(`  ${pc.bold(pc.red('\u2717'))} ${msg}\n`);
}

function ask(text) {
  process.stdout.write(`  ${pc.bold(pc.yellow('?'))} ${text}`);
}

export { info, ok, err, ask };
