/**
 * Inline sparkline charts using Unicode block elements.
 */

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export class Sparkline {
  render(values: number[], options?: { width?: number; min?: number; max?: number }): string {
    if (values.length === 0) return "";

    const width = options?.width ?? 20;
    const min = options?.min ?? Math.min(...values);
    const max = options?.max ?? Math.max(...values);
    const range = max - min || 1;

    // Downsample if needed
    let sampled = values;
    if (values.length > width) {
      sampled = [];
      const step = values.length / width;
      for (let i = 0; i < width; i++) {
        sampled.push(values[Math.floor(i * step)]!);
      }
    }

    return sampled
      .map((v) => {
        const normalized = (v - min) / range;
        const idx = Math.min(Math.floor(normalized * BLOCKS.length), BLOCKS.length - 1);
        return BLOCKS[idx];
      })
      .join("");
  }
}
