declare module 'node:crypto' {
  export function randomUUID(): string;
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): { digest(encoding: 'hex'): string };
    digest(encoding: 'hex'): string;
  };
}

declare module 'node:fs/promises' {
  type FileHandle = unknown;
  export function readFile(path: string, options?: any): Promise<string | Buffer>;
  export function writeFile(path: string, data: string | Uint8Array, options?: any): Promise<void>;
  export function mkdir(path: string, options?: any): Promise<void>;
  export type Stats = unknown;
  export { FileHandle };
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
  export function extname(path: string): string;
}

declare module 'node:http' {
  import type { EventEmitter } from 'node:events';
  interface IncomingMessage extends EventEmitter {
    headers: Record<string, string | string[] | undefined>;
    method?: string;
    body?: unknown;
    [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | string>;
  }
  interface ServerResponse extends EventEmitter {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(data?: any): void;
    status?(code: number): ServerResponse;
    json?(body: unknown): void;
  }
  export { IncomingMessage, ServerResponse };
}

declare module 'node:url' {
  export class URL {
    constructor(input: string, base?: string);
    readonly pathname: string;
    readonly search: string;
    readonly href: string;
  }
}

declare module 'node:events' {
  class EventEmitter {
    on(event: string | symbol, listener: (...args: any[]) => void): this;
    once(event: string | symbol, listener: (...args: any[]) => void): this;
    emit(event: string | symbol, ...args: any[]): boolean;
  }
  export { EventEmitter };
}

declare var Buffer: {
  from(data: string | ArrayBuffer | ArrayLike<number>, encoding?: BufferEncoding): Buffer;
  concat(list: readonly Buffer[]): Buffer;
  isBuffer(value: unknown): value is Buffer;
};

interface Buffer extends Uint8Array {
  toString(encoding?: BufferEncoding): string;
  slice(start?: number, end?: number): Buffer;
  readonly length: number;
}

type BufferEncoding = 'utf8' | 'utf-8' | 'latin1' | 'binary' | 'hex' | 'base64';

declare namespace NodeJS {
  interface ErrnoException extends Error {
    code?: string;
  }
}

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
  exit(code?: number): never;
  on(event: string, listener: (...args: any[]) => void): void;
};

declare const console: {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
  warn: (...args: any[]) => void;
};
