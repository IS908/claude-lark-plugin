/**
 * download_attachment + writeSdkResource smoke test.
 *
 * Verifies:
 *  - All three Lark SDK response shapes (Buffer / object.writeFile / Readable)
 *    are correctly written to disk by `writeSdkResource`.
 *  - The `download_attachment` tool routes resourceType by file_key prefix
 *    (img_* -> image, else -> file).
 *  - Saved filename preserves the original extension when `file_name` is
 *    provided (regression guard for the PDF-Claude-Read bug).
 *  - Error path returns a diagnostic message (not the old generic
 *    "Failed to download attachment").
 *  - Unknown SDK shape throws with a descriptive error (helps future
 *    SDK-upgrade triage).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { writeSdkResource, describeSdkResource } from '../src/sdk-resource.js';
import { capSanitizedFilename } from '../src/tools.js';
import { registerTools } from '../src/tools.js';
import type { MemoryStore } from '../src/memory/file.js';
import { IdentitySession } from '../src/identity-session.js';
import type { LarkChannel } from '../src/channel.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;

const tmpInbox = mkdtempSync(path.join(tmpdir(), 'download-attach-inbox-'));
process.env.LARK_INBOX_DIR = tmpInbox;

// 1. writeSdkResource: shape 1 (Buffer)
{
  const filePath = path.join(tmpInbox, 'shape1.bin');
  await writeSdkResource(Buffer.from('buffer-content'), filePath);
  const written = readFileSync(filePath, 'utf-8');
  if (written !== 'buffer-content') fail(`1: buffer write mismatch: ${written}`);
  passed++;
}

// 2. writeSdkResource: shape 2 (object with .writeFile method)
{
  const filePath = path.join(tmpInbox, 'shape2.bin');
  const mockSdkResp = {
    async writeFile(p: string): Promise<void> {
      const fsp = await import('node:fs/promises');
      await fsp.writeFile(p, 'sdk-writeFile-content');
    },
  };
  await writeSdkResource(mockSdkResp, filePath);
  const written = readFileSync(filePath, 'utf-8');
  if (written !== 'sdk-writeFile-content') fail(`2: sdk writeFile mismatch: ${written}`);
  passed++;
}

// 3. writeSdkResource: shape 3 (Readable stream)
{
  const filePath = path.join(tmpInbox, 'shape3.bin');
  const stream = Readable.from([Buffer.from('chunk1-'), Buffer.from('chunk2')]);
  await writeSdkResource(stream, filePath);
  const written = readFileSync(filePath, 'utf-8');
  if (written !== 'chunk1-chunk2') fail(`3: stream write mismatch: ${written}`);
  passed++;
}

// 4. writeSdkResource: unknown shape throws descriptively
{
  try {
    await writeSdkResource({ randomKey: 'no writeFile, no pipe' }, path.join(tmpInbox, 'nope.bin'));
    fail('4: should have thrown on unknown shape');
  } catch (err: any) {
    if (!/unrecognised SDK response shape/.test(err.message)) {
      fail(`4: error message lacks diagnostic: ${err.message}`);
    }
    if (!/object\{randomKey\}/.test(err.message)) {
      fail(`4: error message lacks shape descriptor: ${err.message}`);
    }
  }
  passed++;
}

// 5. writeSdkResource: null/undefined throws cleanly
{
  try {
    await writeSdkResource(null, path.join(tmpInbox, 'null.bin'));
    fail('5a: should have thrown on null');
  } catch (err: any) {
    if (!/null/.test(err.message)) fail(`5a: bad null error: ${err.message}`);
  }
  try {
    await writeSdkResource(undefined, path.join(tmpInbox, 'undef.bin'));
    fail('5b: should have thrown on undefined');
  } catch (err: any) {
    if (!/undefined/.test(err.message)) fail(`5b: bad undefined error: ${err.message}`);
  }
  passed++;
}

// 6. describeSdkResource: produces useful labels
{
  if (describeSdkResource(Buffer.from('x')) !== 'Buffer') fail('6: Buffer label');
  if (describeSdkResource({ writeFile: () => {} }) !== 'object{writeFile()}') fail('6: writeFile label');
  if (describeSdkResource(Readable.from([])) !== 'ReadableStream') fail('6: stream label');
  if (describeSdkResource(null) !== 'null') fail('6: null label');
  passed++;
}

const apiCalls: { method: string; args: any }[] = [];

function mockClient(respFor: (fileKey: string, type: string) => unknown) {
  return {
    im: {
      v1: {
        message: { create: async () => ({}), reply: async () => ({}) },
        messageReaction: { create: async () => {}, delete: async () => {} },
        image: { create: async () => ({}), get: async () => Buffer.from('') },
        file: { create: async () => ({}) },
        messageResource: {
          get: async (args: any) => {
            apiCalls.push({ method: 'messageResource.get', args });
            return respFor(args?.path?.file_key, args?.params?.type);
          },
        },
      },
    },
  };
}

const noopMemory = {
  healthCheck: async () => true,
  getProfile: async () => null,
  saveProfile: async () => {},
  searchEpisodes: async () => [],
  saveEpisode: async () => {},
  listEpisodes: async () => [],
  deleteEpisodes: async () => {},
  searchSkills: async () => [],
  saveSkill: async () => {},
} as unknown as MemoryStore;

const fakeChannel = { isPrivateChat: () => true } as unknown as LarkChannel;
const handlers = new Map<string, (args: any) => Promise<any>>();
const fakeServer = {
  registerTool(name: string, _config: any, handler: any) {
    handlers.set(name, handler);
  },
};

function setup(respFor: (fileKey: string, type: string) => unknown) {
  apiCalls.length = 0;
  const client = mockClient(respFor);
  const identitySession = new IdentitySession(() => null);
  identitySession.setCaller('chat_001', undefined, 'ou_caller');
  registerTools(
    fakeServer as any,
    client as any,
    noopMemory,
    identitySession,
    fakeChannel,
    { record() {}, flush: async () => {}, startAutoFlush: () => {}, stopAutoFlush: () => {} } as any,
    new Map<string, string>(),
    { ids: new Set(), add() {}, has: () => false } as any,
    undefined,
  );
  const dl = handlers.get('download_attachment');
  if (!dl) fail('download_attachment handler not registered');
  return dl;
}

// 7. img_* file_key routes to type='image'
{
  const dl = setup(() => Buffer.from('img-bytes'));
  const r = await dl({ message_id: 'om_x', file_key: 'img_abc' });
  if (apiCalls[0]?.args?.params?.type !== 'image') {
    fail(`7: expected type=image for img_* key, got ${apiCalls[0]?.args?.params?.type}`);
  }
  if (!/Downloaded to /.test(r.content[0].text)) fail(`7: success text wrong: ${r.content[0].text}`);
  passed++;
}

// 8. file_v3_* file_key routes to type='file'
{
  const dl = setup(() => Buffer.from('pdf-bytes'));
  await dl({ message_id: 'om_x', file_key: 'file_v3_xyz' });
  if (apiCalls[0]?.args?.params?.type !== 'file') {
    fail(`8: expected type=file for non-img key, got ${apiCalls[0]?.args?.params?.type}`);
  }
  passed++;
}

// 9. file_name preserves extension in saved path
{
  const dl = setup(() => Buffer.from('pdf-bytes'));
  const r = await dl({
    message_id: 'om_x',
    file_key: 'file_v3_xyz',
    file_name: 'report.pdf',
  });
  const txt = r.content[0].text as string;
  if (!txt.endsWith('file_v3_xyz-report.pdf')) {
    fail(`9: expected save path to end with file_v3_xyz-report.pdf, got: ${txt}`);
  }
  passed++;
}

// 10. file_name sanitization (path traversal / bad chars)
{
  const dl = setup(() => Buffer.from('x'));
  const r = await dl({
    message_id: 'om_x',
    file_key: 'file_v3_xyz',
    file_name: '../../../etc/passwd',
  });
  const txt = r.content[0].text as string;
  if (/\.\.\//.test(txt) || /\/etc\//.test(txt)) {
    fail(`10: path traversal not sanitized: ${txt}`);
  }
  if (!/passwd/.test(txt)) fail(`10: legitimate filename component lost: ${txt}`);
  passed++;
}

// 11. Shape 2 (writeFile method) end-to-end through the tool
{
  const dl = setup(() => ({
    async writeFile(p: string): Promise<void> {
      const fsp = await import('node:fs/promises');
      await fsp.writeFile(p, 'shape-2-end-to-end');
    },
  }));
  const r = await dl({ message_id: 'om_x', file_key: 'file_v3_pdf', file_name: 'doc.pdf' });
  const txt = r.content[0].text as string;
  const match = /Downloaded to (.+)/.exec(txt);
  if (!match) fail(`11: success text malformed: ${txt}`);
  const saved = readFileSync(match![1], 'utf-8');
  if (saved !== 'shape-2-end-to-end') fail(`11: file content wrong: ${saved}`);
  passed++;
}

// 12. SDK API error -> diagnostic, not generic "Failed"
{
  const dl = setup(() => {
    const err: any = new Error('boom');
    err.response = { data: { code: 99991668, msg: 'invalid file_key' } };
    throw err;
  });
  const r = await dl({ message_id: 'om_x', file_key: 'file_v3_bad' });
  if (!r.isError) fail('12: should set isError');
  const txt = r.content[0].text as string;
  if (!/99991668/.test(txt)) fail(`12: error code missing: ${txt}`);
  if (!/invalid file_key/.test(txt)) fail(`12: error msg missing: ${txt}`);
  if (!/file_v3_bad/.test(txt)) fail(`12: file_key context missing: ${txt}`);
  passed++;
}

// 13. Unknown SDK shape -> tool returns diagnostic isError
{
  const dl = setup(() => ({ unknownShape: true }));
  const r = await dl({ message_id: 'om_x', file_key: 'file_v3_xyz' });
  if (!r.isError) fail('13: should set isError for unknown shape');
  const txt = r.content[0].text as string;
  if (!/unrecognised SDK response shape/.test(txt)) {
    fail(`13: diagnostic text missing: ${txt}`);
  }
  passed++;
}

// 10b. file_name length cap preserves extension (NAME_MAX defense)
{
  const dl = setup(() => Buffer.from('x'));
  // 400-char filename; cap should kick in but .pdf must survive
  const longName = 'a'.repeat(400) + '.pdf';
  const r = await dl({
    message_id: 'om_x',
    file_key: 'file_v3_xyz',
    file_name: longName,
  });
  const txt = r.content[0].text as string;
  const match = /Downloaded to (.+)/.exec(txt);
  if (!match) fail(`10b: tool did not succeed: ${txt}`);
  const baseName = path.basename(match![1]);
  const sanitizedPortion = baseName.slice(baseName.indexOf('-') + 1);
  if (sanitizedPortion.length > 200) {
    fail(`10b: sanitized portion not capped: ${sanitizedPortion.length} chars`);
  }
  if (!sanitizedPortion.endsWith('.pdf')) {
    fail(`10b: extension lost during cap: ${sanitizedPortion}`);
  }
  passed++;
}

// 10c. capSanitizedFilename helper — direct unit tests
{
  // Short names pass through (sanitized)
  if (capSanitizedFilename('report.pdf', 200) !== 'report.pdf') fail('10c.1');
  // Long stem, extension preserved
  const r2 = capSanitizedFilename('a'.repeat(300) + '.pdf', 200);
  if (!r2.endsWith('.pdf')) fail(`10c.2: ext lost: ${r2}`);
  if (r2.length > 200) fail(`10c.2: not capped: ${r2.length}`);
  // No extension
  const r3 = capSanitizedFilename('x'.repeat(300), 200);
  if (r3.length !== 200) fail(`10c.3: no-ext cap: ${r3.length}`);
  // Pathological long extension — capped at half maxLen so stem keeps space
  const r4 = capSanitizedFilename('stem.' + 'e'.repeat(300), 200);
  if (r4.length > 200) fail(`10c.4: long-ext not capped: ${r4.length}`);
  if (!r4.startsWith('stem')) fail(`10c.4: stem lost: ${r4}`);
  // Leading-dot file (e.g. ".env") — no extension to preserve
  if (capSanitizedFilename('.env', 200) !== '.env') fail('10c.5');
  // CJK chars stripped (sanitization preserved)
  if (capSanitizedFilename('报告.pdf', 200) !== '__.pdf') fail('10c.6');
  // path traversal stripped
  const r7 = capSanitizedFilename('../../etc/passwd', 200);
  if (r7.includes('/') || r7.includes('..')) fail(`10c.7: traversal: ${r7}`);
  passed++;
}

rmSync(tmpInbox, { recursive: true, force: true });
delete process.env.LARK_INBOX_DIR;

console.log(`download-attachment smoke: ${passed}/15 PASS`);

