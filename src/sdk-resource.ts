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
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

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
 * Sentinel thrown by `writeSdkResource` when the payload exceeds the
 * configured byte cap. Callers can `instanceof` this to distinguish
 * size-rejection from a malformed-SDK-shape error or an IO error and
 * surface a clean user-facing message ("file too large") instead of
 * a stack trace. See {@link writeSdkResource}.
 */
export class WriteSdkResourceTooLargeError extends Error {
  constructor(public readonly bytesSeen: number, public readonly maxBytes: number) {
    super(`writeSdkResource: payload exceeded max ${maxBytes} bytes (saw ≥ ${bytesSeen})`);
    this.name = 'WriteSdkResourceTooLargeError';
  }
}

/**
 * Write a Lark SDK binary-resource response to `filePath`. Handles the three
 * known response shapes. Throws on unrecognised shape with a descriptor of
 * what was actually received — much more useful than a silent
 * `[object Object]` written to disk.
 *
 * **Memory characteristics (#108 fix, v1.0.20)**: the Buffer branch
 * checks size BEFORE the disk write and the streaming branch uses
 * `pipeline(source, sizeCapTransform, createWriteStream)` so peak
 * memory stays at the SDK's native chunk size (default ~64KB) rather
 * than the entire file. Pre-v1.0.20 the streaming branch collected
 * every chunk into `Buffer.concat(chunks)` which made heap = file
 * size — a user posting 5 × 25MB images in a group could push
 * transient heap to 125MB+ and OOM a 1GB VM.
 *
 * **Size cap**: callers supply `opts.maxBytes`. Bytes counted across
 * chunk boundaries; exceeding mid-stream throws
 * {@link WriteSdkResourceTooLargeError} and DELETES the partial file
 * (best-effort cleanup) so the next caller doesn't read a truncated
 * payload. The opaque `object{writeFile()}` branch (Lark SDK's
 * convenience wrapper, used for files/PDFs) CANNOT enforce the cap
 * — we trust the SDK to honor the size during its own write; callers
 * with stricter requirements should pre-check the message metadata's
 * `file_size` field.
 *
 * Pass `Infinity` to opt out of the cap (terminal-side scripts /
 * tests that need it).
 */
export async function writeSdkResource(
  data: unknown,
  filePath: string,
  opts: { maxBytes: number } = { maxBytes: Infinity },
): Promise<void> {
  if (data === null || data === undefined) {
    throw new Error('writeSdkResource: data is null/undefined');
  }

  const { maxBytes } = opts;

  if (Buffer.isBuffer(data)) {
    if (data.length > maxBytes) {
      throw new WriteSdkResourceTooLargeError(data.length, maxBytes);
    }
    await fsp.writeFile(filePath, data);
    return;
  }

  const d = data as any;

  if (typeof d.writeFile === 'function') {
    // SDK's opaque writeFile — no introspection point for size, must trust
    // SDK and rely on the caller's pre-check (message.file_size from
    // Feishu API) for upper-bound enforcement.
    await d.writeFile(filePath);
    return;
  }

  if (typeof d.pipe === 'function' || typeof d[Symbol.asyncIterator] === 'function') {
    // Stream-to-disk via pipeline with a size-counting passthrough.
    // Throwing inside the transform cancels the pipeline and propagates
    // out of `await pipeline(...)`. Best-effort delete of the partial
    // file on any error so the next caller doesn't see a truncated payload.
    let bytesSeen = 0;
    const sizeCap = new Transform({
      transform(chunk, _enc, cb) {
        bytesSeen += chunk.length;
        if (bytesSeen > maxBytes) {
          cb(new WriteSdkResourceTooLargeError(bytesSeen, maxBytes));
          return;
        }
        cb(null, chunk);
      },
    });
    try {
      // AsyncIterable | Readable both accepted by pipeline.
      await pipeline(d as AsyncIterable<unknown>, sizeCap, createWriteStream(filePath));
    } catch (err) {
      try { await fsp.unlink(filePath); } catch { /* best-effort cleanup */ }
      throw err;
    }
    return;
  }

  throw new Error(
    `writeSdkResource: unrecognised SDK response shape (${describeSdkResource(data)}) — ` +
      'the Lark SDK returned a value not matching Buffer / .writeFile() / Readable. ' +
      'Likely an SDK upgrade introduced a new shape; extend writeSdkResource.',
  );
}
