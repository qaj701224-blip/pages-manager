import {
  slackWorkItemIncludesInactive,
  slackWorkItemQueryStateFromText,
} from './work-item-query.js';

const JOB_ID_RE = /\bjob_[A-Za-z0-9_]+\b/;
const SESSION_ID_RE = /\bsess_[A-Za-z0-9_]+\b/;
const GITHUB_WORK_ITEM_URL_RE =
  /https?:\/\/github\.com\/[^/\s<>]+\/[^/\s<>]+\/(issues|pull)\/(\d{1,8})(?:[/?#][^\s<>]*)?/i;
const ISSUE_NUMBER_RE = /(?:issue|issues|需求|任务)\s*#?\s*(\d{1,8})\b/i;
const PR_NUMBER_RE = /\b(?:PR|pull\s*request|pull-request|pullrequest)\s*#?\s*(\d{1,8})\b/i;
const BARE_WORK_ITEM_NUMBER_RE = /#(\d{1,8})\b/;
const SLASH_COMMAND_RE = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;
const TEXT_COMMAND_RE = /^(issue|page|site|status|help|ping|cancel|close|tasks?|prs?|work):([\s\S]*)?$/i;
const WORK_ITEM_COMMAND_RE = /^(tasks?|prs?|work)(?:\s+([\s\S]*))?$/i;
const NATURAL_STATUS_QUERY_RE =
  /(?:^(?:status|状态)\b(?:\s+job_[A-Za-z0-9_]+)?$)|(?:^(?:status|状态)\s+.+$)|(?:(?:现在|当前|目前|这会儿|此刻).{0,12}(?:进度|状态).{0,12}(?:怎么样|如何|咋样|到哪了|呢))|(?:(?:进度|状态).{0,12}(?:怎么样|如何|咋样|到哪了|呢|查一下|查下|看一下|看下))/i;

export function isWorkItemHistoryQuery(text = '') {
  return slackWorkItemIncludesInactive(slackWorkItemQueryStateFromText(text));
}

export function normalizeSlackIntakeText(text = '') {
  return String(text)
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replace(/^(<@[A-Z0-9]+>\s*)+/, '')
    .trim();
}

function helpText() {
  return [
    '你可以直接和我聊个人网站需求。我会先整理，等你确认后再创建 issue。',
    '',
    '可以这样说：',
    '- `我想做一个个人主页，突出项目经历和技术风格`',
    '- `这个 preview 不满意，把标题改成中文，再加一个项目经历区域`',
    '- `现在进度怎么样`',
    '',
    '命令写法仍然支持：',
    '- `issue: 给 smoke/profile 做一个个人主页`',
    '- `status`',
    '',
    '如果信息不够，我会继续追问。',
  ].join('\n');
}

function unknownText() {
  return ['我收到了，但现在还不能理解这条消息，所以先不创建 issue。', '', '你可以稍后重试，或直接描述你想做的个人网站。'].join(
    '\n'
  );
}

function commandIntent(text) {
  const match = text.match(SLASH_COMMAND_RE) || text.match(TEXT_COMMAND_RE) || text.match(WORK_ITEM_COMMAND_RE);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    args: (match[2] || '').trim(),
  };
}

function isExplicitSessionCloseRequest(text, command) {
  const commandArgs = String(command?.args || '').replaceAll(/\s+/g, ' ').trim().toLowerCase();

  if (command?.command !== 'close') return false;
  if (!commandArgs) return true;
  if (SESSION_ID_RE.test(command.args)) return true;
  return ['session', 'conversation', '会话', '对话', '当前会话', '当前对话'].includes(commandArgs);
}

function isNaturalSessionCloseRequest(text = '') {
  const value = String(text || '');
  if (parseSlackWorkItemReference(value)) return false;
  return /(?:(?:关闭|结束|停止|退出|close|end)\s*(?:当前)?(?:这个)?\s*(?:会话|对话|session|conversation))|(?:(?:会话|对话|session|conversation).*(?:关闭|结束|停止|退出|close|end))/i.test(
    value
  );
}

function isNaturalStatusQuery(text = '') {
  const value = String(text || '');
  if (isWorkItemHistoryQuery(value)) return false;
  if (NATURAL_STATUS_QUERY_RE.test(value)) return true;
  return JOB_ID_RE.test(value) && /(?:状态|进度|status|怎么样|如何|咋样|查一下|查下|看一下|看下)/i.test(value);
}

export function parseSlackPrNumber(text = '') {
  const match = String(text || '').match(PR_NUMBER_RE);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function parseSlackWorkItemReference(text = '') {
  const value = String(text || '');
  const githubMatch = value.match(GITHUB_WORK_ITEM_URL_RE);
  if (githubMatch) {
    const number = Number(githubMatch[2]);
    if (!Number.isFinite(number) || number <= 0) return null;
    return { kind: githubMatch[1] === 'pull' ? 'pr' : 'issue', number };
  }

  const issueMatch = value.match(ISSUE_NUMBER_RE);
  if (issueMatch) {
    const number = Number(issueMatch[1]);
    return Number.isFinite(number) && number > 0 ? { kind: 'issue', number } : null;
  }

  const prMatch = value.match(PR_NUMBER_RE);
  if (prMatch) {
    const number = Number(prMatch[1]);
    return Number.isFinite(number) && number > 0 ? { kind: 'pr', number } : null;
  }

  const bareMatch = value.match(BARE_WORK_ITEM_NUMBER_RE);
  if (bareMatch) {
    const number = Number(bareMatch[1]);
    return Number.isFinite(number) && number > 0 ? { kind: 'unknown', number } : null;
  }

  return null;
}

function explicitWorkItemFields(reference = null) {
  if (!reference) return {};
  return {
    explicitWorkItemReference: reference,
    targetKind: reference.kind,
    targetNumber: reference.number,
    prNumber: reference.kind === 'pr' ? reference.number : null,
    issueNumber: reference.kind === 'issue' ? reference.number : null,
  };
}

export function classifySlackIntake(body) {
  const event = body.event || {};
  const text = normalizeSlackIntakeText(event.text || body.text || '');
  const compact = text.toLowerCase();
  const command = commandIntent(text);

  if (!text) {
    return {
      action: 'empty',
      shouldCreateJob: false,
      text,
      replyText: '我收到了空消息。可以说 `帮助` 看看我支持什么。',
    };
  }

  if (command?.command === 'help' || ['help', '帮助', '菜单', '?', '说明'].includes(compact)) {
    return {
      action: 'help',
      shouldCreateJob: false,
      text,
      replyText: helpText(),
    };
  }

  if (command?.command === 'ping' || ['ping', 'pong', 'test', '测试', '1'].includes(compact)) {
    return {
      action: 'ping',
      shouldCreateJob: false,
      text,
      replyText: '我在。直接告诉我你想做什么个人网站即可。',
    };
  }

  if (command?.command === 'cancel') {
    return {
      action: 'cancel',
      shouldCreateJob: false,
      text,
      replyText: '收到。如果要结束当前对话，可以说「关闭会话」。',
    };
  }

  if (isExplicitSessionCloseRequest(text, command)) {
    return {
      action: 'close_session',
      shouldCreateJob: false,
      text,
      replyText: '收到，准备关闭当前会话。',
    };
  }

  if (isNaturalSessionCloseRequest(text)) {
    return {
      action: 'close_session',
      shouldCreateJob: false,
      text,
      replyText: '收到，准备关闭当前会话。',
    };
  }

  if (command?.command === 'status') {
    const commandJobId = command.args.match(JOB_ID_RE)?.[0] || null;
    return {
      action: 'diagnose_work_item',
      shouldCreateJob: false,
      text,
      jobId: commandJobId,
      replyText: commandJobId ? null : null,
    };
  }

  if (isNaturalStatusQuery(text)) {
    return {
      action: 'diagnose_work_item',
      shouldCreateJob: false,
      text,
      jobId: text.match(JOB_ID_RE)?.[0] || null,
      replyText: null,
    };
  }

  const workItemReference = parseSlackWorkItemReference(text);

  if (['task', 'tasks', 'pr', 'prs', 'work'].includes(command?.command)) {
    if (workItemReference) {
      return {
        action: 'agent_turn',
        shouldCreateJob: false,
        shouldAnalyze: true,
        text,
        ...explicitWorkItemFields(workItemReference),
        replyText: null,
      };
    }

    const workItemState = slackWorkItemQueryStateFromText(text);
    return {
      action: 'list_work_items',
      shouldCreateJob: false,
      shouldAnalyze: true,
      text,
      workItemState,
      includeInactive: slackWorkItemIncludesInactive(workItemState),
      replyText: null,
    };
  }

  if (['issue', 'page', 'site'].includes(command?.command)) {
    if (!command.args) {
      return {
        action: 'missing_requirement',
        shouldCreateJob: false,
        text,
        replyText: `请在 \`${command.command}:\` 后面写清楚需求，例如 \`${command.command}: 给 smoke/profile 做一个个人主页\`。`,
      };
    }

    return {
      action: 'create_job',
      shouldCreateJob: true,
      text: command.args,
      command: command.command,
    };
  }

  return {
    action: 'agent_turn',
    shouldCreateJob: false,
    shouldAnalyze: true,
    text,
    ...explicitWorkItemFields(workItemReference),
    replyText: unknownText(),
  };
}

export function slackStatusReply(jobId, job) {
  if (!job) {
    return '没有找到对应的发布任务。';
  }

  const lines = ['发布进度', `状态：${job.status}`, `站点：${job.siteSlug || '-'}`];

  if (job.issueNumber) lines.push(`Issue：#${job.issueNumber}`);
  if (job.prNumber) lines.push(`PR：#${job.prNumber}`);
  if (job.previewUrl) lines.push(`Preview：${job.previewUrl}`);
  if (job.errorMessage) lines.push(`错误：${job.errorMessage}`);

  return lines.join('\n');
}
