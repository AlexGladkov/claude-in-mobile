/**
 * Secret redaction for REPL output.
 *
 * The terminal stream from `repl_snapshot` is the most likely source of leaked
 * credentials: developers paste tokens, exports show env, password prompts
 * echo on some configurations. We replace structured token families and
 * generic sensitive assignments with a stable marker BEFORE the snapshot
 * leaves the plugin process.
 *
 * Terminal control sequences are removed from a canonical logical stream for
 * matching, while every logical code unit retains its original source span.
 * This catches credentials split by ANSI/OSC controls without stripping
 * unrelated terminal formatting from the returned raw stream.
 *
 * False positives are acceptable; false negatives are not.
 */

import { terminalControlEnd } from "../../utils/terminal-controls.js";

export interface RedactionPattern {
  name: string;
  re: RegExp;
}

export const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  { name: "aws-access-key", re: /(?:AKIA|ASIA|AIDA|AROA|AGPA|AIPA|ANPA|ANVA|ASCA|ACCA|ABIA|A3T[A-Z0-9])[0-9A-Z]{16}/g },
  { name: "aws-secret", re: /(?<![A-Za-z0-9_/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9_/+=])/g },
  { name: "github-pat", re: /(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{36,}/g },
  { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
  { name: "openai-key", re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._\-]+/gi },
  { name: "jwt", re: /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g },
  { name: "google-api-key", re: /AIza[0-9A-Za-z\-_]{35}/g },
  { name: "slack-token", re: /xox[abprs]-[A-Za-z0-9\-]+/g },
];

const REDACTED_MARKER = "[REDACTED]";

const SENSITIVE_ENV_NAME_RE =
  /(?:^|_)(?:PASSWORD|PASSWD|TOKEN|SECRET|API[_-]?KEY|ACCESS[_-]?(?:KEY|TOKEN)|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|AUTH(?:ORIZATION|[_-]?TOKEN)|CREDENTIALS?|PRIVATE[_-]?KEY)(?:_|$)/iu;

// Generic assignment/prompt rules stay private so REDACTION_PATTERNS remains
// the structured token parity contract shared with the native redactor.
const GENERIC_ASSIGNMENT_RE =
  /(^|[^\p{L}\p{N}_-])([A-Za-z][A-Za-z0-9_.-]*)([ \t]*[=:][ \t]*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s\r\n]+))/gu;
const ASSIGNMENT_VALUE_RE =
  /^([A-Za-z][A-Za-z0-9_.-]*)([ \t]*[=:][ \t]*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s\r\n]+))/u;
const PASSWORD_INLINE_PROMPT_RE =
  /(^|[\r\n])([^\r\n]*\b(?:pass(?:word)?|passwd|passphrase|passcode|secret|token|api[\s_-]*key)[^\r\n]*[:>][ \t]*)([^\r\n]*?\S)([ \t]*)(?=(?:\r\n|[\r\n])|$)/giu;


const PASSWORD_PROMPT_RE =
  /(^|[\r\n])([^\r\n]*\b(?:pass(?:word)?|passwd|passphrase|passcode|secret|token|api[\s_-]*key)[^\r\n]*[:>][ \t]*)(\r\n|[\r\n])((?:[ \t]*(?:\r\n|[\r\n]))*)([ \t]*)([^\r\n]*?\S)([ \t]*)(?=(?:\r\n|[\r\n])|$)/giu;


interface LogicalRange {
  readonly start: number;
  readonly end: number;
}

type LogicalRangeSelector = (
  match: RegExpMatchArray,
  matchStart: number,
) => LogicalRange | undefined;

interface LogicalRedactionResult {
  readonly document: LogicalDocument;
  readonly replacements: SourceSpan[];
}


const SENSITIVE_COMMAND_FLAGS: Readonly<Record<string, true>> = {
  "--api-key": true,
  "--api_key": true,
  "--key": true,
  "--token": true,
  "--password": true,
  "--passwd": true,
  "--secret": true,
  "--access-token": true,
  "--access_token": true,
  "--refresh-token": true,
  "--refresh_token": true,
  "--client-secret": true,
  "--client_secret": true,
  "--auth-token": true,
  "--auth_token": true,
  "--authorization": true,
  "--credential": true,
  "--credentials": true,
  "--private-key": true,
  "--private_key": true,
};

interface CommandToken {
  readonly start: number;
  readonly end: number;
}

