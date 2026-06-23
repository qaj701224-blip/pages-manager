import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { redactSecretLikeText } from './text.js';

const DEFAULT_REPO_ROOT = path.resolve(process.cwd());
const MAX_FILE_BYTES = 180_000;
const MAX_EVIDENCE_FILES = 5;
const MAX_REPO_FILES = 1_500;
const MAX_SEARCH_BYTES = 12_000_000;
const MAX_EVIDENCE_EXCERPTS = 2;

const BLOCKED_PATH_RE = new RegExp(
  [
    '(^|/)(?:\\.git|node_modules|\\.wrangler|coverage|dist|build|\\.next|\\.turbo|\\.cache)(?:/|$)',
    '(^|/)\\.env(?:\\.|$)',
    '(?:^|/)(?:id_rsa|known_hosts|wrangler\\.toml)$',
    '(?:secret|token|cookie|private[-_]?key)',
  ].join('|'),
  'i'
);
const SAFE_TEXT_EXTENSION_RE = /\.(?:cjs|css|html|js|json|jsx|md|mjs|sh|sql|ts|tsx|txt|yaml|yml)$/i;
const SAFE_BASENAME_RE =
  /^(?:AGENTS\.md|API\.md|CLAUDE\.md|Dockerfile(?:\.[A-Za-z0-9_-]+)?|README\.md|package\.json|pnpm-workspace\.yaml)$/;

const TOPIC_FILES = [
  {
    topic: 'slack-session',
    patterns: [/session|sessions|会话|对话|保存|存储|memory|active/i],
    files: [
      'apps/gateway/src/db/schema.js',
      'apps/gateway/src/db/repositories/slack-sessions.js',
      'apps/gateway/src/db/rows/slack-row.js',
      'apps/gateway/src/slack/session.js',
      'apps/gateway/src/slack/job-binding.js',
      'apps/gateway/src/slack/followup.js',
      'docs/architecture/slack-platform-runtime.md',
    ],
  },
  {
    topic: 'repo-question',
    patterns: [/repo|代码|实现|架构|answer_repo_question|只读|检索/i],
    files: [
      'apps/gateway/src/slack/repo-question.js',
      'apps/slack-agent/src/analysis.js',
      'docs/architecture/slack-agent-runtime.md',
      'docs/architecture/slack-platform-runtime.md',
    ],
  },
  {
    topic: 'workflow',
    patterns: [/workflow|actions|CI|CD|构建|测试|部署/i],
    files: [
      '.github/workflows/ci.yml',
      '.github/workflows/pages-agent.yml',
      '.github/workflows/platform-agent.yml',
      'docs/architecture/github-automation.md',
    ],
  },
  {
    topic: 'platform-dev',
    patterns: [/platform|平台|issue|PR|自动开发|状态机|gate/i],
    files: [
      'apps/gateway/src/db/schema.js',
      'apps/gateway/src/db/repositories/platform-dev.js',
      'apps/gateway/src/platform-dev/automation.js',
      'docs/architecture/platform-dev-lane.md',
    ],
  },
];

function sanitizeQuestion(question = '') {
  return redactSecretLikeText(String(question || '').replaceAll(/\s+/g, ' ').trim()).slice(0, 240);
}

function repoRootFromEnv(env = {}) {
  return path.resolve(env.PAGES_REPO_ROOT || env.REPO_ROOT || DEFAULT_REPO_ROOT);
}

function isSafeRelativePath(filePath = '') {
  const normalized = String(filePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) return false;
  return !BLOCKED_PATH_RE.test(normalized);
}

function isTextCandidatePath(relativePath = '') {
  const normalized = String(relativePath || '').replaceAll('\\', '/');
  const basename = path.basename(normalized);
  return SAFE_TEXT_EXTENSION_RE.test(normalized) || SAFE_BASENAME_RE.test(basename);
}

async function readSafeFile(repoRoot, relativePath) {
  if (!isSafeRelativePath(relativePath)) return null;
  if (!isTextCandidatePath(relativePath)) return null;
  const absolutePath = path.resolve(repoRoot, relativePath);
  if (!absolutePath.startsWith(`${repoRoot}${path.sep}`) && absolutePath !== repoRoot) return null;
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  const text = await fs.readFile(absolutePath, 'utf8').catch(() => null);
  if (!text) return null;
  return {
    path: relativePath,
    text,
  };
}

