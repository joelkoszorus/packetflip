#!/usr/bin/env node
/**
 * Dependency-free secret scanner.
 *   node scripts/check-secrets.mjs          -> scans files staged for commit (pre-commit hook)
 *   node scripts/check-secrets.mjs --all    -> scans every tracked file (CI)
 * Exits 1 if anything that looks like a secret is found.
 * To allow a known-safe line, append the comment:  secret-scan:allow
 */
import { execFileSync } from 'node:child_process';

const all = process.argv.includes('--all');

// Patterns are assembled from fragments so this file does not flag itself.
const B = '-----' + 'BEGIN';
const PATTERNS = [
  ['Private key block', new RegExp(B + ' ([A-Z ]+ )?PRIVATE KEY' + '-----')],
  ['AWS access key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['Anthropic API key', new RegExp('\\bsk-' + 'ant-[A-Za-z0-9_-]{20,}')],
  ['OpenAI-style API key', /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/],
  ['Stripe live key', /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['npm auth token in config', /_authToken\s*=\s*\S+/],
  [
    'Hard-coded credential assignment',
    /\b(api[_-]?key|secret|passwd|password|token|client[_-]?secret)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
  ],
];

const BLOCKED_FILES = [
  /(^|\/)\.env(\.|$)/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)service-account[^/]*\.json$/i,
  // Personal editor settings (also in .gitignore)
  /(^|\/)\.vscode\//,
  /(^|\/)\.(netrc|git-credentials)$/,
  /(^|\/)\.?secrets\//,
  /(^|\/)\.(vercel|netlify|wrangler|firebase)\//,
];
const SKIP_FILES = [/^package-lock\.json$/, /\.(png|jpe?g|gif|webp|ico|glb|gltf|woff2?|ttf|mp3|ogg|wav)$/i];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const files = (
  all ? git(['ls-files']) : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
)
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean);

const findings = [];

// Anything matching an ignore rule (.gitignore or the local .git/info/exclude)
// must have been force-added with `git add -f`: block it.
if (!all && files.length > 0) {
  let ignored;
  try {
    ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { input: files.join('\n'), encoding: 'utf8' });
  } catch (err) {
    ignored = err.status === 1 ? '' : String(err.stdout ?? ''); // status 1 = nothing matched
  }
  for (const f of ignored.split('\n').map((x) => x.trim()).filter(Boolean)) {
    findings.push(`${f}: matches an ignore rule (force-added?)`);
  }
}

for (const file of files) {
  if (BLOCKED_FILES.some((re) => re.test(file)) && !file.endsWith('.example')) {
    findings.push(`${file}: file type should never be committed`);
    continue;
  }
  if (SKIP_FILES.some((re) => re.test(file))) continue;
  let content;
  try {
    content = all ? git(['show', `HEAD:${file}`]) : git(['show', `:${file}`]);
  } catch {
    continue; // e.g. new file in --all mode before first commit
  }
  if (content.includes('\u0000')) continue; // binary
  content.split('\n').forEach((line, i) => {
    if (line.includes('secret-scan:allow')) return;
    for (const [name, re] of PATTERNS) {
      if (re.test(line)) findings.push(`${file}:${i + 1}: possible ${name}`);
    }
  });
}

if (findings.length > 0) {
  console.error('\nSecret scan FAILED. Remove these before committing:\n');
  for (const f of findings) console.error('  - ' + f);
  console.error('\nIf a line is a false positive, append the comment "secret-scan:allow".\n');
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} file${files.length === 1 ? '' : 's'} checked).`);