interface CommandReplacement {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

interface LogicalDocument {
  /**
   * Logical text has terminal escape/control sequences removed. The parallel
   * sourceSpans array maps each UTF-16 code unit back to the original input.
   */
  readonly text: string;
  readonly sourceSpans: readonly (SourceSpan | undefined)[];
}

/**
 * Redact credentials in terminal output.
 *
 * Matching happens against a logical stream with ANSI/OSC controls removed;
 * replacements are then projected onto the original source string using
 * source offsets. Thus a token split as `AKIA\\x1b[0mIOS...` is replaced as
 * one token, while controls outside the token remain intact.
 */
export function redactScreen(text: string): string {
  const logical = buildLogicalDocument(text);
  const replacements = collectRedactions(logical);
  return applyRedactions(text, replacements);
}

/**
 * Redact credential values embedded in a REPL command line.
 *
 * This deliberately handles only common credential-bearing assignments and
 * options. Token-aware replacement preserves whitespace, quoting, and every
 * unrelated argument; in particular, a bare `-p` only consumes the next token
 * when that token is present and is not another option.
 */
export function redactCommandLine(command: string): string {
  const tokens = tokenizeCommandLine(command);
  const replacements: CommandReplacement[] = [];
  const consumed = new Set<number>();

  for (let index = 0; index < tokens.length; index += 1) {
    if (consumed.has(index)) continue;

    const token = tokens[index];
    const raw = command.slice(token.start, token.end);
    const equals = raw.indexOf("=");
    const assignmentName = equals > 0 ? raw.slice(0, equals) : "";

    if (equals > 0 && SENSITIVE_ENV_NAME_RE.test(assignmentName)) {
      const replacement = replacementForTokenValue(command, token, equals + 1, raw.length);
      if (replacement !== undefined) replacements.push(replacement);
      continue;
    }

    const flag = equals >= 0 ? raw.slice(0, equals).toLowerCase() : raw.toLowerCase();
    if (SENSITIVE_COMMAND_FLAGS[flag] === true) {
      if (equals >= 0) {
        const replacement = replacementForTokenValue(command, token, equals + 1, raw.length);
        if (replacement !== undefined) replacements.push(replacement);
      } else {
        const next = tokens[index + 1];
        if (next !== undefined) {
          const nextRaw = command.slice(next.start, next.end);
          if (!nextRaw.startsWith("-")) {
            const replacement = replacementForTokenValue(
              command,
              next,
              0,
              nextRaw.length,
            );
            if (replacement !== undefined) {
              replacements.push(replacement);
              consumed.add(index + 1);
            }
          }
        }
      }
      continue;
    }

    const attachedMysqlPasswordStart = mysqlPasswordValueStart(raw);
    if (attachedMysqlPasswordStart !== undefined) {
      const replacement = replacementForTokenValue(
        command,
        token,
        attachedMysqlPasswordStart,
        raw.length,
      );
      if (replacement !== undefined) replacements.push(replacement);
      continue;
    }

    if (raw === "-p") {
      const next = tokens[index + 1];
      if (next !== undefined) {
        const nextRaw = command.slice(next.start, next.end);
        if (!nextRaw.startsWith("-")) {
          const replacement = replacementForTokenValue(command, next, 0, nextRaw.length);
          if (replacement !== undefined) {
            replacements.push(replacement);
            consumed.add(index + 1);
          }
        }
      }
    }
  }

  return redactScreen(applyCommandReplacements(command, replacements));
}

function tokenizeCommandLine(command: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let offset = 0;

  while (offset < command.length) {
    while (offset < command.length && /\s/u.test(command[offset] ?? "")) offset += 1;
    if (offset >= command.length) break;

    const start = offset;
    let quote: "'" | '"' | undefined;
    let escaped = false;

    while (offset < command.length) {
      const character = command[offset] ?? "";
      if (escaped) {
        escaped = false;
        offset += 1;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        offset += 1;
        continue;
      }
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
        offset += 1;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        offset += 1;
        continue;
      }
      if (/\s/u.test(character)) break;
      offset += 1;
    }

    tokens.push({ start, end: offset });
  }

  return tokens;
}

function replacementForTokenValue(
  command: string,
  token: CommandToken,
  valueStart: number,
  valueEnd: number,
): CommandReplacement | undefined {
  if (valueEnd <= valueStart) return undefined;

  const absoluteStart = token.start + valueStart;
  const absoluteEnd = token.start + valueEnd;
  const value = command.slice(absoluteStart, absoluteEnd);
  if (value.length === 0 || value === "''" || value === "\"\"") return undefined;

  const quote = value.length >= 2 && value[0] === value[value.length - 1]
    && (value[0] === "'" || value[0] === '"')
    ? value[0]
    : undefined;
  const replacement = quote === undefined
    ? REDACTED_MARKER
    : `${quote}${REDACTED_MARKER}${quote}`;

  return { start: absoluteStart, end: absoluteEnd, replacement };
}


