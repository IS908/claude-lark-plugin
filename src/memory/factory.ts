import { appConfig } from '../config.js';
import type { MemoryProvider } from './interface.js';
import { FileMemoryProvider } from './file.js';
import { OpenVikingMemoryProvider } from './openviking.js';
import { Mem0MemoryProvider } from './mem0.js';

/**
 * Create a MemoryProvider based on MEMORY_PROVIDER config.
 * Falls back to file adapter if the selected adapter is not implemented.
 */
export function createMemoryProvider(): MemoryProvider {
  const provider = appConfig.memoryProvider;

  switch (provider) {
    case 'openviking':
      console.error('[memory] OpenViking adapter selected but not yet implemented. Falling back to file adapter.');
      return new FileMemoryProvider();

    case 'mem0':
      console.error('[memory] mem0 adapter selected but not yet implemented. Falling back to file adapter.');
      return new FileMemoryProvider();

    case 'file':
    default:
      console.error(`[memory] Using file-based memory adapter (${appConfig.memoriesDir})`);
      return new FileMemoryProvider();
  }
}
