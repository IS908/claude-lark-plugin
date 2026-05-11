/**
 * Helpers for writing Lark SDK binary-resource responses to disk.
 *
 * The `client.im.v1.messageResource.get` API can return one of three response
 * shapes depending on the resource type and SDK version:
 *
 *  1. `Buffer` — raw bytes (rare)
 *  2. Object with `.writeFile(path)` method — Lark SDK's typical convenience
 *     wrapper for binary resources (this is what file/PDF responses look like
 *     in @larksuiteoapi/node-sdk ≥1.60)
 *  3. Readable stream — exposes `.pipe()`, iterable via `for await`
 *
 * Node's `fs.writeFile` only handles shape 1 natively (and streams in newer
 * Node), so callers must inspect and dispatch. This module centralises the
 * dispatch so we don't drift between `channel.downloadImage` and
 * `tools.download_attachment` (a real v1.0.5 bug — see #60).
 */
import fsp from 'node:fs/promises';

export type SdkResource =
  | Buffer
  | { writeFile: (path: string) => Promise<void> | void }
  | NodeJS.ReadableStream
  | unknown;

/**
 * Diagnostic shape descriptor — surfaced in error messages so callers can
 * tell *why* the write failed (helpful when an SDK upgrade introduces a new
 * shape we don't recognise).
 */
export function describeSdkResource(data: unknown): string {
  if (data === null || data === undefined) return String(data);
  if (Buffer.isBuffer(data)) return 'Buffer';
  if (typeof data === 'object' && data !== null) {
    const d = data as any;
    if (typeof d.writeFile === 'function') return 'object{writeFile()}';
    if (typeof d.pipe === 'function') return 'ReadableStream';
    const keys = Object.keys(d).slice(0, 5).join(',');
    return `object{${keys}}`;
  }
  return typeof data;
}

/**
 * Write a Lark SDK binary-resource response to `filePath`. Handles the three
 * known response shapes. Throws on unrecognised shape with a descriptor of
 * what was actually received — much more useful than a silent
 * `[object Object]` written to disk.
 */
export async function writeSdkResource(data: unknown, filePath: string): Promise<void> {
  if (data === null || data === undefined) {
    throw new Error('writeSdkResource: data is null/undefined');
  }

  if (Buffer.isBuffer(data)) {
    await fsp.writeFile(filePath, data);
    return;
  }

  const d = data as any;

  if (typeof d.writeFile === 'function') {
    await d.writeFile(filePath);
    return;
  }

  if (typeof d.pipe === 'function' || typeof d[Symbol.asyncIterator] === 'function') {
    // Collect the full payload in memory before writing — the Lark SDK's
    // resource streams are small (≤ chat-message attachment size), and
    // buffering keeps the API symmetric with the Buffer branch (both use
    // async fsp.writeFile). If streaming-to-disk becomes a concern later,
    // swap to fsp.writeFile(filePath, stream) — supported in Node ≥18.
    const chunks: Buffer[] = [];
    for await (const chunk of d as AsyncIterable<unknown>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
    }
    await fsp.writeFile(filePath, Buffer.concat(chunks));
    return;
  }

  throw new Error(
    `writeSdkResource: unrecognised SDK response shape (${describeSdkResource(data)}) — ` +
      'the Lark SDK returned a value not matching Buffer / .writeFile() / Readable. ' +
      'Likely an SDK upgrade introduced a new shape; extend writeSdkResource.',
  );
}