async function listSafeRepoFiles(repoRoot) {
  const results = [];
  const queue = [''];

  while (queue.length && results.length < MAX_REPO_FILES) {
    const current = queue.shift();
    const absoluteDir = path.resolve(repoRoot, current);
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = path.posix.join(current.replaceAll('\\', '/'), entry.name);
      if (!isSafeRelativePath(relativePath)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        queue.push(relativePath);
        continue;
      }
      if (!entry.isFile() || !isTextCandidatePath(relativePath)) continue;
      results.push(relativePath);
      if (results.length >= MAX_REPO_FILES) break;
    }
  }

  return results;
}

function keywordCandidates(question = '') {
  const selected = new Set();
  for (const topic of TOPIC_FILES) {
    if (topic.patterns.some((pattern) => pattern.test(question))) {
      for (const file of topic.files) selected.add(file);
    }
  }
  if (!selected.size) {
    for (const file of TOPIC_FILES.find((topic) => topic.topic === 'repo-question')?.files || []) selected.add(file);
  }
  return [...selected];
}

function lineMatchesTerms(line = '', terms = []) {
  const value = line.toLowerCase();
  return terms.some((term) => term.length >= 2 && value.includes(term.toLowerCase()));
}

function termsFromQuestion(question = '') {
  const asciiTerms = question.match(/[A-Za-z_][A-Za-z0-9_-]{2,}/g) || [];
  const cjkTerms = question.match(/[\u4e00-\u9fff]{2,8}/g) || [];
  const value = String(question || '');
  const inferred = [];
  const synonymEntries = [
    [
      /session|sessions|会话|对话|上下文|记忆|保存|存储/i,
      ['slack_sessions', 'session_memories', 'SlackSession', 'SessionMemory', 'activeJobId', 'activeWorkItem'],
    ],
    [/workflow|Actions|CI|CD|构建|测试|部署/i, ['workflow', 'actions', 'ci', 'site-check', 'pages-agent', 'platform-agent']],
    [/issue|PR|pull request|GitHub|webhook/i, ['issue', 'pull_request', 'resource-webhooks', 'github', 'prNumber']],
    [/Slack|bot|机器人|agent|notifier/i, ['slack-agent', 'slack-notifier', 'toolCall', 'agentRun']],
    [/数据库|MySQL|schema|表|字段|数据结构/i, ['schema', 'repositories', 'rows', 'mysql', 'drizzle']],
    [/ECS|Docker|部署脚本|容器/i, ['deploy-ecs', 'Dockerfile', 'node-service']],
    [/repo|repository|代码|架构|实现|读取|检索/i, ['repo-question', 'architecture', 'README']],
  ];
  for (const [pattern, terms] of synonymEntries) {
    if (pattern.test(value)) inferred.push(...terms);
  }
  return [...new Set([...asciiTerms, ...cjkTerms, ...inferred])]
    .filter((term) => !/^(?:怎么|如何|怎样|哪里|在哪|是什么|目前|这种|这个|那个|是否|可以|需要)$/.test(term))
    .slice(0, 36);
}

function countOccurrences(text = '', term = '') {
  const value = text.toLowerCase();
  const needle = String(term || '').toLowerCase();
  if (!needle || needle.length < 2) return 0;
  let count = 0;
  let index = value.indexOf(needle);
  while (index >= 0 && count < 20) {
    count += 1;
    index = value.indexOf(needle, index + needle.length);
  }
  return count;
}

function scoreFile(file, terms = [], seedScore = 0) {
  const relativePath = file.path.toLowerCase();
  const text = file.text.toLowerCase();
  let score = seedScore;
  for (const term of terms) {
    const normalized = String(term || '').toLowerCase();
    if (normalized.length < 2) continue;
    if (relativePath.includes(normalized)) score += 12;
    const occurrences = countOccurrences(text, normalized);
    if (occurrences) score += Math.min(occurrences, 12);
  }
  if (/schema|repositories|rows|workflow|agent|slack|github/i.test(file.path)) score += 3;
  return score;
}

