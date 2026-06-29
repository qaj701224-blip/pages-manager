import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { redactSecretLikeText } from './text.js';

const DEFAULT_REPO_ROOT = path.resolve(process.cwd());
const MAX_FILE_BYTES = 180_000;
const MAX_EVIDENCE_FILES = 5;
const MAX_DEEP_EVIDENCE_FILES = 10;
const MAX_REPO_FILES = 1_500;
const MAX_SEARCH_BYTES = 12_000_000;
const MAX_EVIDENCE_EXCERPTS = 2;
const MAX_DEEP_EVIDENCE_EXCERPTS = 3;
const MAX_REPO_CONTEXT_TURNS = 5;
const MAX_REPO_TREE_FILES_FOR_AGENT = 1_200;
const MAX_REPO_PLAN_ROUNDS = 2;
const MAX_STORED_EVIDENCE_SNIPPETS = 8;
const MAX_VISIBLE_EVIDENCE_SNIPPETS = 5;

const BLOCKED_PATH_RE = new RegExp(
  [
    '(^|/)(?:\\.git|node_modules|\\.wrangler|coverage|dist|build|\\.next|\\.turbo|\\.cache)(?:/|$)',
    '(^|/)\\.env(?:\\.|$)',
    '(?:^|/)(?:id_rsa|known_hosts|wrangler\\.toml|\\.pages\\.json|\\.dev\\.vars|\\.staging\\.env|\\.ack-preview\\.env|\\.ack_preview\\.env)$',
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

function sanitizeQuestion(question = '', maxLength = 240) {
  return redactSecretLikeText(String(question || '').replaceAll(/\s+/g, ' ').trim()).slice(0, maxLength);
}

function truncateBlockText(text = '', maxLength = 2900) {
  const value = redactSecretLikeText(String(text || '').trim());
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}…`;
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

function repoQuestionContextFromMemory(sessionMemory = {}) {
  const context = sessionMemory?.repoQuestionContext || {};
  const turns = Array.isArray(context.turns) ? context.turns.filter((turn) => turn && typeof turn === 'object') : [];
  return {
    turns: turns.slice(-MAX_REPO_CONTEXT_TURNS),
    lastEvidencePaths: Array.isArray(context.lastEvidencePaths) ? context.lastEvidencePaths.filter(Boolean).slice(0, 12) : [],
    openQuestions: Array.isArray(context.openQuestions) ? context.openQuestions.filter(Boolean).slice(0, 5) : [],
  };
}

function latestRepoQuestionTurn(sessionMemory = {}) {
  const turns = repoQuestionContextFromMemory(sessionMemory).turns;
  return turns.length ? turns[turns.length - 1] : null;
}

function looksLikeRepoFollowup(question = '') {
  return /(这个|这些|上面|刚才|继续|完整|详细|具体|如果要|怎么改|怎么做|如何实现|实现|方案|还有|那|它|前面)/i.test(
    question
  );
}

function wantsDeepRepoAnswer(question = '', input = {}) {
  if (input.deepDive || input.mode === 'deep_dive') return true;
  return /(完整|详细|深入|深挖|继续|具体|怎么改|怎么做|如何实现|实现方案|落地|代码层面|测试|风险)/i.test(question);
}

function wantsImplementationPlan(input = {}) {
  return input.mode === 'implementation_plan' || input.plan === true;
}

function uniqStrings(items = [], limit = 20) {
  return [...new Set(items.filter(Boolean))].slice(0, limit);
}

function effectiveQuestionForRepoSearch(question = '', sessionMemory = {}, input = {}) {
  const sanitized = sanitizeQuestion(question);
  const lastTurn = latestRepoQuestionTurn(sessionMemory);
  if (!lastTurn || (!looksLikeRepoFollowup(sanitized) && !input.deepDive && !wantsImplementationPlan(input))) {
    return sanitized;
  }

  const parts = [
    `上一轮问题：${lastTurn.question || ''}`,
    lastTurn.answerSummary ? `上一轮结论：${lastTurn.answerSummary}` : '',
    Array.isArray(lastTurn.evidencePaths) && lastTurn.evidencePaths.length
      ? `上一轮依据：${lastTurn.evidencePaths.join(', ')}`
      : '',
    `本轮追问：${sanitized}`,
  ].filter(Boolean);
  return sanitizeQuestion(parts.join('。'), 900);
}

function relatedPathsForEvidencePath(relativePath = '') {
  const pathValue = String(relativePath || '').replaceAll('\\', '/');
  const related = new Set();
  if (/apps\/gateway\/src\/db\/schema\.js$/.test(pathValue)) {
    related.add('apps/gateway/src/db/repositories/slack-sessions.js');
    related.add('apps/gateway/src/db/rows/slack-row.js');
    related.add('tests/helpers/gateway-store-fixture.js');
  }
  if (/apps\/gateway\/src\/db\/repositories\//.test(pathValue)) {
    related.add('apps/gateway/src/db/schema.js');
    related.add('apps/gateway/src/db/rows/slack-row.js');
    related.add('apps/gateway/src/db/repositories/index.js');
  }
  if (/apps\/gateway\/src\/control-plane\/handlers\.js$/.test(pathValue)) {
    related.add('apps/gateway/src/slack/agent-tool-call.js');
    related.add('apps/gateway/src/slack/repo-question.js');
    related.add('tests/apps/gateway/index.test.js');
  }
  if (/apps\/gateway\/src\/slack\/repo-question\.js$/.test(pathValue)) {
    related.add('apps/gateway/src/control-plane/handlers.js');
    related.add('apps/slack-agent/src/model-provider.js');
    related.add('tests/apps/gateway/index.test.js');
  }
  if (/apps\/slack-agent\/src\/analysis\.js$/.test(pathValue)) {
    related.add('apps/slack-agent/src/model-provider.js');
    related.add('tests/apps/slack-agent/index.test.js');
  }
  if (/\.github\/workflows\//.test(pathValue)) {
    related.add('docs/architecture/github-automation.md');
    related.add('scripts/workflows.test.js');
  }
  if (/docker-compose\.ecs\.yml$|Dockerfile|deploy-ecs|deploy\/ecs\//.test(pathValue)) {
    related.add('Dockerfile.node-service');
    related.add('docker-compose.ecs.yml');
    related.add('scripts/ecs-caddy.test.js');
  }
  return [...related];
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

function evidenceFromFile(file, question = '', terms = termsFromQuestion(question), options = {}) {
  const lines = file.text.split('\n');
  const matches = [];
  const maxExcerpts = options.maxExcerpts || MAX_EVIDENCE_EXCERPTS;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lineMatchesTerms(lines[index], terms)) continue;
    const start = Math.max(0, index - 1);
    const end = Math.min(lines.length, index + 2);
    matches.push({
      line: index + 1,
      excerpt: redactSecretLikeText(lines.slice(start, end).join('\n').trim()).slice(0, 700),
    });
    if (matches.length >= maxExcerpts) break;
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

async function searchRepoEvidence(repoRoot, question, options = {}) {
  const terms = termsFromQuestion(question);
  const seedPaths = new Set(keywordCandidates(question));
  for (const seedPath of options.seedPaths || []) {
    if (isSafeRelativePath(seedPath)) seedPaths.add(seedPath);
  }
  for (const evidencePath of options.previousEvidencePaths || []) {
    if (!isSafeRelativePath(evidencePath)) continue;
    seedPaths.add(evidencePath);
    for (const relatedPath of relatedPathsForEvidencePath(evidencePath)) seedPaths.add(relatedPath);
  }
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
    .slice(0, options.maxEvidenceFiles || MAX_EVIDENCE_FILES)
    .map(({ file }) => evidenceFromFile(file, question, terms, options));
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

function evidenceSummary(evidence = [], limit = MAX_EVIDENCE_FILES) {
  const items = evidence.filter((item) => item.matches?.length).slice(0, limit);
  if (!items.length) return '';
  return items.map((item) => `- \`${item.path}\`：${fileRole(item.path)}`).join('\n');
}

