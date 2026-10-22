// Ngữ cảnh theo request (correlation id) truyền ngầm qua AsyncLocalStorage, để logger, provider và job
// lấy được mà không phải truyền tham số qua mọi tầng (NFR-OBS-01).
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}