function mysqlPasswordValueStart(token: string): number | undefined {
  if (!token.startsWith("-p") || token === "-p") return undefined;
  const start = token.startsWith("-p=") ? 3 : 2;
  return start < token.length ? start : undefined;
}

function applyCommandReplacements(
  input: string,
  replacements: readonly CommandReplacement[],
): string {
  if (replacements.length === 0) return input;

  const ordered = [...replacements].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const output: string[] = [];
  let cursor = 0;

  for (const replacement of ordered) {
    if (replacement.start < cursor) continue;
    output.push(input.slice(cursor, replacement.start), replacement.replacement);
    cursor = replacement.end;
  }

  output.push(input.slice(cursor));
  return output.join("");
}

function buildLogicalDocument(input: string): LogicalDocument {
  const text: string[] = [];
  const sourceSpans: Array<SourceSpan | undefined> = [];

  for (let offset = 0; offset < input.length; ) {
    const controlEnd = terminalControlEnd(input, offset);
    if (controlEnd !== undefined) {
      offset = controlEnd;
      continue;
    }

    const codePoint = input.codePointAt(offset);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const span = { start: offset, end: offset + character.length };
    text.push(character);
    // Regex indices are UTF-16 offsets, so map every code unit in a
    // surrogate pair to the same original source span.
    for (let unit = 0; unit < character.length; unit += 1) {
      sourceSpans.push(span);
    }
    offset += character.length;
  }

  return { text: text.join(""), sourceSpans };
}




function collectRedactions(document: LogicalDocument): SourceSpan[] {
  let current = document;
  const replacements: SourceSpan[] = [];

  // Redact complete prompt values first; otherwise a structured token inside a
  // prompt could leave an unredacted suffix of the same password entry.
  const inlinePrompt = redactLogicalMatches(
    current,
    PASSWORD_INLINE_PROMPT_RE,
    passwordInlinePromptRange,
  );
  current = inlinePrompt.document;
  replacements.push(...inlinePrompt.replacements);

  for (const { re } of REDACTION_PATTERNS) {
    // Do not mutate the shared rule's lastIndex. The same canonical rule set
    // is reused for every surface and every call.
    const result = redactLogicalMatches(current, re, (match, start) => ({
      start,
      end: start + match[0].length,
    }));
    current = result.document;
    replacements.push(...result.replacements);
  }

  for (const [re, selectRange] of [
    [GENERIC_ASSIGNMENT_RE, genericAssignmentRange] as const,
    [PASSWORD_PROMPT_RE, passwordPromptRange] as const,
  ]) {
    const result = redactLogicalMatches(current, re, selectRange);
    current = result.document;
    replacements.push(...result.replacements);
  }

  return replacements;
}

function redactLogicalMatches(
  document: LogicalDocument,
  re: RegExp,
  selectRange: LogicalRangeSelector,
): LogicalRedactionResult {
  const matcher = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const nextText: string[] = [];
  const nextSpans: Array<SourceSpan | undefined> = [];
  const replacements: SourceSpan[] = [];
  let cursor = 0;
  let matched = false;

  for (const match of document.text.matchAll(matcher)) {
    const matchStart = match.index ?? 0;
    const matchedText = match[0];
    if (matchedText.length === 0 || matchStart < cursor) continue;

    const matchEnd = matchStart + matchedText.length;
    const range = selectRange(match, matchStart);
    if (
      range === undefined ||
      range.start < matchStart ||
      range.end > matchEnd ||
      range.end <= range.start
    ) {
      continue;
    }

    nextText.push(document.text.slice(cursor, range.start));
    nextSpans.push(...document.sourceSpans.slice(cursor, range.start));
    nextText.push(REDACTED_MARKER);
    for (let unit = 0; unit < REDACTED_MARKER.length; unit += 1) {
      nextSpans.push(undefined);
    }
    nextText.push(document.text.slice(range.end, matchEnd));
    nextSpans.push(...document.sourceSpans.slice(range.end, matchEnd));

    const sourceSpan = sourceSpanForRange(document.sourceSpans, range.start, range.end);
    if (sourceSpan !== undefined) replacements.push(sourceSpan);
    cursor = matchEnd;
    matched = true;
  }

  if (!matched) return { document, replacements };

  nextText.push(document.text.slice(cursor));
  nextSpans.push(...document.sourceSpans.slice(cursor));
  return {
    document: { text: nextText.join(""), sourceSpans: nextSpans },
    replacements,
  };
}

