// DAP Content-Length framing for Node stdio streams.
const HEADER_END = '\r\n\r\n';
const MAX_FRAME_BYTES = 1024 * 1024;

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

export function createFrameReader(onMessage, onError) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const headerEnd = buffer.indexOf(HEADER_END);
        if (headerEnd === -1) {
          if (buffer.length > MAX_FRAME_BYTES * 2) {
            buffer = Buffer.alloc(0);
            onError('frame header is too large');
          }
          return;
        }
        const header = buffer.subarray(0, headerEnd).toString('ascii');
        const match = /content-length:\s*(\d+)/i.exec(header);
        if (!match) {
          buffer = buffer.subarray(headerEnd + HEADER_END.length);
          onError('frame header has no Content-Length');
          continue;
        }
        const length = Number(match[1]);
        if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) {
          buffer = Buffer.alloc(0);
          onError('frame Content-Length is invalid');
          return;
        }
        const start = headerEnd + HEADER_END.length;
        if (buffer.length < start + length) return;
        const body = buffer.subarray(start, start + length).toString('utf8');
        buffer = buffer.subarray(start + length);
        let message;
        try {
          message = JSON.parse(body);
        } catch (error) {
          onError(`frame body is not valid JSON: ${error.message}`);
          continue;
        }
        onMessage(message);
      }
    }
  };
}
