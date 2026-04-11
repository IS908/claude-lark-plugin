import { appConfig } from '../config.js';
import type { MemoryProvider } from './interface.js';
import { FileMemoryProvider } from './file.js';
import { OpenVikingMemoryProvider } from './openviking.js';
import { Mem0MemoryProvider } from './mem0.js';

/**
 * Create a MemoryProvider based on MEMORY_PROVIDER config.
 * Calls healthCheck on startup and logs connectivity status.
 */
export async function createMemoryProvider(): Promise<MemoryProvider> {
  const provider = appConfig.memoryProvider;

  switch (provider) {
    case 'openviking': {
      const ov = new OpenVikingMemoryProvider(appConfig.openVikingUrl, appConfig.openVikingApiKey);
      const healthy = await ov.healthCheck();
      if (healthy) {
        console.error(`[memory] OpenViking connected at ${appConfig.openVikingUrl}`);
      } else {
        console.error(`[memory] WARNING: OpenViking unreachable at ${appConfig.openVikingUrl} — memory features may be degraded`);
      }
      return ov;
    }

    case 'mem0':
      console.error('[memory] mem0 adapter not yet implemented. Falling back to file adapter.');
      return new FileMemoryProvider();

    case 'file':
    default:
      console.error(`[memory] Using file-based memory adapter (${appConfig.memoriesDir})`);
      return new FileMemoryProvider();
  }
}
