export interface ParsedNotification {
  pkg: string;
  title?: string;
  text?: string;
  when?: string;
  priority?: number;
}

export function parseNotifications(raw: string, packageFilter?: string): ParsedNotification[] {
  const results: ParsedNotification[] = [];

  const lines = raw.split(/\r?\n/);

  let current: ParsedNotification | null = null;

  for (const line of lines) {
    const recordMatch = line.match(/NotificationRecord\(.*?pkg=([^\s,)]+)/);
    if (recordMatch) {
      if (current) results.push(current);
      current = { pkg: recordMatch[1] };
      continue;
    }

    if (!current) continue;

    const titleMatch = line.match(/android\.title[=:]\s*(.+)/);
    if (titleMatch && !current.title) {
      current.title = cleanNotifValue(titleMatch[1]);
      continue;
    }

    const textMatch = line.match(/android\.text[=:]\s*(.+)/);
    if (textMatch && !current.text) {
      current.text = cleanNotifValue(textMatch[1]);
      continue;
    }

    const whenMatch = line.match(/\bwhen=(\d+)/);
    if (whenMatch && !current.when) {
      const ms = parseInt(whenMatch[1], 10);
      if (ms > 1_000_000_000_000) {
        current.when = new Date(ms).toISOString();
      }
      continue;
    }

    const priorityMatch = line.match(/\bpriority=(-?\d+)/);
    if (priorityMatch && current.priority === undefined) {
      current.priority = parseInt(priorityMatch[1], 10);
      continue;
    }
  }

  if (current) results.push(current);

  if (packageFilter) {
    return results.filter((n) => n.pkg === packageFilter || n.pkg.startsWith(packageFilter));
  }

  return results;
}

function cleanNotifValue(raw: string): string {
  return raw
    .replace(/^\s+|\s+$/g, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\s*\).*$/, "")
    .slice(0, 256);
}