function answerFromEvidence(question, evidence) {
  if (/session|sessions|会话|对话|保存|存储|memory|active/i.test(question)) {
    const summary = evidenceSummary(evidence);
    return [
      '结论：Slack 对话不是只存在 Slack 里，而是由平台按 Slack 用户和 thread 维度持久化。',
      '',
      '当前链路：',
      '1. Slack event 进入平台入口后，会选择或创建一个 Slack session。',
      '2. 会话主体记录 Slack user、thread、active job/work item、Issue/PR/Preview 指针和过期时间。',
      '3. 会话记忆记录摘要、结构化需求、待澄清问题、最近回复和 repo 问答上下文。',
      '4. 发布任务、平台需求、GitHub Issue/PR 和 Preview 通过 link / active target 续接到同一个会话。',
      '',
      summary ? `关键文件：\n${summary}` : '',
      '',
      '如果要改：优先确认是改 Slack 会话续接、repo 问答记忆，还是任务 / Issue / PR 绑定；这三类会落在不同模块和测试里。',
      '限制：这是基于当前相关 repo evidence 的判断，不是完整源码浏览结果。',
    ]
      .filter(Boolean)
      .join('\n');
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
    ? [
        '结论：我在当前仓库里找到了和问题相关的实现依据。',
        '',
        `关键文件：\n${summary}`,
        '',
        '如果要改：可以先生成改造方案，我会把影响范围、建议改动位置、测试路径和风险边界整理出来。',
        '限制：这是基于当前相关 repo evidence 的判断，不是完整源码浏览结果。',
      ].join('\n')
    : '我没有在当前仓库 snapshot 里找到足够依据。可能需要补充关键词，或确认线上 gateway 是否挂载了完整 repo snapshot。';
}

function evidenceText(evidence = [], limit = MAX_EVIDENCE_FILES) {
  const lines = evidence
    .filter((item) => item.matches?.length)
    .slice(0, limit)
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

function slackAgentRepoPlanEndpoint(env = {}) {
  if (env.SLACK_AGENT_REPO_PLAN_URL) return env.SLACK_AGENT_REPO_PLAN_URL;
  if (env.SLACK_AGENT_TURN_URL) return String(env.SLACK_AGENT_TURN_URL).replace(/\/turn\/?$/, '/repo-plan');
  if (env.SLACK_AGENT_ANALYZE_URL) return String(env.SLACK_AGENT_ANALYZE_URL).replace(/\/analyze\/?$/, '/repo-plan');
  return null;
}

function evidenceForAgent(evidence = [], options = {}) {
  return evidence
    .filter((item) => item.path && item.matches?.length)
    .slice(0, options.maxEvidenceFiles || MAX_EVIDENCE_FILES)
    .map((item) => ({
      path: item.path,
      lines: item.matches.map((match) => match.line).filter(Boolean),
      excerpts: item.matches
        .map((match) => match.excerpt)
        .filter(Boolean)
        .slice(0, options.maxExcerpts || MAX_EVIDENCE_EXCERPTS),
    }));
}

function normalizeRepoResearchPlan(plan = {}, fallback = {}) {
  const queries = Array.isArray(plan.queries) ? plan.queries : Array.isArray(plan.searchQueries) ? plan.searchQueries : [];
  const readPaths = Array.isArray(plan.readPaths) ? plan.readPaths : Array.isArray(plan.read_paths) ? plan.read_paths : [];
  const requestedMode = ['normal', 'deep_dive', 'implementation_plan'].includes(fallback.mode) ? fallback.mode : 'normal';
  const planMode = ['normal', 'deep_dive', 'implementation_plan'].includes(plan.mode) ? plan.mode : null;
  const normalizedMode = requestedMode !== 'normal' ? requestedMode : planMode || requestedMode;
  return {
    mode: normalizedMode,
    queries: queries.map((item) => sanitizeQuestion(item, 180)).filter(Boolean).slice(0, 5),
    readPaths: readPaths.filter(isSafeRelativePath).slice(0, normalizedMode === 'normal' ? 8 : 16),
    rationale: sanitizeQuestion(plan.rationale || fallback.rationale || '', 300),
    suggestedNextAction:
      plan.suggestedNextAction === 'create_platform_issue' || plan.suggested_next_action === 'create_platform_issue'
        ? 'create_platform_issue'
        : 'none',
  };
}

function mergeRepoResearchPlans(base = {}, next = {}) {
  return {
    ...base,
    mode: next.mode || base.mode || 'normal',
    queries: uniqStrings([...(base.queries || []), ...(next.queries || [])], 8),
    readPaths: uniqStrings([...(base.readPaths || []), ...(next.readPaths || [])], 24),
    rationale: next.rationale || base.rationale || '',
    suggestedNextAction:
      next.suggestedNextAction === 'create_platform_issue' || base.suggestedNextAction === 'create_platform_issue'
        ? 'create_platform_issue'
        : 'none',
  };
}

function mergeRepoEvidence(existing = [], incoming = [], limit = MAX_EVIDENCE_FILES) {
  const byPath = new Map();
  for (const item of [...existing, ...incoming]) {
    if (!item?.path) continue;
    const current = byPath.get(item.path);
    if (!current) {
      byPath.set(item.path, {
        ...item,
        matches: Array.isArray(item.matches) ? [...item.matches] : [],
      });
      continue;
    }
    const seenLines = new Set(current.matches.map((match) => match.line));
    for (const match of item.matches || []) {
      if (seenLines.has(match.line)) continue;
      current.matches.push(match);
      seenLines.add(match.line);
    }
  }
  return [...byPath.values()].slice(0, limit);
}

function deterministicRepoResearchPlan(question = '', sessionMemory = {}, input = {}, repoTree = {}) {
  const context = repoQuestionContextFromMemory(sessionMemory);
  const mode = wantsImplementationPlan(input)
    ? 'implementation_plan'
    : input.deepDive || input.mode === 'deep_dive'
      ? 'deep_dive'
      : 'normal';
  const questionTerms = termsFromQuestion(question);
  const seedPaths = new Set([
    ...keywordCandidates(question),
    ...context.lastEvidencePaths,
    ...(repoTree.files || []).filter((file) =>
      questionTerms.some((term) => file.toLowerCase().includes(term.toLowerCase()))
    ),
  ]);
  return normalizeRepoResearchPlan(
    {
      mode,
      queries: [question],
      readPaths: [...seedPaths],
      rationale: '模型不可用时使用确定性 repo 调研计划。',
      suggestedNextAction: wantsImplementationPlan(input) ? 'create_platform_issue' : 'none',
    },
    { mode: input.mode || 'normal' }
  );
}

async function repoTreeForAgent(repoRoot) {
  const files = await listSafeRepoFiles(repoRoot);
  const topLevel = [...new Set(files.map((file) => file.split('/')[0]).filter(Boolean))].slice(0, 60);
  return {
    topLevel,
    files: files.slice(0, MAX_REPO_TREE_FILES_FOR_AGENT),
    totalVisibleFiles: files.length,
    truncated: files.length > MAX_REPO_TREE_FILES_FOR_AGENT,
  };
}

async function askSlackAgentRepoPlan(
  env = {},
  { question, originalQuestion, sessionMemory, mode, repoTree, observations } = {}
) {
  const fallback = deterministicRepoResearchPlan(originalQuestion || question, sessionMemory, { mode }, repoTree);
  const endpoint = slackAgentRepoPlanEndpoint(env);
  if (!endpoint || !env.SLACK_AGENT_SHARED_SECRET) return fallback;

  const fetchImpl = env.SLACK_AGENT_FETCH || fetch;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pages-Slack-Agent-Token': env.SLACK_AGENT_SHARED_SECRET,
    },
    body: JSON.stringify({
      question,
      originalQuestion: originalQuestion || question,
      mode,
      context: repoAnswerContextForAgent(sessionMemory),
      repoTree,
      observations: observations || null,
    }),
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { rawText: text };
  }
  if (!response.ok || !body?.ok || !body.plan) {
    const error = new Error(body?.error || `Slack Agent repo plan failed: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return normalizeRepoResearchPlan(body.plan, fallback);
}

function canAskSlackAgentRepoPlan(env = {}) {
  return Boolean(slackAgentRepoPlanEndpoint(env) && env.SLACK_AGENT_SHARED_SECRET);
}

function evidenceSnippetsForMemory(evidence = []) {
  const snippets = [];
  for (const item of evidence) {
    for (const match of item.matches || item.snippets || []) {
      if (!item.path || !match?.excerpt) continue;
      snippets.push({
        path: item.path,
        line: match.line || null,
        excerpt: redactSecretLikeText(String(match.excerpt || '').trim()).slice(0, 700),
      });
      if (snippets.length >= MAX_STORED_EVIDENCE_SNIPPETS) return snippets;
    }
  }
  return snippets;
}

function repoAnswerContextForAgent(sessionMemory = {}) {
  const lastTurn = latestRepoQuestionTurn(sessionMemory);
  if (!lastTurn) return null;
  return {
    previousQuestion: lastTurn.question || '',
    previousAnswerSummary: lastTurn.answerSummary || '',
    previousEvidencePaths: Array.isArray(lastTurn.evidencePaths) ? lastTurn.evidencePaths.slice(0, 10) : [],
    openQuestions: repoQuestionContextFromMemory(sessionMemory).openQuestions,
  };
}

async function askSlackAgentRepoAnswer(
  env = {},
  { question, originalQuestion, evidence, sessionMemory, mode, options, researchPlan } = {}
) {
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
      originalQuestion: originalQuestion || question,
      mode: mode || 'normal',
      context: repoAnswerContextForAgent(sessionMemory),
      researchPlan: researchPlan || null,
      evidence: evidenceForAgent(evidence, options),
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
  const sessionMemory = input.sessionMemory || null;
  const implementationPlan = wantsImplementationPlan(input);
  const deepDive = implementationPlan || wantsDeepRepoAnswer(question, input);
  let mode = implementationPlan ? 'implementation_plan' : deepDive ? 'deep_dive' : 'normal';
  const effectiveQuestion = effectiveQuestionForRepoSearch(question, sessionMemory, input);
  const previousEvidencePaths = repoQuestionContextFromMemory(sessionMemory).lastEvidencePaths;
  const repoRoot = repoRootFromEnv(env);
  const repoTree = await repoTreeForAgent(repoRoot);
  let researchPlan = deterministicRepoResearchPlan(effectiveQuestion, sessionMemory, { ...input, mode }, repoTree);
  let researchPlanError = null;
  try {
    researchPlan = await askSlackAgentRepoPlan(env, {
      question: effectiveQuestion,
      originalQuestion: question,
      sessionMemory,
      mode,
      repoTree,
    });
  } catch (err) {
    researchPlanError = redactSecretLikeText(err.message);
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_repo_plan_agent_failed',
        error: researchPlanError,
      })
    );
  }
  mode = researchPlan.mode || mode;
  const evidenceOptions = {
    maxEvidenceFiles: mode === 'normal' ? MAX_EVIDENCE_FILES : MAX_DEEP_EVIDENCE_FILES,
    maxExcerpts: mode === 'normal' ? MAX_EVIDENCE_EXCERPTS : MAX_DEEP_EVIDENCE_EXCERPTS,
    previousEvidencePaths,
    seedPaths: researchPlan.readPaths,
  };
  const researchQuestion = [effectiveQuestion, ...(researchPlan.queries || [])].filter(Boolean).join(' ');
  let evidence = await searchRepoEvidence(repoRoot, researchQuestion, evidenceOptions);
  const planRounds = [researchPlan];
  if (mode !== 'normal' && canAskSlackAgentRepoPlan(env)) {
    for (let round = 1; round < MAX_REPO_PLAN_ROUNDS; round += 1) {
      let nextPlan;
      try {
        nextPlan = await askSlackAgentRepoPlan(env, {
          question: effectiveQuestion,
          originalQuestion: question,
          sessionMemory,
          mode,
          repoTree,
          observations: {
            round,
            previousPlan: researchPlan,
            evidence: evidenceForAgent(evidence, evidenceOptions),
            coveredPaths: evidence.map((item) => item.path).filter(Boolean),
          },
        });
      } catch (err) {
        researchPlanError = redactSecretLikeText(err.message);
        break;
      }
      planRounds.push(nextPlan);
      const beforePaths = new Set(evidence.map((item) => item.path));
      researchPlan = mergeRepoResearchPlans(researchPlan, nextPlan);
      const nextEvidenceOptions = {
        ...evidenceOptions,
        previousEvidencePaths: uniqStrings([...previousEvidencePaths, ...beforePaths], 24),
        seedPaths: nextPlan.readPaths,
      };
      const nextResearchQuestion = [effectiveQuestion, ...(nextPlan.queries || [])].filter(Boolean).join(' ');
      const nextEvidence = await searchRepoEvidence(repoRoot, nextResearchQuestion, nextEvidenceOptions);
      evidence = mergeRepoEvidence(evidence, nextEvidence, evidenceOptions.maxEvidenceFiles);
      const afterPaths = new Set(evidence.map((item) => item.path));
      if (afterPaths.size <= beforePaths.size && !(nextPlan.queries || []).length && !(nextPlan.readPaths || []).length) break;
    }
  }
  let answer = answerFromEvidence(effectiveQuestion, evidence);
  let answerSource = 'deterministic';
  let agentAnswerError = null;

  try {
    const agentAnswer = await askSlackAgentRepoAnswer(env, {
      question: effectiveQuestion,
      originalQuestion: question,
      evidence,
      sessionMemory,
      mode,
      options: evidenceOptions,
      researchPlan,
    });
    if (agentAnswer?.answerText) {
      answer = agentAnswer.answerText;
      answerSource = agentAnswer.source || 'agent';
      if (agentAnswer.suggestedNextAction) researchPlan.suggestedNextAction = agentAnswer.suggestedNextAction;
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
    effectiveQuestion,
    mode,
    answerSource,
    researchPlan,
    planRounds,
    ...(researchPlanError ? { researchPlanError } : {}),
    suggestedNextAction: researchPlan.suggestedNextAction || 'none',
    ...(agentAnswerError ? { agentAnswerError } : {}),
    replyText: redactSecretLikeText(`${answer}${evidenceText(evidence, evidenceOptions.maxEvidenceFiles)}`),
    evidence: evidence.map((item) => ({
      path: item.path,
      lines: item.matches.map((match) => match.line),
      snippets: item.matches.map((match) => ({
        line: match.line,
        excerpt: redactSecretLikeText(String(match.excerpt || '').trim()).slice(0, 700),
      })),
    })),
  };
}

function summarizeRepoAnswerForMemory(replyText = '') {
  return redactSecretLikeText(String(replyText || '').replace(/\n\n依据：[\s\S]*$/u, '').replaceAll(/\s+/g, ' ').trim()).slice(
    0,
    700
  );
}

const REPO_IMPLEMENTATION_REQUEST_RE = new RegExp(
  [
    '(?:开始|直接|帮我|请|需要|要|希望|按这个|照这个|让|使|把).*(?:改|修改|修复|实现|支持|落地|接入|完善|优化|创建|生成)',
    '(?:改造|修改|修复|实现|支持|落地|接入|完善|优化).*(?:方案|需求|能力|代码|流程)',
    '(?:怎么改|如何实现|怎样实现|实现方案|落地方案|改造方案|需要改哪里|应该改哪里)',
  ].join('|'),
  'i'
);
const REPO_PURE_QUESTION_RE =
  /(?:是什么|在哪里|在哪|怎么保存|如何保存|怎么触发|如何触发|会不会|是否|为什么|为啥|原因|查一下|看下|目前|现在)/i;
const PLATFORM_OPS_SCOPE_RE = /\b(?:ECS|ACK|k8s|Kubernetes|Docker|kubectl|Caddy)\b|部署脚本|deploy|容器|运维/i;

function stripRepoActionPrefix(question = '') {
  return String(question || '')
    .replace(/^(?:继续深挖|生成改造方案)[：:]\s*/u, '')
    .trim();
}

export function repoQuestionTurnNeedsCodeChange(turn = {}) {
  const question = stripRepoActionPrefix(turn.question || turn.effectiveQuestion || '');
  if (!REPO_IMPLEMENTATION_REQUEST_RE.test(question)) return false;
  if (!REPO_PURE_QUESTION_RE.test(question)) return true;
  return /(怎么改|如何实现|怎样实现|实现方案|落地方案|改造方案|需要改哪里|应该改哪里)/i.test(question);
}

export function nextRepoQuestionContext(previousContext = {}, result = {}) {
  const context = repoQuestionContextFromMemory({ repoQuestionContext: previousContext });
  const evidencePaths = (result.evidence || []).map((item) => item.path).filter(Boolean).slice(0, 12);
  const evidenceSnippets = evidenceSnippetsForMemory(result.evidence || []);
  const turn = {
    question: sanitizeQuestion(result.question || ''),
    effectiveQuestion: sanitizeQuestion(result.effectiveQuestion || result.question || ''),
    answerSummary: summarizeRepoAnswerForMemory(result.replyText || ''),
    evidencePaths,
    evidenceSnippets,
    mode: result.mode || 'normal',
    createdAt: new Date().toISOString(),
  };
  return {
    ...context,
    turns: [...context.turns, turn].slice(-MAX_REPO_CONTEXT_TURNS),
    lastEvidencePaths: evidencePaths.length ? evidencePaths : context.lastEvidencePaths,
    openQuestions: [],
  };
}

export function repoQuestionActionBlocks(slackSession, result = {}, options = {}) {
  const sessionId = slackSession?.id || '';
  if (!sessionId) return null;
  const evidencePaths = (result.evidence || []).map((item) => item.path).filter(Boolean);
  const codeChangeIntent = repoQuestionTurnNeedsCodeChange({
    question: result.question || result.effectiveQuestion || '',
    effectiveQuestion: result.effectiveQuestion || result.question || '',
    answerSummary: result.replyText || '',
  });
  const contextText = evidencePaths.length
    ? `基于 ${Math.min(evidencePaths.length, result.mode === 'normal' ? MAX_EVIDENCE_FILES : MAX_DEEP_EVIDENCE_FILES)} 个相关文件生成。`
    : '当前仓库 evidence 不足，可以继续补充关键词。';
  const actions = [
    {
      type: 'button',
      text: { type: 'plain_text', text: '继续深挖' },
      action_id: 'pages_repo_deep_dive',
      value: JSON.stringify({ sessionId }).slice(0, 1900),
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: '查看依据' },
      action_id: 'pages_repo_view_evidence',
      value: JSON.stringify({ sessionId }).slice(0, 1900),
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: '生成改造方案' },
      action_id: 'pages_repo_generate_plan',
      value: JSON.stringify({ sessionId }).slice(0, 1900),
    },
  ];
  if (options.allowCreateIssueAction) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: codeChangeIntent ? '按方案创建需求' : '记录为问题咨询' },
      ...(codeChangeIntent ? { style: 'primary' } : {}),
      action_id: 'pages_repo_create_platform_issue',
      value: JSON.stringify({ sessionId }).slice(0, 1900),
    });
  }
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateBlockText(result.replyText || '我找到了当前仓库里和这个问题相关的实现依据。'),
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: contextText,
        },
      ],
    },
    {
      type: 'actions',
      elements: actions,
    },
  ];
}

export function repoEvidenceDetailsFromContext(sessionMemory = {}) {
  const lastTurn = latestRepoQuestionTurn(sessionMemory);
  const snippets = Array.isArray(lastTurn?.evidenceSnippets) ? lastTurn.evidenceSnippets : [];
  const paths = Array.isArray(lastTurn?.evidencePaths) ? lastTurn.evidencePaths : [];
  if (!snippets.length && !paths.length) {
    return '当前会话还没有可展示的 repo evidence。可以先继续追问具体模块或文件。';
  }

  const lines = [
    '我只展示本轮相关依据片段，不是完整文件。完整改造前还需要继续深挖或进入开发流程。',
    '',
  ];
  for (const [index, snippet] of snippets.slice(0, MAX_VISIBLE_EVIDENCE_SNIPPETS).entries()) {
    const location = `${snippet.path}${snippet.line ? `:${snippet.line}` : ''}`;
    lines.push(`${index + 1}. \`${location}\``);
    lines.push('```');
    lines.push(String(snippet.excerpt || '').slice(0, 700));
    lines.push('```');
  }
  if (!snippets.length && paths.length) {
    lines.push(...paths.slice(0, MAX_VISIBLE_EVIDENCE_SNIPPETS).map((item, index) => `${index + 1}. \`${item}\``));
  }
  if (paths.length > MAX_VISIBLE_EVIDENCE_SNIPPETS) {
    lines.push(`还有 ${paths.length - MAX_VISIBLE_EVIDENCE_SNIPPETS} 个相关文件未展开。`);
  }
  return truncateBlockText(lines.join('\n'), 2900);
}

