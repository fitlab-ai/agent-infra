import { dispatchHostControlCommand } from '../host-control/command.ts';
import { hostControlServiceStatus, installHostControlService, serveHostControlService, uninstallHostControlService } from '../host-control/service.ts';
import { internalHandlerRoute } from './cli-route-inventory.ts';

export async function hostControl(args: readonly string[]): Promise<void> {
  const action = args[0] ?? '';
  if (internalHandlerRoute('host-control', 'serve', action)) {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    await serveHostControlService({ dispatch: dispatchHostControlCommand }, controller.signal);
    return;
  }
  if (internalHandlerRoute('host-control', 'status', action)) {
    process.stdout.write(`${JSON.stringify(hostControlServiceStatus())}\n`);
    return;
  }
  if (internalHandlerRoute('host-control', 'install', action)) {
    process.stdout.write(`${JSON.stringify({ status: 'completed', path: installHostControlService() })}\n`);
    return;
  }
  if (internalHandlerRoute('host-control', 'uninstall', action)) {
    process.stdout.write(`${JSON.stringify({ status: 'completed', path: uninstallHostControlService() })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'HOST_CONTROL_COMMAND_INVALID', message: 'usage: host-control <serve|status|install|uninstall>' } })}\n`);
  process.exitCode = 1;
}
