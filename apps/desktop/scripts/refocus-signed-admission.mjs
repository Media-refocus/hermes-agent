// refocus-signed-admission.mjs — fail-closed admission for the SIGNED
// Hermes Refocus canary lane. The signed workflow exposes the PFX signing
// secret to the build job, so the admitted build source must be provably a
// commit of THIS repository's `refocus/mis-perfiles` branch — never an
// arbitrary SHA, never a PR-fork commit. Pure Node + the git CLI: runs
// identically in CI and locally.
//
// Checks, in order (any failure exits 1):
//   1. the argument is a full 40-character lowercase hex SHA
//   2. the branch ref exists in this checkout (fetched by the workflow's
//      full-depth checkout of the same fork)
//   3. the SHA is an ANCESTOR of the branch tip (merge-base) — i.e. it is
//      real committed history of that branch, not a dangling object
//   4. HEAD (what was actually checked out) IS the SHA
//
// Usage: node refocus-signed-admission.mjs <full-40-char-sha> [branch-ref] [repoRoot]
// Defaults: branch-ref = origin/refocus/mis-perfiles, repoRoot = cwd.

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The branch the signed lane builds. In CI the fork checkout exposes it as
// origin/refocus/mis-perfiles (the workflow passes that explicitly); the
// default here is the plain local branch name so the same admission runs in
// a developer worktree.
export const DEFAULT_BRANCH = 'refocus/mis-perfiles'
const SHA_RE = /^[0-9a-f]{40}$/

/** @param {string} sha @returns {string | null} the normalized SHA or null */
export function validateSha(sha) {
  const value = String(sha ?? '').trim()
  return SHA_RE.test(value) ? value : null
}

/** @param {string} output raw `git rev-parse` stdout @returns {string | null} */
export function parseBranchTip(output) {
  const value = String(output ?? '').trim()
  return SHA_RE.test(value) ? value : null
}

/**
 * The pure admission decision — everything the git wrapper gathers, decided
 * in one place so tests can pin every rejection reason.
 * @param {{ sha: string, branch: string, branchTip: string | null, contained: boolean | null, head: string | null }} state
 * @returns {{ ok: boolean, reason: string }}
 */
export function admissionDecision({ sha, branch, branchTip, contained, head }) {
  if (!validateSha(sha)) return { ok: false, reason: `ref must be the full 40-character commit SHA (got: '${sha}')` }
  if (!branchTip) return { ok: false, reason: `branch ${branch} not found in this checkout; the signed lane only builds ${DEFAULT_BRANCH} of this fork` }
  if (contained === null) return { ok: false, reason: `could not enumerate ${branch} history to prove ${sha} is on the branch` }
  if (!contained) return { ok: false, reason: `${sha} is NOT committed history of ${branch} (${branchTip}); the signed lane never fetches or trusts an arbitrary SHA, and only that branch's commits may receive the signing secret` }
  if (!head) return { ok: false, reason: 'could not resolve HEAD of the checkout' }
  if (head !== sha) return { ok: false, reason: `checkout HEAD resolved to ${head}, not the admitted ${sha}` }
  return { ok: true, reason: `${sha} is committed history of ${branch} and HEAD matches` }
}

/**
 * @param {string} repoRoot
 * @param {string[]} args
 * @returns {string} stdout
 */
function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

/**
 * Collect the git facts for one admission. Membership is decided by walking
 * the BRANCH's history locally (`rev-list <branch>`) and string-comparing —
 * never by handing the untrusted SHA to a git object lookup, which in a
 * partial clone triggers a lazy fetch of that object from the promisor
 * remote (seconds of network per probe; the signed lane must not "reach
 * out" for an arbitrary SHA at all). If the SHA is on the branch it is
 * necessarily an existing local commit; if not, it stays unexamined.
 * @param {string} sha
 * @param {string} branch
 * @param {string} repoRoot
 * @returns {{ branchTip: string | null, contained: boolean | null, head: string | null }}
 */
export function collectGitFacts(sha, branch, repoRoot) {
  let branchTip = null
  try {
    branchTip = parseBranchTip(git(repoRoot, ['rev-parse', '--verify', `${branch}^{commit}`]))
  } catch { branchTip = null }
  let contained = null
  if (branchTip) {
    try {
      const commits = git(repoRoot, ['rev-list', branchTip])
      contained = commits.split('\n').includes(sha)
    } catch { contained = null }
  }
  let head = null
  try {
    head = parseBranchTip(git(repoRoot, ['rev-parse', 'HEAD']))
  } catch { head = null }
  return { branchTip, contained, head }
}

export default function main() {
  const [shaArg, branchArg, rootArg] = process.argv.slice(2)
  const sha = validateSha(shaArg)
  const branch = branchArg || DEFAULT_BRANCH
  const repoRoot = rootArg ? path.resolve(rootArg) : process.cwd()
  if (!sha) {
    console.error(`[refocus-signed-admission] FAIL: ref must be the full 40-character commit SHA (got: '${shaArg}')`)
    process.exit(1)
  }
  const verdict = admissionDecision({ sha, branch, ...collectGitFacts(sha, branch, repoRoot) })
  if (!verdict.ok) {
    console.error(`[refocus-signed-admission] FAIL: ${verdict.reason}`)
    process.exit(1)
  }
  console.log(`[refocus-signed-admission] OK: ${verdict.reason}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
