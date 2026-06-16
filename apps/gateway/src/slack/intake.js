import { slackWorkItemIncludesInactive, slackWorkItemQueryStateFromText } from './work-item-query.js';

const JOB_ID_RE = /\bjob_[A-Za-z0-9_]+\b/;
const ISSUE_NUMBER_RE = /(?:issue|issues|需求|任务)\s*#?\s*(\d{1,8})\b/i;
const PR_NUMBER_RE = /\b(?:PR|pull\s*request|pull-request|pullrequest)\s*#?\s*(\d{1,8})\b/i;
const BARE_WORK_ITEM_NUMBER_RE = /#(\d{1,8})\b/;
const SLASH_COMMAND_RE = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;
const TEXT_COMMAND_RE = /^(issue|page|site|status|help|ping|cancel|close|tasks?|prs?|work)(?::|\s+)?([\s\S]*)?$/i;
const UNSUPPORTED_BULK_DESTRUCTIVE_RE = new RegExp(
  [
    '(?:关闭|关掉|删除|删掉|清理|清空|取消|归档|close|delete|remove|cancel|archive).*(?:全部|所有|我名下|我的|all|every).*(?:issues?|PR|pr|任务|发布任务)',
    '(?:全部|所有|我名下|我的|all|every).*(?:issues?|PR|pr|任务|发布任务).*(?:关闭|关掉|删除|删掉|清理|清空|取消|归档|close|delete|remove|cancel|archive)',
  ].join('|'),
  'i'
);

export function isUnsupportedBulkDestructiveRequest(text = '') {
  return UNSUPPORTED_BULK_DESTRUCTIVE_RE.test(String(text || ''));
}

export function isWorkItemHistoryQuery(text = '') {
  return slackWorkItemIncludesInactive(slackWorkItemQueryStateFromText(text));
}

function unsupportedBulkDestructiveReply() {
  return '我不能批量关闭或删除你名下的 GitHub issue / PR / 发布任务。为了避免误操作，请先说「我的 PR」查看可继续任务，或明确指定一个 PR / issue 再处理。';
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
  const match = text.match(SLASH_COMMAND_RE) || text.match(TEXT_COMMAND_RE);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    args: (match[2] || '').trim(),
  };
}

export function parseSlackPrNumber(text = '') {
  const match = String(text || '').match(PR_NUMBER_RE);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function parseSlackWorkItemReference(text = '') {
  const value = String(text || '');
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

export function classifySlackIntake(body) {
  const event = body.event || {};
  const text = normalizeSlackIntakeText(event.text || body.text || '');
  const compact = text.toLowerCase();
  const jobId = text.match(JOB_ID_RE)?.[0] || null;
  const command = commandIntent(text);

  if (!text) {
    return {
      action: 'empty',
      shouldCreateJob: false,
      text,
      replyText: '我收到了空消息。可以说 `帮助` 看看我支持什么。',
    };
  }

  if (command?.command === 'help' || /^(help|帮助|菜单|\?|怎么用|说明)$/.test(compact) || /怎么用|能做什么|帮助/.test(text)) {
    return {
      action: 'help',
      shouldCreateJob: false,
      text,
      replyText: helpText(),
    };
  }

  if (command?.command === 'ping' || /^(ping|pong|test|测试|1)$/.test(compact) || /连通性/i.test(text)) {
    return {
      action: 'ping',
      shouldCreateJob: false,
      text,
      replyText: '我在。直接告诉我你想做什么个人网站即可。',
    };
  }

  if (isUnsupportedBulkDestructiveRequest(text)) {
    return {
      action: 'unsupported_destructive_request',
      shouldCreateJob: false,
      shouldAnalyze: false,
      text,
      replyText: unsupportedBulkDestructiveReply(),
    };
  }

  if (command?.command === 'cancel' || /^(cancel|取消|停止|不用了)/i.test(text)) {
    return {
      action: 'cancel',
      shouldCreateJob: false,
      text,
      replyText: '收到。如果要结束当前对话，可以说「关闭会话」。',
    };
  }

  if (
    command?.command === 'close' ||
    /^(close|关闭|结束|归档)(\s|:|：|$)/i.test(text) ||
    /^(关闭|结束).*(会话|对话|session|任务|preview|预览)/i.test(text) ||
    /^(先到这里|到这里就好|这个任务不用了|这个 preview 不用了)$/i.test(text)
  ) {
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
      action: 'status',
      shouldCreateJob: false,
      text,
      jobId: commandJobId,
      replyText: commandJobId ? null : null,
    };
  }

  const workItemReference = parseSlackWorkItemReference(text);
  if (workItemReference && /(继续|接着|切换|选择|打开|查看|回到|续上|处理|修改)/i.test(text)) {
    return {
      action: 'switch_work_item',
      shouldCreateJob: false,
      shouldAnalyze: true,
      text,
      targetKind: workItemReference.kind,
      targetNumber: workItemReference.number,
      prNumber: workItemReference.kind === 'issue' ? null : workItemReference.number,
      issueNumber: workItemReference.kind === 'issue' ? workItemReference.number : null,
      replyText: null,
    };
  }

  if (
    ['task', 'tasks', 'pr', 'prs', 'work'].includes(command?.command) ||
    /^(我的|查看|看看|列出|查询).*(PR|pr|任务|发布任务|网站|项目)/i.test(text) ||
    /^(当前|目前|现在)?.*我的.*(PR|pr|任务|发布任务|网站|项目).*(几个|多少|列表|清单|有哪些|有几个)?/i.test(text) ||
    /^(PR|pr|任务|发布任务|网站|项目)(列表|清单)$/i.test(text)
  ) {
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

  if (jobId && /(status|状态|进度|查询|查看|看一下)/i.test(text)) {
    return {
      action: 'status',
      shouldCreateJob: false,
      text,
      jobId,
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

  if (
    /(创建|新建|提(一个)?|开(一个)?).*(issue|任务|需求)/i.test(text) ||
    /(创建|新建|生成|制作|做|更新|修改).*(页面|网页|网站|主页|profile|portfolio)/i.test(text) ||
    /(帮我|请帮我).*(做|建|创建|生成|更新|修改)/i.test(text) ||
    /\b(create|build|make|update|publish|deploy)\b/i.test(text)
  ) {
    return {
      action: 'agent_turn',
      shouldCreateJob: false,
      shouldAnalyze: true,
      text,
    };
  }

  return {
    action: 'agent_turn',
    shouldCreateJob: false,
    shouldAnalyze: true,
    text,
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
