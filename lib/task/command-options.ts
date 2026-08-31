type TaskScope = {
  taskRef?: string;
  positionals: string[];
  explicit: boolean;
};

function parseTaskScope(args: string[]): TaskScope {
  const positionals: string[] = [];
  let taskRef: string | undefined;
  let explicit = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    let value: string | undefined;
    if (arg === '--task' || arg === '-t') {
      value = args[++index];
      if (value === undefined || value === '' || value.startsWith('-')) throw new Error(`${arg} requires a value`);
    } else if (arg.startsWith('--task=')) {
      throw new Error("--task=... is not supported; use --task <ref> or -t <ref>");
    } else {
      positionals.push(arg);
      continue;
    }
    if (explicit) throw new Error("duplicate option '--task'");
    taskRef = value;
    explicit = true;
  }
  return { taskRef, positionals, explicit };
}

export { parseTaskScope };
export type { TaskScope };
