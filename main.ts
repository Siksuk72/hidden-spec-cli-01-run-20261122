// mend — apply model-written patches to a tree of files.
// Node 22, standard library only. SPEC.md is the whole specification.
//
// A run is all-or-nothing: edits are applied to an in-memory tree first, and
// files are only written (or deleted) once every edit has succeeded. Any
// failure means nothing is written. A usage or parse error exits 2 with one
// line; a failed edit exits 1 listing every failed edit; success exits 0
// listing every changed path.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Brk = '\r\n' | '\n';

function stripTrailingWS(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A patch line, split at \n with one trailing \r removed; a trailing empty
 *  piece after a final \n is dropped. */
function splitPatch(text: string): string[] {
  const parts = text.split('\n');
  const lines = parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

/** A file's text, split at its own line breaks. */
interface Split {
  lines: string[];
  brk: Brk;
  eol: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { lines: [], brk: '\n', eol: false };
  const brk: Brk = (() => {
    const i = text.indexOf('\n');
    return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  })();
  const eol = text.endsWith(brk);
  const body = eol ? text.slice(0, -brk.length) : text;
  const lines = body === '' ? [] : body.split(brk);
  return { lines, brk, eol };
}

function joinFile(s: Split): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.brk) + (s.eol ? s.brk : '');
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 *  `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  const segs = p.split('/');
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Three-tier matching (SPEC section 5)
// ---------------------------------------------------------------------------

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return stripTrailingWS(line);
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** All positions where O occurs in lines at tier, in increasing order. */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const res: number[] = [];
  if (O.length === 0) return res;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j], tier) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier (0, then 1, then 2; 0 only under --strict) at which O occurs
 *  at or after `from`, and its positions. Null when O occurs nowhere. */
function findTier(
  lines: string[],
  O: string[],
  strict: boolean,
  from: number,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const all = occurrences(lines, O, t);
    const pos = all.filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

interface NLine {
  s: string;
  ctx: boolean;
  oIdx: number;
}

/** Re-indent one new line at tier 2: F is the leading whitespace of the
 *  file's first matched line, P that of O's first line. A non-blank new line
 *  starting with P has P replaced by F. */
function reindent(s: string, firstFileLine: string, O: string[]): string {
  if (s === '' || /^[ \t]+$/.test(s)) return s;
  const F = leadingWS(firstFileLine);
  const P = leadingWS(O[0]);
  if (P.length > 0) {
    if (s.startsWith(P)) return F + s.slice(P.length);
    return s;
  }
  return F + s;
}

/** Replace lines[pos .. pos+O.length) with N. Context lines of N are written
 *  as the file's own matched lines; other lines are re-indented at tier 2. */
function applyMatch(lines: string[], O: string[], N: NLine[], tier: number, pos: number): string[] {
  const out = lines.slice(0, pos);
  for (const n of N) {
    if (n.ctx) out.push(lines[pos + n.oIdx]);
    else if (tier === 2) out.push(reindent(n.s, lines[pos], O));
    else out.push(n.s);
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

// ---------------------------------------------------------------------------
// The tree: in-memory file states, snapshotted from disk on first touch
// ---------------------------------------------------------------------------

interface FileState {
  exists: boolean;
  text: string;
  unreadable: boolean;
}

class Tree {
  private cur = new Map<string, FileState>();
  private orig = new Map<string, FileState>();

  private touch(p: string): FileState {
    let st = this.cur.get(p);
    if (st) return st;
    if (existsSync(p)) {
      try {
        st = { exists: true, text: readFileSync(p, 'utf8'), unreadable: false };
      } catch {
        st = { exists: true, text: '', unreadable: true };
      }
    } else {
      st = { exists: false, text: '', unreadable: false };
    }
    this.cur.set(p, st);
    this.orig.set(p, st);
    return st;
  }

  get(p: string): FileState {
    return this.touch(p);
  }

  set(p: string, text: string | null): void {
    this.touch(p);
    this.cur.set(p, text === null ? { exists: false, text: '', unreadable: false } : { exists: true, text, unreadable: false });
  }

  /** Every path touched, with its state before the run and its state now. */
  entries(): Array<{ path: string; before: FileState; after: FileState }> {
    const res: Array<{ path: string; before: FileState; after: FileState }> = [];
    for (const [path, before] of this.orig) {
      res.push({ path, before, after: this.cur.get(path)! });
    }
    return res;
  }
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

interface BodyLine {
  /** ' ' context, '-' old, '+' new, '\' the "no newline" marker. */
  t: ' ' | '-' | '+' | '\\';
  s: string;
  /** The raw patch line was empty (a context line with empty text). */
  rawEmpty: boolean;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

type Edit =
  | { k: 'unified'; oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; isMove: boolean; hunks: Hunk[] }
  | { k: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { k: 'v4a-add'; path: string; lines: string[] }
  | { k: 'v4a-delete'; path: string }
  | { k: 'v4a-update'; path: string; moveTo: string | null; chunks: VChunk[] }
  | { k: 'json-create'; path: string; fileText: string }
  | { k: 'json-str-replace'; path: string; oldStr: string; newStr: string }
  | { k: 'json-insert'; path: string; insertLine: number; newStr: string };

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

function buildO(body: BodyLine[]): string[] {
  const O: string[] = [];
  for (const b of body) {
    if (b.t === ' ' || b.t === '-') O.push(b.s);
  }
  return O;
}

function buildN(body: BodyLine[]): NLine[] {
  const N: NLine[] = [];
  let oIdx = 0;
  for (const b of body) {
    if (b.t === ' ') {
      N.push({ s: b.s, ctx: true, oIdx });
      oIdx++;
    } else if (b.t === '-') {
      oIdx++;
    } else if (b.t === '+') {
      N.push({ s: b.s, ctx: false, oIdx: -1 });
    }
  }
  return N;
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLastCtxNew(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].t === ' ' || body[i].t === '+') {
      return i + 1 < body.length && body[i + 1].t === '\\';
    }
  }
  return false;
}

function isBodyLine(line: string): boolean {
  return line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\';
}

function toBodyLine(line: string): BodyLine {
  if (line === '') return { t: ' ', s: '', rawEmpty: true };
  const c = line[0];
  if (c === ' ' || c === '-' || c === '+') return { t: c as ' ' | '-' | '+', s: line.slice(1), rawEmpty: false };
  return { t: '\\', s: line.slice(1), rawEmpty: false };
}

// ---------------------------------------------------------------------------
// Unified diff (SPEC section 6)
// ---------------------------------------------------------------------------

function stripDiffPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path after `--- `/`+++ `: text up to the first tab, trimmed, with a
 *  leading a/ or b/ removed. '/dev/null' means no file. */
function headerPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  s = stripDiffPrefix(s);
  if (s === '/dev/null') return null;
  return s;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface UnifiedSection {
  hasPair: boolean;
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function sectionToEdit(sec: UnifiedSection): Edit | null {
  const old = sec.hasPair
    ? sec.oldPath
    : sec.renameFrom !== null
      ? sec.renameFrom
      : sec.gitOld;
  const nw = sec.hasPair
    ? sec.newPath
    : sec.renameTo !== null
      ? sec.renameTo
      : sec.gitNew;
  if (sec.isCreate || old === null) {
    if (nw === null) return null;
    return { k: 'unified', oldPath: null, newPath: nw, isCreate: true, isDelete: false, isMove: false, hunks: sec.hunks };
  }
  if (sec.isDelete || nw === null) {
    if (old === null) return null;
    return { k: 'unified', oldPath: old, newPath: null, isCreate: false, isDelete: true, isMove: false, hunks: sec.hunks };
  }
  if (old !== nw) {
    return { k: 'unified', oldPath: old, newPath: nw, isCreate: false, isDelete: false, isMove: true, hunks: sec.hunks };
  }
  return { k: 'unified', oldPath: old, newPath: nw, isCreate: false, isDelete: false, isMove: false, hunks: sec.hunks };
}

function newUnifiedSection(): UnifiedSection {
  return {
    hasPair: false,
    oldPath: null,
    newPath: null,
    renameFrom: null,
    renameTo: null,
    gitOld: null,
    gitNew: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  };
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let sec: UnifiedSection | null = null;
  let mode: 'between' | 'header' | 'body' | 'after' = 'between';
  let curHunk: Hunk | null = null;
  let body: BodyLine[] = [];

  function finishHunk(): void {
    if (curHunk) {
      while (body.length > 0 && body[body.length - 1].rawEmpty) body.pop();
      curHunk.body = body;
      sec!.hunks.push(curHunk);
      curHunk = null;
      body = [];
    }
  }

  function finishSection(): void {
    if (sec) {
      finishHunk();
      const e = sectionToEdit(sec);
      if (e) edits.push(e);
      sec = null;
    }
  }

  /** Start a section at a `diff --git a/<X> b/<Y>` line; throws when the line
   *  is not of that form. */
  function startAtDiffGit(line: string, lineNo: number): void {
    const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(stripTrailingWS(line));
    if (!m) throw new ParseError(lineNo);
    finishSection();
    sec = newUnifiedSection();
    sec.gitOld = m[1];
    sec.gitNew = m[2];
    mode = 'header';
  }

  /** Start a section at a `--- ` line followed by a `+++ ` line. */
  function startAtPair(i: number): void {
    finishSection();
    sec = newUnifiedSection();
    sec.hasPair = true;
    sec.oldPath = headerPath(lines[i]);
    sec.newPath = headerPath(lines[i + 1]);
    mode = 'header';
  }

  /** Start a hunk at an `@@` line; throws when it is not a hunk header. */
  function startHunk(line: string, lineNo: number): void {
    const m = HUNK_RE.exec(line);
    if (!m) throw new ParseError(lineNo);
    finishHunk();
    curHunk = { a: parseInt(m[1], 10), body: [] };
    mode = 'body';
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const next = i + 1 < lines.length ? lines[i + 1] : null;
    const pairAhead = line.startsWith('--- ') && next !== null && next.startsWith('+++ ');

    if (mode === 'between') {
      if (line.startsWith('diff --git ')) {
        startAtDiffGit(line, lineNo);
      } else if (pairAhead) {
        startAtPair(i);
        i++;
      } else if (line.startsWith('@@')) {
        throw new ParseError(lineNo);
      }
      // any other line is prose and is ignored
    } else if (mode === 'header') {
      if (line.startsWith('diff --git ')) {
        startAtDiffGit(line, lineNo);
      } else if (line.startsWith('--- ')) {
        if (!pairAhead) throw new ParseError(lineNo + 1);
        if (!sec!.hasPair) {
          sec!.hasPair = true;
          sec!.oldPath = headerPath(line);
          sec!.newPath = headerPath(next!);
        }
        i++;
      } else if (line.startsWith('rename from ')) {
        if (sec!.renameFrom === null) sec!.renameFrom = line.slice(12).trim();
      } else if (line.startsWith('rename to ')) {
        if (sec!.renameTo === null) sec!.renameTo = line.slice(10).trim();
      } else if (line.startsWith('new file mode')) {
        sec!.isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        sec!.isDelete = true;
      } else if (line.startsWith('@@')) {
        startHunk(line, lineNo);
      }
      // any other header line is ignored
    } else if (mode === 'body') {
      if (line.startsWith('diff --git ')) {
        startAtDiffGit(line, lineNo);
      } else if (pairAhead) {
        startAtPair(i);
        i++;
      } else if (line.startsWith('@@')) {
        startHunk(line, lineNo);
      } else if (isBodyLine(line)) {
        body.push(toBodyLine(line));
      } else {
        finishHunk();
        mode = 'after';
      }
    } else {
      // after: the body ended at a non-body line
      if (line.startsWith('diff --git ')) {
        startAtDiffGit(line, lineNo);
      } else if (pairAhead) {
        startAtPair(i);
        i++;
      } else if (line.startsWith('@@')) {
        startHunk(line, lineNo);
      }
      // any other line is prose and is ignored
    }
  }

  finishSection();
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE (SPEC section 7)
// ---------------------------------------------------------------------------

function parseSR(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (stripTrailingWS(lines[i]) === '<<<<<<< SEARCH') {
      const s = i;
      let path: string | null = null;
      for (let j = s - 1; j > prevEnd; j--) {
        const t = lines[j].trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new ParseError(s + 1);
      }
      let e = -1;
      for (let j = s + 1; j < lines.length; j++) {
        if (stripTrailingWS(lines[j]) === '=======') {
          e = j;
          break;
        }
      }
      let r = -1;
      if (e >= 0) {
        for (let j = e + 1; j < lines.length; j++) {
          if (stripTrailingWS(lines[j]) === '>>>>>>> REPLACE') {
            r = j;
            break;
          }
        }
      }
      if (e < 0 || r < 0) throw new ParseError(s + 1);
      edits.push({ k: 'sr', path, oldLines: lines.slice(s + 1, e), newLines: lines.slice(e + 1, r) });
      prevPath = path;
      prevEnd = r;
      i = r + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// V4A (SPEC section 8)
// ---------------------------------------------------------------------------

function parseV4A(lines: string[]): Edit[] {
  let f = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      f = i;
      break;
    }
  }
  if (f < 0) throw new ParseError(1);
  if (lines[f].trim() !== '*** Begin Patch') throw new ParseError(f + 1);
  let l = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      l = i;
      break;
    }
  }
  if (lines[l].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  const edits: Edit[] = [];
  // A section's raw lines, each with its 1-based patch line number.
  interface Raw {
    text: string;
    no: number;
  }
  let curKind: 'add' | 'delete' | 'update' | null = null;
  let curPath = '';
  let curHeaderNo = 0;
  let curRaw: Raw[] = [];

  function finishSection(): void {
    if (!curKind) return;
    // Blank lines at the end of the section are not part of it.
    while (curRaw.length > 0 && isBlank(curRaw[curRaw.length - 1].text)) curRaw.pop();
    if (curKind === 'add') {
      const fileLines: string[] = [];
      for (const r of curRaw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (isBlank(r.text)) fileLines.push('');
        else throw new ParseError(r.no);
      }
      edits.push({ k: 'v4a-add', path: curPath, lines: fileLines });
    } else if (curKind === 'delete') {
      edits.push({ k: 'v4a-delete', path: curPath });
    } else {
      let moveTo: string | null = null;
      let rest = curRaw;
      if (rest.length > 0 && rest[0].text.startsWith('*** Move to: ')) {
        moveTo = rest[0].text.slice(13).trim();
        rest = rest.slice(1);
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      let seenChunk = false;
      for (const r of rest) {
        const line = r.text;
        if (line.startsWith('@@')) {
          if (chunk) chunks.push(chunk);
          const anchor = line.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          seenChunk = true;
        } else if (line === '*** End of File') {
          if (!chunk) throw new ParseError(r.no);
          chunk.eof = true;
          chunks.push(chunk);
          chunk = null;
          seenChunk = true;
        } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
          if (!chunk) {
            if (seenChunk) throw new ParseError(r.no);
            chunk = { anchor: null, body: [], eof: false };
          }
          chunk.body.push(toBodyLine(line));
        } else {
          throw new ParseError(r.no);
        }
      }
      if (chunk) chunks.push(chunk);
      if (chunks.length === 0 && moveTo === null) throw new ParseError(curHeaderNo);
      edits.push({ k: 'v4a-update', path: curPath, moveTo, chunks });
    }
    curKind = null;
    curRaw = [];
  }

  let i = f + 1;
  while (i < l) {
    const line = lines[i];
    const no = i + 1;
    if (line.startsWith('*** Add File: ')) {
      finishSection();
      curKind = 'add';
      curPath = line.slice(14).trim();
      curHeaderNo = no;
      i++;
    } else if (line.startsWith('*** Delete File: ')) {
      finishSection();
      curKind = 'delete';
      curPath = line.slice(17).trim();
      curHeaderNo = no;
      i++;
    } else if (line.startsWith('*** Update File: ')) {
      finishSection();
      curKind = 'update';
      curPath = line.slice(17).trim();
      curHeaderNo = no;
      i++;
    } else if (curKind === null) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      throw new ParseError(no);
    } else if (curKind === 'add') {
      if (line.startsWith('+') || isBlank(line)) curRaw.push({ text: line, no });
      else throw new ParseError(no);
      i++;
    } else if (curKind === 'delete') {
      if (!isBlank(line)) throw new ParseError(no);
      i++;
    } else {
      curRaw.push({ text: line, no });
      i++;
    }
  }
  finishSection();
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// JSON (SPEC section 4)
// ---------------------------------------------------------------------------

function jsonEdit(obj: unknown, lineNo: number): Edit {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new ParseError(lineNo);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseError(lineNo);
  if (typeof o.command !== 'string') throw new ParseError(lineNo);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseError(lineNo);
    return { k: 'json-create', path: o.path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str.length === 0) throw new ParseError(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseError(lineNo);
    return { k: 'json-str-replace', path: o.path, oldStr: o.old_str, newStr: (o.new_str as string) ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseError(lineNo);
    if (typeof o.new_str !== 'string') throw new ParseError(lineNo);
    return { k: 'json-insert', path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  throw new ParseError(lineNo);
}

function parseJSON(patchText: string, lines: string[]): Edit[] {
  let f = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      f = i;
      break;
    }
  }
  if (f < 0) throw new ParseError(1);
  const firstNonWS = lines[f].replace(/^\s+/, '');
  if (firstNonWS.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseError(f + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(f + 1);
    if (arr.length === 0) throw new ParseError(1);
    const edits: Edit[] = [];
    for (const el of arr) edits.push(jsonEdit(el, f + 1));
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new ParseError(i + 1);
    }
    edits.push(jsonEdit(obj, i + 1));
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// Applying edits (SPEC sections 2, 4, 6, 7, 8)
// ---------------------------------------------------------------------------

interface Fail {
  code: string;
  path: string;
}

function creationEndsWithBreak(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h].body;
    for (let i = body.length - 1; i >= 0; i--) {
      if (body[i].t === '+') return !(i + 1 < body.length && body[i + 1].t === '\\');
    }
  }
  return true;
}

function applyHunks(st: Split, hunks: Hunk[], strict: boolean): Split | null {
  let lines = st.lines;
  let eol = st.eol;
  let d = 0;
  for (const h of hunks) {
    const O = buildO(h.body);
    const N = buildN(h.body);
    const noBreak = backslashAfterLastCtxNew(h.body);
    if (O.length === 0) {
      const idx = Math.min(h.a + d, lines.length);
      const touchesEnd = idx === lines.length;
      const ins = N.map((n) => n.s);
      lines = [...lines.slice(0, idx), ...ins, ...lines.slice(idx)];
      if (touchesEnd) eol = !noBreak;
      d += N.length;
    } else {
      const f = findTier(lines, O, strict, 0);
      if (!f) return null;
      const target = h.a - 1 + d;
      let pos = f.pos[0];
      let best = Math.abs(pos - target);
      for (const p of f.pos) {
        const dd = Math.abs(p - target);
        if (dd < best) {
          best = dd;
          pos = p;
        }
      }
      const touchesEnd = pos + O.length === lines.length;
      lines = applyMatch(lines, O, N, f.tier, pos);
      if (touchesEnd) eol = !noBreak;
      d += N.length - O.length;
    }
  }
  return { lines, brk: st.brk, eol };
}

function applyUnified(tree: Tree, edit: Extract<Edit, { k: 'unified' }>, strict: boolean): Fail | null {
  if (edit.isCreate) {
    const p = edit.newPath!;
    if (!isSafePath(p)) return { code: 'unsafe', path: p };
    if (tree.get(p).exists) return { code: 'exists', path: p };
    const plus: string[] = [];
    for (const h of edit.hunks) {
      for (const b of h.body) {
        if (b.t === '+') plus.push(b.s);
      }
    }
    const eol = creationEndsWithBreak(edit.hunks);
    const text = plus.length === 0 ? '' : plus.join('\n') + (eol ? '\n' : '');
    tree.set(p, text);
    return null;
  }
  if (edit.isDelete) {
    const p = edit.oldPath!;
    if (!isSafePath(p)) return { code: 'unsafe', path: p };
    const cur = tree.get(p);
    if (!cur.exists || cur.unreadable) return { code: 'missing', path: p };
    tree.set(p, null);
    return null;
  }
  const oldP = edit.oldPath!;
  const newP = edit.newPath!;
  if (!isSafePath(oldP)) return { code: 'unsafe', path: oldP };
  if (edit.isMove && !isSafePath(newP)) return { code: 'unsafe', path: newP };
  const cur = tree.get(oldP);
  if (!cur.exists || cur.unreadable) return { code: 'missing', path: oldP };
  if (edit.isMove && tree.get(newP).exists) return { code: 'exists', path: newP };
  const res = applyHunks(splitFile(cur.text), edit.hunks, strict);
  if (!res) return { code: 'no-match', path: oldP };
  const text = joinFile(res);
  if (edit.isMove) {
    tree.set(oldP, null);
    tree.set(newP, text);
  } else {
    tree.set(oldP, text);
  }
  return null;
}

function applySR(tree: Tree, edit: Extract<Edit, { k: 'sr' }>, strict: boolean): Fail | null {
  const p = edit.path;
  if (!isSafePath(p)) return { code: 'unsafe', path: p };
  if (edit.oldLines.length === 0) {
    // A block with empty old lines creates the file with the new lines.
    if (tree.get(p).exists) return { code: 'exists', path: p };
    const text = edit.newLines.length === 0 ? '' : edit.newLines.join('\n') + '\n';
    tree.set(p, text);
    return null;
  }
  const cur = tree.get(p);
  if (!cur.exists || cur.unreadable) return { code: 'missing', path: p };
  const st = splitFile(cur.text);
  const f = findTier(st.lines, edit.oldLines, strict, 0);
  if (!f) return { code: 'no-match', path: p };
  if (f.pos.length > 1) return { code: 'ambiguous', path: p };
  const N = edit.newLines.map((s) => ({ s, ctx: false, oIdx: -1 }));
  const lines = applyMatch(st.lines, edit.oldLines, N, f.tier, f.pos[0]);
  tree.set(p, joinFile({ lines, brk: st.brk, eol: st.eol }));
  return null;
}

function applyV4AAdd(tree: Tree, edit: Extract<Edit, { k: 'v4a-add' }>): Fail | null {
  const p = edit.path;
  if (!isSafePath(p)) return { code: 'unsafe', path: p };
  if (tree.get(p).exists) return { code: 'exists', path: p };
  const text = edit.lines.length === 0 ? '' : edit.lines.join('\n') + '\n';
  tree.set(p, text);
  return null;
}

function applyV4ADelete(tree: Tree, edit: Extract<Edit, { k: 'v4a-delete' }>): Fail | null {
  const p = edit.path;
  if (!isSafePath(p)) return { code: 'unsafe', path: p };
  const cur = tree.get(p);
  if (!cur.exists || cur.unreadable) return { code: 'missing', path: p };
  tree.set(p, null);
  return null;
}

function applyChunks(st: Split, chunks: VChunk[], strict: boolean): Split | null {
  let lines = st.lines;
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      let found: number | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const na = normLine(c.anchor, t);
        for (let i = cursor; i < lines.length; i++) {
          if (normLine(lines[i], t) === na) {
            found = i;
            break;
          }
        }
        if (found !== null) break;
      }
      if (found === null) return null;
      cursor = found + 1;
    }
    const O = buildO(c.body);
    const N = buildN(c.body);
    if (O.length === 0) {
      const idx = c.eof ? lines.length : cursor;
      const ins = N.map((n) => n.s);
      lines = [...lines.slice(0, idx), ...ins, ...lines.slice(idx)];
      cursor = idx + ins.length;
    } else {
      const f = findTier(lines, O, strict, cursor);
      if (!f) return null;
      let pos: number;
      if (c.eof) {
        const p = f.pos.find((pp) => pp + O.length === lines.length);
        if (p === undefined) return null;
        pos = p;
      } else {
        pos = f.pos[0];
      }
      lines = applyMatch(lines, O, N, f.tier, pos);
      cursor = pos + N.length;
    }
  }
  return { lines, brk: st.brk, eol: st.eol };
}

function applyV4AUpdate(tree: Tree, edit: Extract<Edit, { k: 'v4a-update' }>, strict: boolean): Fail | null {
  const p = edit.path;
  if (!isSafePath(p)) return { code: 'unsafe', path: p };
  if (edit.moveTo !== null && !isSafePath(edit.moveTo)) return { code: 'unsafe', path: edit.moveTo };
  const cur = tree.get(p);
  if (!cur.exists || cur.unreadable) return { code: 'missing', path: p };
  if (edit.moveTo !== null && tree.get(edit.moveTo).exists) return { code: 'exists', path: edit.moveTo };
  const res = applyChunks(splitFile(cur.text), edit.chunks, strict);
  if (!res) return { code: 'no-match', path: p };
  const text = joinFile(res);
  if (edit.moveTo !== null) {
    tree.set(p, null);
    tree.set(edit.moveTo, text);
  } else {
    tree.set(p, text);
  }
  return null;
}

function applyJSONCreate(tree: Tree, edit: Extract<Edit, { k: 'json-create' }>): Fail | null {
  const p = edit.path;
  if (!isSafePath(p)) return { code: 'unsafe', path: p };
  if (tree.get(p).exists) return { code: 'exists', path: p };
  tree.set(p, edit.fileText);
  return null;
}

function applyJSONStrReplace(tree: Tree, edit: Extract<Edit, { k: 'json-str-replace' }>): Fail | null {
  const p = edit.path;
  if (!isSafePath(p)) return { code: 'unsafe', path: p };
  const cur = tree.get(p);
  if (!cur.exists || cur.unreadable) return { code: 'missing', path: p };
  const isCRLF = splitFile(cur.text).brk === '\r\n';
  let text = cur.text;
  let oldS = edit.oldStr;
  let newS = edit.newStr;
  if (isCRLF) {
    text = text.replace(/\r\n/g, '\n');
    oldS = oldS.replace(/\r\n/g, '\n');
    newS = newS.replace(/\r\n/g, '\n');
  }
  let count = 0;
  let idx = -1;
  let from = 0;
  for (;;) {
    const j = text.indexOf(oldS, from);
    if (j < 0) break;
    count++;
    idx = j;
    from = j + 1;
  }
  if (count === 0) return { code: 'no-match', path: p };
  if (count > 1) return { code: 'ambiguous', path: p };
  let out = text.slice(0, idx) + newS + text.slice(idx + oldS.length);
  if (isCRLF) out = out.replace(/\n/g, '\r\n');
  tree.set(p, out);
  return null;
}

function applyJSONInsert(tree: Tree, edit: Extract<Edit, { k: 'json-insert' }>): Fail | null {
  const p = edit.path;
  if (!isSafePath(p)) return { code: 'unsafe', path: p };
  const cur = tree.get(p);
  if (!cur.exists || cur.unreadable) return { code: 'missing', path: p };
  const st = splitFile(cur.text);
  if (edit.insertLine < 0 || edit.insertLine > st.lines.length) return { code: 'no-match', path: p };
  const ins = edit.newStr === '' ? [] : splitPatch(edit.newStr);
  const lines = [...st.lines.slice(0, edit.insertLine), ...ins, ...st.lines.slice(edit.insertLine)];
  tree.set(p, joinFile({ lines, brk: st.brk, eol: st.eol }));
  return null;
}

function applyEdit(tree: Tree, edit: Edit, strict: boolean): Fail | null {
  switch (edit.k) {
    case 'unified':
      return applyUnified(tree, edit, strict);
    case 'sr':
      return applySR(tree, edit, strict);
    case 'v4a-add':
      return applyV4AAdd(tree, edit);
    case 'v4a-delete':
      return applyV4ADelete(tree, edit);
    case 'v4a-update':
      return applyV4AUpdate(tree, edit, strict);
    case 'json-create':
      return applyJSONCreate(tree, edit);
    case 'json-str-replace':
      return applyJSONStrReplace(tree, edit);
    case 'json-insert':
      return applyJSONInsert(tree, edit);
  }
}

// ---------------------------------------------------------------------------
// Output: the change lines, in UTF-8 byte order of the paths
// ---------------------------------------------------------------------------

function byteCmp(a: string, b: string): number {
  // UTF-8 byte order is code-point order, which is also UTF-16 code-unit
  // order for valid strings.
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function computeChanges(tree: Tree, moves: Array<{ old: string; nw: string }>): string[] {
  const kind = new Map<string, 'A' | 'D' | 'M'>();
  for (const { path, before, after } of tree.entries()) {
    if (!before.exists && after.exists) kind.set(path, 'A');
    else if (before.exists && !after.exists) kind.set(path, 'D');
    else if (before.exists && after.exists && before.text !== after.text) kind.set(path, 'M');
  }
  const lines: Array<{ key: string; line: string }> = [];
  const consumed = new Set<string>();
  for (const m of moves) {
    if (consumed.has(m.old) || consumed.has(m.nw)) continue;
    if (kind.get(m.old) === 'D' && kind.get(m.nw) === 'A') {
      lines.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      consumed.add(m.old);
      consumed.add(m.nw);
    }
  }
  for (const [path, k] of kind) {
    if (consumed.has(path)) continue;
    lines.push({ key: path, line: `${k} ${path}` });
  }
  lines.sort((x, y) => byteCmp(x.key, y.key));
  return lines.map((l) => l.line);
}

function writeTree(tree: Tree): void {
  for (const { path, before, after } of tree.entries()) {
    if (!before.exists && after.exists) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, after.text, 'utf8');
    } else if (before.exists && !after.exists) {
      rmSync(path, { force: true });
    } else if (before.exists && after.exists && before.text !== after.text) {
      writeFileSync(path, after.text, 'utf8');
    }
  }
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 9) and the command line (SPEC section 1)
// ---------------------------------------------------------------------------

type Format = 'unified' | 'search_replace' | 'v4a' | 'json';

/** SPEC section 4, in order: the first non-blank line is `*** Begin Patch`;
 *  the first non-whitespace character of the first non-blank line is `[` or
 *  `{`; some line is `<<<<<<< SEARCH`; some line starts with `diff --git ` or
 *  a `--- ` line followed by a `+++ ` line. Otherwise no format. */
function detectFormat(lines: string[]): Format | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const firstNonWS = lines[first].replace(/^\s+/, '');
  if (firstNonWS.startsWith('[') || firstNonWS.startsWith('{')) return 'json';
  for (const line of lines) {
    if (stripTrailingWS(line) === '<<<<<<< SEARCH') return 'search_replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

interface RunResult {
  exit: number;
  out: string;
}

function runCli(argv: string[]): RunResult {
  let strict = false;
  let checkOnly = false;
  let format: Format | 'auto' | null = null;
  let patchArg: string | null = null;
  let seenStrict = false;
  let seenCheck = false;
  let seenFormat = false;
  let afterDash = false;

  for (const a of argv) {
    if (afterDash) {
      if (patchArg === null) patchArg = a;
      else return { exit: 2, out: 'error: usage\n' };
      continue;
    }
    if (a === '--') {
      afterDash = true;
      continue;
    }
    if (a === '-') {
      if (patchArg === null) patchArg = a;
      else return { exit: 2, out: 'error: usage\n' };
      continue;
    }
    if (a.startsWith('-')) {
      if (a === '--strict') {
        if (seenStrict) return { exit: 2, out: 'error: usage\n' };
        seenStrict = true;
        strict = true;
      } else if (a === '--check') {
        if (seenCheck) return { exit: 2, out: 'error: usage\n' };
        seenCheck = true;
        checkOnly = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return { exit: 2, out: 'error: usage\n' };
        const v = a.slice('--format='.length);
        if (v !== 'auto' && v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json') {
          return { exit: 2, out: 'error: usage\n' };
        }
        seenFormat = true;
        format = v === 'search-replace' ? 'search_replace' : (v as Format | 'auto');
      } else {
        return { exit: 2, out: 'error: usage\n' };
      }
      continue;
    }
    if (patchArg === null) patchArg = a;
    else return { exit: 2, out: 'error: usage\n' };
  }

  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    if (process.stdin.isTTY) return { exit: 2, out: 'error: no-patch\n' };
    try {
      patchText = readFileSync(0, 'utf8');
    } catch {
      return { exit: 2, out: 'error: no-patch\n' };
    }
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return { exit: 2, out: 'error: no-patch\n' };
    }
  }

  const lines = splitPatch(patchText);
  let fmt: Format;
  if (format === null || format === 'auto') {
    const detected = detectFormat(lines);
    if (!detected) return { exit: 2, out: 'error: format\n' };
    fmt = detected;
  } else {
    fmt = format;
  }

  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search_replace') edits = parseSR(lines);
    else if (fmt === 'v4a') edits = parseV4A(lines);
    else edits = parseJSON(patchText, lines);
  } catch (e) {
    if (e instanceof ParseError) return { exit: 2, out: `error: parse ${e.line}\n` };
    throw e;
  }

  const tree = new Tree();
  const failures: Fail[] = [];
  const moves: Array<{ old: string; nw: string }> = [];
  for (const edit of edits) {
    const fail = applyEdit(tree, edit, strict);
    if (fail) {
      failures.push(fail);
    } else if (edit.k === 'unified' && edit.isMove) {
      moves.push({ old: edit.oldPath!, nw: edit.newPath! });
    } else if (edit.k === 'v4a-update' && edit.moveTo !== null) {
      moves.push({ old: edit.path, nw: edit.moveTo });
    }
  }

  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`).join('\n') + `\nfailed: ${failures.length} of ${edits.length} edits\n`;
    return { exit: 1, out };
  }

  const changes = computeChanges(tree, moves);
  if (!checkOnly) writeTree(tree);
  const n = changes.length;
  const out = n > 0 ? changes.join('\n') + `\nok: ${n} ${n === 1 ? 'file' : 'files'}\n` : 'ok: 0 files\n';
  return { exit: 0, out };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  const result = runCli(process.argv.slice(2));
  process.stdout.write(result.out);
  process.exitCode = result.exit;
}
