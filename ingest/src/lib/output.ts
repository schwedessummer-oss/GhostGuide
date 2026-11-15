/** Where commands print. Tests capture lines instead of writing to stdout. */
export interface Output {
  line(text: string): void;
}

export const consoleOutput: Output = {
  line: (text) => console.log(text),
};

export function captureOutput(): Output & { lines: string[] } {
  const lines: string[] = [];
  return { lines, line: (text) => lines.push(text) };
}
