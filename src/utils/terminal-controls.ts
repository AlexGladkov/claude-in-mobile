export function terminalControlEnd(input: string, start: number): number | undefined {
  const code = input.charCodeAt(start);

  if (code === 0x1b) {
    const next = input.charCodeAt(start + 1);
    if (Number.isNaN(next)) return input.length;

    switch (next) {
      case 0x5b: // ESC [
        return consumeCsi(input, start + 2);
      case 0x50: // ESC P (DCS)
      case 0x58: // ESC X (SOS)
      case 0x5d: // ESC ] (OSC)
      case 0x5e: // ESC ^ (PM)
      case 0x5f: // ESC _ (APC)
        return consumeStringControl(input, start + 2);
      default:
        // Fe escape (including charset selection and two-byte commands).
        return Math.min(start + 2, input.length);
    }
  }

  switch (code) {
    case 0x9b: // C1 CSI
      return consumeCsi(input, start + 1);
    case 0x90: // C1 DCS
    case 0x98: // C1 SOS
    case 0x9d: // C1 OSC
    case 0x9e: // C1 PM
    case 0x9f: // C1 APC
      return consumeStringControl(input, start + 1);
    case 0x9c: // C1 ST
      return start + 1;
    default:
      return code >= 0x80 && code <= 0x9f ? start + 1 : undefined;
  }
}

export function stripTerminalControls(input: string): string {
  const output: string[] = [];
  for (let offset = 0; offset < input.length; ) {
    const controlEnd = terminalControlEnd(input, offset);
    if (controlEnd !== undefined) {
      offset = controlEnd;
      continue;
    }

    const codePoint = input.codePointAt(offset);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    output.push(character);
    offset += character.length;
  }
  return output.join("");
}

/** Remove escape sequences and line/control characters from displayed values. */
export function safeTerminalText(input: string): string {
  return stripTerminalControls(input).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ");
}

function consumeCsi(input: string, start: number): number {
  for (let offset = start; offset < input.length; offset += 1) {
    const code = input.charCodeAt(offset);
    if (code >= 0x40 && code <= 0x7e) {
      return offset + 1;
    }
    // A nested escape starts a new sequence; let the outer scanner process it
    // rather than accidentally treating its final byte as this CSI's final.
    if (code === 0x1b || code === 0x9c) {
      return offset;
    }
  }
  return input.length;
}

function consumeStringControl(input: string, start: number): number {
  for (let offset = start; offset < input.length; offset += 1) {
    const code = input.charCodeAt(offset);
    if (code === 0x07 || code === 0x9c) {
      // BEL and C1 ST terminate OSC; accepting BEL for all string controls is
      // conservative and prevents control payloads from reaching egress.
      return offset + 1;
    }
    if (code === 0x1b && input.charCodeAt(offset + 1) === 0x5c) {
      // Seven-bit ST: ESC \\.
      return offset + 2;
    }
  }
  return input.length;
}