function genericAssignmentRange(
  match: RegExpMatchArray,
  matchStart: number,
): LogicalRange | undefined {
  const prefix = match[1] ?? "";
  const key = match[2] ?? "";
  if (!SENSITIVE_ENV_NAME_RE.test(key)) return undefined;

  const separator = match[3] ?? "";
  const value = match[4] ?? match[5] ?? match[6];
  if (value === undefined || value.length === 0 || value === REDACTED_MARKER) {
    return undefined;
  }

  const quoted = match[4] !== undefined || match[5] !== undefined;
  const valueStart = matchStart + prefix.length + key.length + separator.length + (quoted ? 1 : 0);
  return { start: valueStart, end: valueStart + value.length };
}

function passwordInlinePromptRange(
  match: RegExpMatchArray,
  matchStart: number,
): LogicalRange | undefined {
  const prefix = match[1] ?? "";
  const prompt = match[2] ?? "";
  const value = match[3] ?? "";
  if (value.length === 0 || value === REDACTED_MARKER) {
    return undefined;
  }

  const valueStart = matchStart + prefix.length + prompt.length;
  const trimmed = value.trim();
  const assignment = ASSIGNMENT_VALUE_RE.exec(trimmed);
  if (assignment !== null && SENSITIVE_ENV_NAME_RE.test(assignment[1] ?? "")) {
    const assignmentValue = assignment[3] ?? assignment[4] ?? assignment[5];
    if (assignmentValue === undefined || assignmentValue.length === 0) {
      return undefined;
    }
    const quote = assignment[3] !== undefined || assignment[4] !== undefined ? 1 : 0;
    const assignmentStart =
      valueStart +
      value.indexOf(trimmed) +
      (assignment[1]?.length ?? 0) +
      (assignment[2]?.length ?? 0) +
      quote;
    return { start: assignmentStart, end: assignmentStart + assignmentValue.length };
  }

  const quoted =
    value.length >= 2 &&
    value[0] === value[value.length - 1] &&
    (value[0] === "'" || value[0] === '"');
  const start = valueStart + (quoted ? 1 : 0);
  const end = valueStart + value.length - (quoted ? 1 : 0);
  return { start, end };
}

function passwordPromptRange(
  match: RegExpMatchArray,
  matchStart: number,
): LogicalRange | undefined {
  const prefix = match[1] ?? "";
  const prompt = match[2] ?? "";
  const lineBreak = match[3] ?? "";
  const blankLines = match[4] ?? "";
  const leadingWhitespace = match[5] ?? "";
  const value = match[6] ?? "";
  if (value.length === 0 || value === REDACTED_MARKER) {
    return undefined;
  }

  const valueStart =
    matchStart +
    prefix.length +
    prompt.length +
    lineBreak.length +
    blankLines.length +
    leadingWhitespace.length;
  const trimmed = value.trim();
  const assignment = ASSIGNMENT_VALUE_RE.exec(trimmed);
  if (assignment !== null && SENSITIVE_ENV_NAME_RE.test(assignment[1] ?? "")) {
    const assignmentValue = assignment[3] ?? assignment[4] ?? assignment[5];
    if (assignmentValue === undefined || assignmentValue.length === 0) {
      return undefined;
    }
    const quote = assignment[3] !== undefined || assignment[4] !== undefined ? 1 : 0;
    const assignmentStart =
      valueStart +
      value.indexOf(trimmed) +
      (assignment[1]?.length ?? 0) +
      (assignment[2]?.length ?? 0) +
      quote;
    return { start: assignmentStart, end: assignmentStart + assignmentValue.length };
  }

  return { start: valueStart, end: valueStart + value.length };
}

function sourceSpanForRange(
  sourceSpans: readonly (SourceSpan | undefined)[],
  start: number,
  end: number
): SourceSpan | undefined {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;

  for (let offset = start; offset < end; offset += 1) {
    const span = sourceSpans[offset];
    if (span === undefined) continue;
    first = Math.min(first, span.start);
    last = Math.max(last, span.end);
  }

  return first === Number.POSITIVE_INFINITY ? undefined : { start: first, end: last };
}

function applyRedactions(input: string, replacements: readonly SourceSpan[]): string {
  if (replacements.length === 0) return input;

  const ordered = [...replacements].sort(
    (left, right) => left.start - right.start || left.end - right.end
  );
  const output: string[] = [];
  let cursor = 0;

  for (const replacement of ordered) {
    if (replacement.start < cursor) continue;
    output.push(input.slice(cursor, replacement.start), REDACTED_MARKER);
    cursor = replacement.end;
  }

  output.push(input.slice(cursor));
  return output.join("");
}
