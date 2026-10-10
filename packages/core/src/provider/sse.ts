export interface SseEvent {
  event?: string;
  data: string;
}

export function parseSseChunks(chunks: string[]): SseEvent[] {
  const events: SseEvent[] = [];
  let buffer = "";
  for (const chunk of chunks) {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const dataLines: string[] = [];
      let eventName: string | undefined;
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("event:")) eventName = line.slice(6).trim();
      }
      const data = dataLines.join("\n");
      if (data.length === 0 || data === "[DONE]") continue;
      events.push(eventName ? { event: eventName, data } : { data });
    }
  }
  return events;
}

export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const flushable: string[] = [];
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        flushable.push(buffer.slice(0, index + 2));
        buffer = buffer.slice(index + 2);
      }
      if (flushable.length > 0) {
        for (const event of parseSseChunks(flushable)) yield event;
      }
    }
    if (buffer.trim().length > 0) {
      for (const event of parseSseChunks([`${buffer}\n\n`])) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}
