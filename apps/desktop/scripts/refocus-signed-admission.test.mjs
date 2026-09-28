// refocus-signed-admission.test.mjs — the anti-PR / anti-arbitrary-SHA
// admission for the SIGNED lane, exercised against the REAL worktree git
// repo (read-only). The unit matrix runs on the pure decision; the
// integration tests run the actual CLI against real refs in this checkout.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_BRANCH, admissionDecision, collectGitFacts, default as runCli, parseBranchTip, validateSha } from './refocus-signed-admission.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('validateSha / parseBranchTip', () => {
  it('admits only full lowercase 40-char SHAs', () => {
    expect(validateSha('a'.repeat(40))).toBe('a'.repeat(40))
    expect(validateSha('A'.repeat(40))).toBeNull() // uppercase rejected
    expect(validateSha('abc123')).toBeNull()
    expect(validateSha('')).toBeNull()
    expect(validateSha(undefined)).toBeNull()
    expect(validateSha(`${'a'.repeat(39)}g`)).toBeNull()
  })
  it('parses only real SHAs out of git output', () => {
    expect(parseBranchTip(`${'0'.repeat(40)}\n`)).toBe('0'.repeat(40))
    expect(parseBranchTip('fatal: not a commit')).toBeNull()
    expect(parseBranchTip('')).toBeNull()
  })
})

describe('admissionDecision — every rejection reason', () => {
  const sha = '1'.repeat(40)
  const tip = '2'.repeat(40)
  const branch = 'origin/refocus/mis-perfiles'

  it('accepts a SHA contained in the branch history with HEAD equal to the SHA', () => {
    const verdict = admissionDecision({ sha, branch, branchTip: tip, contained: true, head: sha })
    expect(verdict.ok).toBe(true)
  })
  it('rejects malformed SHAs', () => {
    expect(admissionDecision({ sha: 'nope', branch, branchTip: tip, contained: true, head: sha }).ok).toBe(false)
  })
  it('rejects a missing branch (never builds anything else)', () => {
    const verdict = admissionDecision({ sha, branch, branchTip: null, contained: null, head: sha })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/not found in this checkout/)
  })
  it('rejects a SHA that is NOT in the branch history (arbitrary SHA / PR head) — without ever probing the object', () => {
    const verdict = admissionDecision({ sha, branch, branchTip: tip, contained: false, head: sha })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/NOT committed history/)
    expect(verdict.reason).toMatch(/never fetches or trusts/)
  })
  it('rejects an undecidable history enumeration (fail closed, not fail open)', () => {
    expect(admissionDecision({ sha, branch, branchTip: tip, contained: null, head: sha }).ok).toBe(false)
  })
  it('rejects when the checked-out HEAD differs from the admitted SHA', () => {
    const verdict = admissionDecision({ sha, branch, branchTip: tip, contained: true, head: '3'.repeat(40) })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/not the admitted/)
  })
  it('rejects an unresolvable HEAD', () => {
    expect(admissionDecision({ sha, branch, branchTip: tip, contained: true, head: null }).ok).toBe(false)
  })
})

describe('collectGitFacts + CLI against the real worktree', () => {
  it('resolves the branch ref in this checkout and finds HEAD in its history', () => {
    const tip = execFileSync('git', ['rev-parse', '--verify', `${DEFAULT_BRANCH}^{commit}`], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    const facts = collectGitFacts(tip, DEFAULT_BRANCH, REPO_ROOT)
    expect(facts.branchTip).toBe(tip)
    expect(facts.contained).toBe(true) // tip is in its own history
    expect(facts.head).not.toBeNull()
  })

  it('CLI admits the real branch tip when HEAD is that tip', () => {
    const tip = execFileSync('git', ['rev-parse', DEFAULT_BRANCH], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    const out = execFileSync(
      process.execPath,
      [path.join(path.dirname(fileURLToPath(import.meta.url)), 'refocus-signed-admission.mjs'), tip, DEFAULT_BRANCH, REPO_ROOT],
      { encoding: 'utf8' }
    )
    expect(out).toMatch(/OK/)
  })

  it('CLI refuses a 40-char SHA that is not on the branch (simulated arbitrary SHA), fast and offline', () => {
    // A well-formed SHA that is not in the branch history. Membership is
    // decided by enumerating the BRANCH history (pure local), so this is
    // fast and never lazily fetches the unknown object from the promisor
    // remote (partial-clone trap — the old merge-base probe took minutes).
    const bogus = 'f'.repeat(40)
    let threw = null
    try {
      execFileSync(
        process.execPath,
        [path.join(path.dirname(fileURLToPath(import.meta.url)), 'refocus-signed-admission.mjs'), bogus, DEFAULT_BRANCH, REPO_ROOT],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (error) {
      threw = error
    }
    expect(threw).not.toBeNull()
    expect(String(/** @type {any} */ (threw).stderr)).toMatch(/NOT committed history/)
  })

  it('CLI refuses a short ref', () => {
    let threw = null
    try {
      execFileSync(
        process.execPath,
        [path.join(path.dirname(fileURLToPath(import.meta.url)), 'refocus-signed-admission.mjs'), 'abc123', DEFAULT_BRANCH, REPO_ROOT],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (error) {
      threw = error
    }
    expect(threw).not.toBeNull()
    expect(String(/** @type {any} */ (threw).stderr)).toMatch(/40-character/)
  })
})

// Importing the default export must NOT have run main() — the module is
// dual-use (library + CLI) and the CLI guard keys on argv[1].
runCli // referenced so the import is not flagged unused; main() runs only as a script
