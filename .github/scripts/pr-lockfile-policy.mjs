import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const candidateLockfile = Object.freeze({
  repository: 'iiwish/verrail',
  branch: 'codex/g2-7-candidate-v1-20260927',
  pullRequest: 14,
  sha256: 'c7270e3fecbcfcb7a0e9f32eaca67569c4fa81b3643d122fbaee5473e81de2f7',
});

const digest = (content) => createHash('sha256').update(content).digest('hex');

export function enforceLockfilePolicy({ repository, pullRequest, changedPaths, headSha256, checkoutSha256 }) {
  if (!changedPaths.includes('pnpm-lock.yaml')) return { pinned: false };
  const approvedCandidate = repository === candidateLockfile.repository &&
    pullRequest.number === candidateLockfile.pullRequest &&
    pullRequest.base?.repo?.full_name === candidateLockfile.repository &&
    pullRequest.head?.repo?.full_name === candidateLockfile.repository &&
    pullRequest.head?.ref === candidateLockfile.branch;
  if (approvedCandidate) {
    // Bind both the proposed blob and the merge checkout consumed by CI.
    if (headSha256 !== candidateLockfile.sha256 || checkoutSha256 !== candidateLockfile.sha256) {
      throw new Error('Candidate lockfile differs from the explicitly approved SHA-256.');
    }
    return { pinned: true };
  }
  if (pullRequest.head?.ref === 'chore/refresh-lockfile' || pullRequest.user?.login === 'dependabot[bot]') {
    return { pinned: false };
  }
  throw new Error('Do not commit pnpm-lock.yaml in pull requests. CI owns lockfile updates.');
}

export function checkCheckout(env = process.env, cwd = process.cwd()) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  if (!pr || !/^[a-f0-9]{40}$/.test(pr.base?.sha ?? '') || !/^[a-f0-9]{40}$/.test(pr.head?.sha ?? '')) {
    throw new Error('Expected a pull request event with full Git commit identities.');
  }
  const git = (...args) => execFileSync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  const changedPaths = git('diff', '--name-only', `${pr.base.sha}...${pr.head.sha}`).toString('utf8').trim().split('\n');
  const changed = changedPaths.includes('pnpm-lock.yaml');
  return enforceLockfilePolicy({
    repository: env.GITHUB_REPOSITORY,
    pullRequest: pr,
    changedPaths,
    headSha256: changed ? digest(git('show', `${pr.head.sha}:pnpm-lock.yaml`)) : undefined,
    checkoutSha256: changed ? digest(readFileSync(`${cwd}/pnpm-lock.yaml`)) : undefined,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = checkCheckout();
    if (process.argv.includes('--verify-pinned') && !result.pinned) {
      throw new Error('Expected the approved candidate lockfile to remain pinned.');
    }
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pinned=${result.pinned}\n`);
    console.log(result.pinned ? 'Candidate lockfile matches the approved SHA-256; dependency resolution stays frozen.' : 'Standard lockfile policy passed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
