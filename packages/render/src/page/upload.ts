/**
 * Send a file to the harness in 4 MB pieces. Playwright sees request bodies through the DevTools
 * protocol, where binary bytes are escaped (up to 6 characters each); a single ~90 MB video upload
 * produced a message longer than Node's maximum string length and crashed the render process.
 * With `append`, the first piece appends too (for files written in several calls, e.g. a stream).
 */
const UPLOAD_CHUNK = 4 * 1024 * 1024;

export async function upload(name: string, data: ArrayBuffer | ArrayBufferView | string, opts: { append?: boolean } = {}) {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  for (let off = 0; off === 0 || off < bytes.length; off += UPLOAD_CHUNK) {
    const append = off > 0 || opts.append;
    const res = await fetch(`upload?name=${encodeURIComponent(name)}${append ? '&append=1' : ''}`, { method: 'POST', body: bytes.subarray(off, off + UPLOAD_CHUNK) as Uint8Array<ArrayBuffer> });
    if (!res.ok) throw new Error(`upload ${name} failed: ${res.status}`);
  }
}
