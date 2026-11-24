# mend — apply model-written patches to a tree of files

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Siksuk72/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Siksuk72/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is one command-line tool that applies the edits AI models write, in four formats, to a tree of
files. `SPEC.md` is the whole specification. It is built for make.fun's "Build mend" bounty.

## Usage

    node main.ts [options] [PATCH]

`PATCH` is the patch file, or `-` (or nothing) to read the patch from standard input. Options:

- `--format=auto|unified|search_replace|v4a|json` (default `auto`: detect the format)
- `--strict` — match lines at tier 0 (exact) only, no whitespace forgiveness
- `--check` — report what would change, without writing anything

## The formats

- **unified** — unified diffs (`diff --git`, `---`/`+++`, `@@` hunks), including creates, deletes,
  renames and `R`-style moves.
- **search_replace** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks, one per edit.
- **v4a** — `*** Begin Patch` / `*** End Patch` patches with `*** Add File:`, `*** Delete File:` and
  `*** Update File:` sections, `@@` anchors and `*** End of File` chunks.
- **json** — a JSON array of edit objects, or one edit object per line (`create`, `str_replace`,
  `insert`).

## The guarantees

- **Atomicity.** If any edit fails, no file is written at all; the run exits 1 listing every
  failed edit. A usage or parse error exits 2 with a single line and changes nothing.
- **Three-tier matching.** Lines match exactly, then with trailing whitespace stripped, then with
  leading and trailing whitespace stripped — so drifted indentation and wrong line numbers still
  land, and a new line is re-indented to match the file it lands in.
- **Safe paths.** An edit naming an absolute path, a path that escapes the tree (`..`), or an
  empty segment is refused.
- **CRLF and no-final-newline files.** Line endings and the final line break are preserved exactly
  as the file had them.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`.
  Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on
  each one in a fresh directory, and posts what main.ts did (its exit code, its stdout and the files
  left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit
code, everything written to stdout and every file afterwards are exactly what SPEC.md says. stderr is never compared,
so write what you like there. Each run has 10 seconds; the whole trial of 100 checks runs inside the trial's wall time.
