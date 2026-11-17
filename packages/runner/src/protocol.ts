/** A transport bound, checked on every chunk before retaining it. */
export class BoundedChannel {
  private readonly chunks: Buffer[] = [];
  bytes = 0;
  constructor(readonly limit: number) {}
  push(chunk: Buffer): void {
    if (this.bytes + chunk.length > this.limit) throw new RangeError('Channel output limit exceeded');
    this.chunks.push(Buffer.from(chunk));
    this.bytes += chunk.length;
  }
  buffer(): Buffer { return Buffer.concat(this.chunks, this.bytes); }
}
export const MAX_METADATA_BYTES = 64 * 1024;
export const MAX_CREDENTIAL_BYTES = 64 * 1024;
export const MAX_ENVELOPE_BYTES = 1024 * 1024 + MAX_METADATA_BYTES + MAX_CREDENTIAL_BYTES;
export const FRAME_BYTES = 16 * 1024;

/** stderr is a framed diagnostic channel; stdout carries only the executor's fd3. */
export function diagnosticFrame(stream: 'stdout' | 'stderr', data: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = stream === 'stdout' ? 1 : 2;
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}
export class DiagnosticDecoder {
  private pending = Buffer.alloc(0);
  constructor(private readonly consume: (stream: 'stdout' | 'stderr', data: Buffer) => void) {}
  push(chunk: Buffer): void {
    // Docker can coalesce many small writes. Consume frames incrementally and
    // retain only one bounded partial frame rather than the whole transport.
    let offset = 0;
    while (offset < chunk.length) {
      const needed = this.pending.length < 5 ? 5 - this.pending.length : 5 + this.pending.readUInt32BE(1) - this.pending.length;
      const count = Math.min(needed, chunk.length - offset);
      this.pending = Buffer.concat([this.pending, chunk.subarray(offset, offset + count)]);
      offset += count;
      if (this.pending.length >= 5) {
        const length = this.pending.readUInt32BE(1);
        if ((this.pending[0] !== 1 && this.pending[0] !== 2) || length > FRAME_BYTES) throw new TypeError('Invalid diagnostic frame');
        if (this.pending.length === 5 + length) {
          this.consume(this.pending[0] === 1 ? 'stdout' : 'stderr', this.pending.subarray(5));
          this.pending = Buffer.alloc(0);
        }
      }
    }
  }
  finish(): void { if (this.pending.length) throw new TypeError('Truncated diagnostic frame'); }
}
