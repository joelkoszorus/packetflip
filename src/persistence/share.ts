/**
 * Share links: the save is deflate-compressed and base64url-encoded into the
 * URL *fragment* (#topo=...). Fragments are never sent to the web server, so
 * a shared network stays between the people who share it.
 * Decompression is streamed with a hard output cap (zip-bomb safe).
 */
import { LIMITS } from '../sim/limits';
import { parseSave } from './validate';
import type { SaveFile } from './validate';

export const SHARE_PREFIX = 'topo=';
export const MAX_SHARE_CHARS = 60_000;

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Share link contains invalid characters');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Shared network is too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function encodeShare(save: SaveFile): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(save));
  const compressed = await readCapped(streamOf(json).pipeThrough(new CompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>), LIMITS.maxSaveBytes);
  const encoded = toBase64Url(compressed);
  if (encoded.length > MAX_SHARE_CHARS) throw new Error('This network is too big to share as a link. Use Export instead.');
  return encoded;
}

export async function decodeShare(encoded: string): Promise<SaveFile> {
  if (encoded.length > MAX_SHARE_CHARS) throw new Error('Share link is too long');
  const bytes = fromBase64Url(encoded);
  const raw = await readCapped(
    streamOf(bytes).pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>),
    LIMITS.maxSaveBytes,
  );
  return parseSave(new TextDecoder('utf-8', { fatal: true }).decode(raw));
}

/** Extract the share payload from a location hash like "#topo=abc". */
export function shareFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  return h.startsWith(SHARE_PREFIX) ? h.slice(SHARE_PREFIX.length) : null;
}
