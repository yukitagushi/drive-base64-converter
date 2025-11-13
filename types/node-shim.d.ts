declare module 'node:path' {
  export function extname(path: string): string;
}

declare const Buffer: {
  from(data: string, encoding?: BufferEncoding): Buffer;
  from(data: ArrayBufferLike, byteOffset?: number, length?: number): Buffer;
  from(data: ArrayBufferView): Buffer;
  from(data: ArrayLike<number>): Buffer;
  isBuffer(value: unknown): value is Buffer;
  alloc(size: number, fill?: string | number, encoding?: BufferEncoding): Buffer;
  concat(list: readonly Buffer[], totalLength?: number): Buffer;
};

declare interface Buffer extends Uint8Array {
  toString(encoding?: BufferEncoding, start?: number, end?: number): string;
  subarray(start?: number, end?: number): Buffer;
  slice(start?: number, end?: number): Buffer;
  indexOf(value: string | number | Buffer, byteOffset?: number): number;
  equals(otherBuffer: Buffer): boolean;
}

declare type BufferEncoding =
  | 'ascii'
  | 'utf8'
  | 'utf-8'
  | 'utf16le'
  | 'ucs2'
  | 'ucs-2'
  | 'base64'
  | 'base64url'
  | 'latin1'
  | 'binary'
  | 'hex';

declare var process: {
  env: Record<string, string | undefined>;
};

declare interface ArrayBufferView {
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
  readonly byteLength: number;
}

declare function require(id: string): any;

declare module '@vercel/node' {
  export type VercelRequest = any;
  export type VercelResponse = any;
}

declare module 'jszip' {
  export interface JSZipObject {
    name: string;
    dir: boolean;
    async(type: 'string'): Promise<string>;
  }
  export default class JSZip {
    files: Record<string, JSZipObject>;
    file(name: string): JSZipObject | null;
    static loadAsync(data: ArrayBufferLike | ArrayBufferView | Buffer | Blob): Promise<JSZip>;
    loadAsync(data: ArrayBufferLike | ArrayBufferView | Buffer | Blob): Promise<JSZip>;
  }
}

declare module '@supabase/supabase-js' {
  export type SupabaseClient = any;
  export function createClient(url: string, key: string, options?: Record<string, any>): SupabaseClient;
}
