const OPENAI_API_BASE = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
const DEFAULT_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1';
const OPENAI_MAX_BYTES = 25 * 1024 * 1024; // 25MB limit documented by OpenAI audio APIs

export class OpenAITranscriptionError extends Error {
  status?: number;
  data?: any;

  constructor(message: string, options: { status?: number; data?: any } = {}) {
    super(message);
    this.name = 'OpenAITranscriptionError';
    this.status = options.status;
    this.data = options.data;
  }
}

function sanitizeErrorData(data: any): any {
  if (data == null) {
    return null;
  }
  if (typeof data === 'string') {
    return data.length > 2000 ? `${data.slice(0, 2000)}…` : data;
  }
  try {
    const json = JSON.stringify(data);
    if (json.length > 2000) {
      return `${json.slice(0, 2000)}…`;
    }
    return JSON.parse(json);
  } catch {
    return data;
  }
}

export function serializeOpenAIError(error: unknown): Record<string, any> | null {
  if (!error) {
    return null;
  }
  if (error instanceof OpenAITranscriptionError) {
    return {
      name: error.name,
      status: error.status ?? null,
      message: error.message,
      data: sanitizeErrorData(error.data),
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { error: String(error) };
}

export async function transcribeWithOpenAI(params: {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  language?: string;
  prompt?: string;
}): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new OpenAITranscriptionError('OPENAI_API_KEY が設定されていません。');
  }

  const fileName = params.fileName || 'audio';
  const mimeType = params.mimeType || 'application/octet-stream';
  let buffer = Buffer.isBuffer(params.buffer) ? params.buffer : Buffer.from(params.buffer);

  if (buffer.length > OPENAI_MAX_BYTES) {
    console.warn('transcribeWithOpenAI: truncating media for OpenAI limit', {
      mimeType,
      fileName,
      originalBytes: buffer.length,
      truncatedTo: OPENAI_MAX_BYTES,
    });
    buffer = buffer.subarray(0, OPENAI_MAX_BYTES);
  }

  const formData = new FormData();
  const blobSource = new Uint8Array(buffer);
  const fileBlob = new File([blobSource], fileName, { type: mimeType });
  formData.append('file', fileBlob);
  formData.append('model', DEFAULT_TRANSCRIPTION_MODEL);
  formData.append('response_format', 'text');
  if (params.language) {
    formData.append('language', params.language);
  }
  if (params.prompt) {
    formData.append('prompt', params.prompt);
  }

  let response: Response;
  try {
    response = await fetch(`${OPENAI_API_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });
  } catch (error: any) {
    throw new OpenAITranscriptionError(error?.message || 'OpenAI transcription request に失敗しました。', {
      data: error,
    });
  }

  const rawText = await response.text();
  if (!response.ok) {
    let payload: any = null;
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = rawText;
    }
    const message =
      (payload?.error?.message as string | undefined) ||
      `OpenAI transcription API が ${response.status} で失敗しました。`;
    throw new OpenAITranscriptionError(message, {
      status: response.status,
      data: payload,
    });
  }

  return rawText.trim();
}
