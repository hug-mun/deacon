export type TextChunk = {
  content: string;
  charStart: number;
  charEnd: number;
};

export function chunkText(text: string): TextChunk[] {
  const targetLength = 1800;
  const overlap = 200;
  const chunks: TextChunk[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + targetLength, text.length);
    if (end < text.length) {
      const whitespace = text.lastIndexOf(" ", end);
      if (whitespace > start + 900) end = whitespace;
    }

    const content = text.slice(start, end).trim();
    if (content) {
      chunks.push({ content, charStart: start, charEnd: end });
    }

    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}
