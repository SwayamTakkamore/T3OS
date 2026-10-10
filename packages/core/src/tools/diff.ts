interface Op {
  kind: "keep" | "add" | "del";
  line: string;
}

function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "keep", line: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "del", line: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: "add", line: b[j]! });
      j += 1;
    }
  }
  while (i < n) ops.push({ kind: "del", line: a[i++]! });
  while (j < m) ops.push({ kind: "add", line: b[j++]! });
  return ops;
}

export function unifiedDiff(before: string, after: string, path: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = diffLines(a, b);
  const body = ops
    .map((op) => (op.kind === "keep" ? ` ${op.line}` : op.kind === "del" ? `-${op.line}` : `+${op.line}`))
    .join("\n");
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${a.length} +1,${b.length} @@`, body].join("\n");
}