export function platformDraftFromRepoQuestionContext(sessionMemory = {}) {
  const lastTurn = latestRepoQuestionTurn(sessionMemory);
  if (!lastTurn) return null;
  const titleSource = lastTurn.question || '基于仓库问答创建改造需求';
  const evidence = Array.isArray(lastTurn.evidencePaths) ? lastTurn.evidencePaths : [];
  const codeChangeIntent = repoQuestionTurnNeedsCodeChange(lastTurn);
  const classificationText = [titleSource, lastTurn.answerSummary || '', evidence.join(' ')].join('\n');
  const highRiskPath = evidence.some((file) =>
    /^(?:\.github|k8s|deploy)(?:\/|$)|Dockerfile|(?:^|\/)deploy|kubectl|KUBE_CONFIG|aliyun|ACR/i.test(file)
  );
  const issueType = codeChangeIntent
    ? /security|权限|鉴权|token|secret|cookie|密钥|漏洞/i.test(classificationText)
      ? 'type:security'
      : /\b(CI|CD)\b|workflow|Actions|构建|测试|site-check|pages-agent|platform-agent/i.test(classificationText)
        ? 'type:ci'
        : PLATFORM_OPS_SCOPE_RE.test(classificationText)
          ? 'type:ops'
          : /反馈|建议|意见/i.test(classificationText)
            ? 'type:feedback'
            : 'type:dev'
    : 'type:question';
  const areas = uniqStrings(
    [
      /Slack|slack/i.test(classificationText) ? 'area:slack' : '',
      /GitHub|issue|PR|pull_request|webhook/i.test(classificationText) ? 'area:github' : '',
      /\b(CI|CD)\b|workflow|Actions|构建|测试|site-check|pages-agent|platform-agent/i.test(classificationText)
        ? 'area:ci'
        : '',
      PLATFORM_OPS_SCOPE_RE.test(classificationText) ? 'area:ops' : '',
      /数据库|MySQL|schema|drizzle|session_memories|slack_sessions/i.test(classificationText) ? 'area:db' : '',
      /worker|gateway|notifier|agent/i.test(classificationText) ? 'area:platform' : '',
    ],
    6
  );
  const risk = !codeChangeIntent
    ? 'risk:low'
    : ['type:ci', 'type:ops', 'type:security'].includes(issueType) || highRiskPath
      ? 'risk:high'
      : 'risk:medium';
  const agentEligible = true;
  const internalSummaryLines = [
    `用户基于仓库问答希望继续推进：${titleSource}`,
    lastTurn.answerSummary ? `当前结论：${lastTurn.answerSummary}` : '',
    evidence.length ? `相关依据：${evidence.slice(0, 8).join(', ')}` : '',
  ].filter(Boolean);
  const visibleSummaryLines = codeChangeIntent
    ? [
        `基于刚才的仓库问答，继续推进这个改造：${titleSource}`,
        lastTurn.answerSummary ? `当前结论：${lastTurn.answerSummary}` : '',
        evidence.length ? '相关实现依据已记录，创建 Issue 后会进入需求上下文。' : '',
      ].filter(Boolean)
    : [
        `把刚才的仓库问答记录为问题咨询：${titleSource}`,
        lastTurn.answerSummary ? `当前结论：${lastTurn.answerSummary}` : '',
        '确认后只会先创建 issue；如果后续要改代码，请在进度卡点击“自动开发”并在当前对话明确实现目标。',
      ].filter(Boolean);
  const text = `${titleSource}\n${internalSummaryLines.join('\n')}`;
  return {
    visibleReply: codeChangeIntent ? '我整理成一个待确认的平台需求。' : '我整理成一个待确认的问题咨询记录。',
    lane: 'platform-dev',
    intent: 'create_platform_issue',
    toolCall: { name: 'confirm_platform_issue', args: {} },
    issueType,
    areas: areas.length ? areas : ['area:platform'],
    risk,
    agentEligible,
    title: titleSource.length > 80 ? `${titleSource.slice(0, 77)}...` : titleSource,
    summary: visibleSummaryLines.join('\n').slice(0, 1800),
    needsClarification: false,
    sourceMessages: [text],
    safetyNotes: [
      codeChangeIntent
        ? '由 repo 问答结果转为待确认需求；创建 issue 前仍需用户点击确认。'
        : '由 repo 问答结果转为问题咨询记录；确认后只创建 issue，不启动自动开发。',
    ],
  };
}