function evidenceFromFile(file, question = '', terms = termsFromQuestion(question)) {
  const lines = file.text.split('\n');
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lineMatchesTerms(lines[index], terms)) continue;
    const start = Math.max(0, index - 1);
    const end = Math.min(lines.length, index + 2);
    matches.push({
      line: index + 1,
      excerpt: redactSecretLikeText(lines.slice(start, end).join('\n').trim()).slice(0, 700),
    });
    if (matches.length >= 2) break;
  }

  if (!matches.length) {
    const firstUseful = lines.findIndex((line) => /\S/.test(line));
    if (firstUseful >= 0) {
      matches.push({
        line: firstUseful + 1,
        excerpt: redactSecretLikeText(lines.slice(firstUseful, firstUseful + 3).join('\n').trim()).slice(0, 700),
      });
    }
  }

  return {
    path: file.path,
    matches,
  };
}

async function searchRepoEvidence(repoRoot, question) {
  const terms = termsFromQuestion(question);
  const seedPaths = new Set(keywordCandidates(question));
  const paths = new Set([...seedPaths, ...(await listSafeRepoFiles(repoRoot))]);
  const scored = [];
  let searchedBytes = 0;

  for (const relativePath of paths) {
    if (searchedBytes >= MAX_SEARCH_BYTES) break;
    const file = await readSafeFile(repoRoot, relativePath);
    if (!file) continue;
    searchedBytes += Buffer.byteLength(file.text, 'utf8');
    const score = scoreFile(file, terms, seedPaths.has(relativePath) ? 20 : 0);
    if (score <= 0) continue;
    scored.push({ file, score });
  }

  return scored
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path))
    .slice(0, MAX_EVIDENCE_FILES)
    .map(({ file }) => evidenceFromFile(file, question, terms));
}

