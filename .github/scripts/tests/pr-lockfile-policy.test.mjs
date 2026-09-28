import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateLockfile, checkCheckout, enforceLockfilePolicy } from '../pr-lockfile-policy.mjs';

const candidate = () => ({
  repository: candidateLockfile.repository,
  pullRequest: {
    number: 14,
    base: { repo: { full_name: candidateLockfile.repository } },
    head: { ref: candidateLockfile.branch, repo: { full_name: candidateLockfile.repository } },
    user: { login: 'iiwish' },
  },
  changedPaths: ['pnpm-lock.yaml', 'package.json'],
  headSha256: candidateLockfile.sha256,
  checkoutSha256: candidateLockfile.sha256,
});

test('accepts only the approved candidate lockfile without regenerating it', () => {
  assert.deepEqual(enforceLockfilePolicy(candidate()), { pinned: true });
});

for (const [name, mutate] of [
  ['workflow repository', value => { value.repository = 'someone/verrail'; }],
  ['head repository', value => { value.pullRequest.head.repo.full_name = 'someone/verrail'; }],
  ['base repository', value => { value.pullRequest.base.repo.full_name = 'someone/verrail'; }],
  ['branch', value => { value.pullRequest.head.ref += '-copy'; }],
  ['pull request', value => { value.pullRequest.number = 15; }],
  ['head blob', value => { value.headSha256 = 'a'.repeat(64); }],
  ['merge checkout blob', value => { value.checkoutSha256 = 'a'.repeat(64); }],
]) {
  test(`rejects a different ${name}`, () => {
    const value = candidate();
    mutate(value);
    assert.throws(() => enforceLockfilePolicy(value));
  });
}

test('does not require blobs when the lockfile is unchanged', () => {
  const value = candidate();
  value.changedPaths = ['package.json'];
  value.headSha256 = value.checkoutSha256 = undefined;
  assert.deepEqual(enforceLockfilePolicy(value), { pinned: false });
});

test('retains the existing refresh branch and Dependabot policy', () => {
  for (const [ref, login] of [['chore/refresh-lockfile', 'github-actions[bot]'], ['dependabot/pnpm/foo', 'dependabot[bot]']]) {
    const value = candidate();
    value.pullRequest.head.ref = ref;
    value.pullRequest.user.login = login;
    assert.deepEqual(enforceLockfilePolicy(value), { pinned: false });
  }
});

test('a candidate hash mismatch is not exempted by the bot author', () => {
  const value = candidate();
  value.pullRequest.user.login = 'dependabot[bot]';
  value.headSha256 = 'a'.repeat(64);
  assert.throws(() => enforceLockfilePolicy(value), /approved SHA-256/);
});

test('validates Git event identities and rejects unapproved committed content', () => {
  const directory = mkdtempSync(join(tmpdir(), 'verrail-lock-policy-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
    git('init', '-q', '--template=');
    const commit = () => {
      git('add', 'pnpm-lock.yaml');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
      return git('rev-parse', 'HEAD');
    };
    writeFileSync(join(directory, 'pnpm-lock.yaml'), 'base');
    const base = commit();
    writeFileSync(join(directory, 'pnpm-lock.yaml'), 'unapproved head');
    const head = commit();
    const { pullRequest } = candidate();
    pullRequest.base.sha = base;
    pullRequest.head.sha = head;
    const eventPath = join(directory, 'event.json');
    const env = { GITHUB_REPOSITORY: candidateLockfile.repository, GITHUB_EVENT_PATH: eventPath };
    writeFileSync(eventPath, JSON.stringify({ pull_request: pullRequest }));
    assert.throws(() => checkCheckout(env, directory), /approved SHA-256/);
    writeFileSync(join(directory, 'pnpm-lock.yaml'), 'merge changed the lock');
    assert.throws(() => checkCheckout(env, directory), /approved SHA-256/);
    const changedHead = commit();
    pullRequest.head.sha = changedHead;
    writeFileSync(eventPath, JSON.stringify({ pull_request: pullRequest }));
    writeFileSync(join(directory, 'pnpm-lock.yaml'), 'base');
    assert.throws(() => checkCheckout(env, directory), /approved SHA-256/);
    pullRequest.head.sha = '--help';
    writeFileSync(eventPath, JSON.stringify({ pull_request: pullRequest }));
    assert.throws(() => checkCheckout(env, directory), /full Git commit identities/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PR workflow keeps candidate resolution frozen and all downstream gates enabled', () => {
  const workflow = readFileSync(new URL('../../workflows/pr.yml', import.meta.url), 'utf8');
  assert.match(workflow, /id: lock_policy\n\s+run: node \.github\/scripts\/pr-lockfile-policy\.mjs/);
  assert.match(workflow, /CANDIDATE_LOCKFILE_PINNED: \$\{\{ steps\.lock_policy\.outputs\.pinned \}\}/);
  assert.match(workflow, /if \[ "\$CANDIDATE_LOCKFILE_PINNED" = 'true' \]; then\n\s+pnpm install --lockfile-only --ignore-scripts --frozen-lockfile\n\s+node \.github\/scripts\/pr-lockfile-policy\.mjs --verify-pinned\n\s+echo "regenerated=0"/);
  assert.match(workflow, /elif printf[^\n]+\n\s+pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile/);
  for (const job of ['typecheck_release_registry', 'general_tests', 'build']) {
    assert.ok(workflow.includes(`  ${job}:`));
  }
});