function fileRole(relativePath = '') {
  if (/db\/schema\.js$/.test(relativePath)) return '定义 MySQL 表结构和关键字段。';
  if (/repositories\//.test(relativePath)) return '负责把运行态读写落到 store / 数据库。';
  if (/rows\//.test(relativePath)) return '负责数据库 row 和运行时对象之间的转换。';
  if (/slack\/session\.js$/.test(relativePath)) return '负责 Slack 会话选择、创建和续接。';
  if (/slack\/repo-question\.js$/.test(relativePath)) return '负责当前仓库只读检索和证据裁剪。';
  if (/slack-agent\/src\/analysis\.js$/.test(relativePath)) return '负责把自然语言归类为查询、诊断或创建需求。';
  if (/control-plane\/handlers\.js$/.test(relativePath)) return '负责把 Slack Agent 的 tool call 路由到 gateway 执行。';
  if (/\.github\/workflows\//.test(relativePath)) return '定义 GitHub Actions 触发和执行边界。';
  if (/docs\/architecture\//.test(relativePath)) return '记录产品和架构约束。';
  if (/Dockerfile|deploy-ecs/.test(relativePath)) return '决定 ECS 容器内可用的仓库 snapshot。';
  return '包含和问题相关的实现或约束。';
}

function evidenceSummary(evidence = []) {
  const items = evidence.filter((item) => item.matches?.length).slice(0, MAX_EVIDENCE_FILES);
  if (!items.length) return '';
  return items.map((item) => `- \`${item.path}\`：${fileRole(item.path)}`).join('\n');
}

function answerFromEvidence(question, evidence) {
  if (/session|sessions|会话|对话|保存|存储|memory|active/i.test(question)) {
    return [
      '当前 Slack 对话不是只放在 Slack 里，而是由 gateway 按用户和 thread 维度持久化。',
      '`slack_sessions` 保存会话主体、Slack user、thread、active job/work item、Issue/PR/Preview 指针和过期时间。',
      '`session_memories` 保存这轮对话的摘要、结构化需求、待澄清问题和最近回复。',
      '`work_item_links` / `issue_links` 把 session 和 PublishingJob、PlatformDevItem、GitHub Issue/PR、Preview 关联起来。',
      '所以后续同一 thread 或用户明确引用 issue/PR 时，可以找回上下文；关闭或过期只影响默认续接，不删除 Issue/PR。',
    ].join('\n');
  }

  if (/workflow|actions|CI|CD|构建|部署/i.test(question)) {
    return [
      '这类流程主要分成平台 CI/CD 和用户站点执行器两条线。',
      '平台 PR 走 CI / staging preview / 人工生产部署；用户站点 PR 走 project-index、pages-agent、site-check、pages-preview 等受限 workflow。',
      '具体触发条件、分支边界和 webhook 合同需要结合下面这些文件继续看。',
    ].join('\n');
  }

  if (/ECS|Docker|部署脚本|容器|snapshot/i.test(question)) {
    return [
      'ECS 上的 repo 问答依赖容器内可读的仓库 snapshot。',
      '当前实现会把运行服务需要的 `apps`、`packages`，以及用于问答的 `docs`、`scripts`、`.github` 一起打进镜像或上传到远端构建目录。',
      '同时 `.env*`、`.git`、依赖目录和常见 secret 路径仍然被排除。',
    ].join('\n');
  }

  if (/repo|代码|实现|架构|只读|检索/i.test(question)) {
    return [
      'Repo 问答作为查询类能力处理：Slack Agent 只提出只读查询，gateway 在当前仓库 snapshot 内做受控检索并返回依据。',
      '这条路径不能创建 issue，也不能写仓库；如果用户确认要改，再转 Platform Dev Lane。',
    ].join('\n');
  }

  const summary = evidenceSummary(evidence);
  return summary
    ? `我在当前仓库里找到了这些相关实现：\n${summary}\n\n如果要继续定位具体调用链，可以继续追问具体文件或阶段。`
    : '我没有在当前仓库 snapshot 里找到足够依据。可能需要补充关键词，或确认线上 gateway 是否挂载了完整 repo snapshot。';
}

function evidenceText(evidence = []) {
  const lines = evidence
    .filter((item) => item.matches?.length)
    .slice(0, MAX_EVIDENCE_FILES)
    .map((item) => {
      const first = item.matches[0];
      return `- \`${item.path}:${first.line}\``;
    });
  return lines.length ? `\n\n依据：\n${lines.join('\n')}` : '';
}

function slackAgentRepoAnswerEndpoint(env = {}) {
  if (env.SLACK_AGENT_REPO_ANSWER_URL) return env.SLACK_AGENT_REPO_ANSWER_URL;
  if (env.SLACK_AGENT_TURN_URL) return String(env.SLACK_AGENT_TURN_URL).replace(/\/turn\/?$/, '/repo-answer');
  if (env.SLACK_AGENT_ANALYZE_URL) return String(env.SLACK_AGENT_ANALYZE_URL).replace(/\/analyze\/?$/, '/repo-answer');
  return null;
}

function evidenceForAgent(evidence = []) {
  return evidence
    .filter((item) => item.path && item.matches?.length)
    .slice(0, MAX_EVIDENCE_FILES)
    .map((item) => ({
      path: item.path,
      lines: item.matches.map((match) => match.line).filter(Boolean),
      excerpts: item.matches
        .map((match) => match.excerpt)
        .filter(Boolean)
        .slice(0, MAX_EVIDENCE_EXCERPTS),
    }));
}

async function askSlackAgentRepoAnswer(env = {}, { question, evidence } = {}) {
  const endpoint = slackAgentRepoAnswerEndpoint(env);
  if (!endpoint || !env.SLACK_AGENT_SHARED_SECRET) return null;

  const fetchImpl = env.SLACK_AGENT_FETCH || fetch;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pages-Slack-Agent-Token': env.SLACK_AGENT_SHARED_SECRET,
    },
    body: JSON.stringify({
      question,
      evidence: evidenceForAgent(evidence),
    }),
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { rawText: text };
  }
  if (!response.ok || !body?.ok || !body.answer?.answerText) {
    const error = new Error(body?.error || `Slack Agent repo answer failed: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body.answer;
}

export async function answerRepoQuestion(env = {}, input = {}) {
  const question = sanitizeQuestion(input.question || input.text || input.query || '');
  const repoRoot = repoRootFromEnv(env);
  const evidence = await searchRepoEvidence(repoRoot, question);
  let answer = answerFromEvidence(question, evidence);
  let answerSource = 'deterministic';
  let agentAnswerError = null;

  try {
    const agentAnswer = await askSlackAgentRepoAnswer(env, { question, evidence });
    if (agentAnswer?.answerText) {
      answer = agentAnswer.answerText;
      answerSource = agentAnswer.source || 'agent';
    }
  } catch (err) {
    agentAnswerError = redactSecretLikeText(err.message);
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_repo_answer_agent_failed',
        error: agentAnswerError,
      })
    );
  }

  return {
    ok: true,
    action: 'answer_repo_question',
    accepted: true,
    question,
    answerSource,
    ...(agentAnswerError ? { agentAnswerError } : {}),
    replyText: redactSecretLikeText(`${answer}${evidenceText(evidence)}`),
    evidence: evidence.map((item) => ({
      path: item.path,
      lines: item.matches.map((match) => match.line),
    })),
  };
}
