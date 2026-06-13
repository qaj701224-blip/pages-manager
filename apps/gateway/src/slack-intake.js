const JOB_ID_RE = /\bjob_[A-Za-z0-9_]+\b/;
const SLASH_COMMAND_RE = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;
const TEXT_COMMAND_RE = /^(issue|page|site|status|help|ping|cancel|close)(?::|\s+)?([\s\S]*)?$/i;

export function normalizeSlackIntakeText(text = '') {
  return String(text)
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replace(/^(<@[A-Z0-9]+>\s*)+/, '')
    .trim();
}

function helpText() {
  return [
    '你可以直接用自然语言和我聊个人网站需求，我会先整理清楚，再决定是追问、创建 issue，还是继续修改已有 preview。',
    '',
    '可以这样说：',
    '- `我想做一个个人主页，突出项目经历和技术风格`',
    '- `这个 preview 不满意，把标题改成中文，再加一个项目经历区域`',
    '- `帮我看一下 job_xxx 的状态`',
    '',
    '命令写法仍然支持：',
    '- `issue: 给 smoke/profile 做一个个人主页`',
    '- `status: job_xxx`',
    '',
    '如果信息不够，我会继续问你，不会立刻创建 issue。',
  ].join('\n');
}

function unknownText() {
  return [
    '我收到了，但当前没有可用的 Slack Agent 来理解这轮自然语言，所以先不创建 issue。',
    '',
    '你可以稍后重试，或临时用明确命令：`issue: 给 smoke/profile 做一个个人主页`。',
  ].join('\n');
}

function commandIntent(text) {
  const match = text.match(SLASH_COMMAND_RE) || text.match(TEXT_COMMAND_RE);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    args: (match[2] || '').trim(),
  };
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
      replyText: '我在。可以说 `创建 issue：...` 来创建发布任务，或说 `帮助` 查看示例。',
    };
  }

  if (command?.command === 'cancel' || /^(cancel|取消|停止|不用了)/i.test(text)) {
    return {
      action: 'cancel',
      shouldCreateJob: false,
      text,
      replyText: '收到取消意图。当前 MVP 还没有自动取消 job；如果已经创建了 issue，可以先在 issue 里补充“取消”。',
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
      replyText: commandJobId ? null : '请带上 job id，例如 `status: job_xxx`。',
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
      action: 'create_job',
      shouldCreateJob: true,
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
    return `没有找到发布任务 ${jobId}。`;
  }

  const lines = [`发布任务 ${job.id}`, `状态：${job.status}`, `目标：${job.employeeSlug}/${job.siteSlug}`];

  if (job.issueNumber) lines.push(`Issue：#${job.issueNumber}`);
  if (job.prNumber) lines.push(`PR：#${job.prNumber}`);
  if (job.previewUrl) lines.push(`Preview：${job.previewUrl}`);
  if (job.errorMessage) lines.push(`错误：${job.errorMessage}`);

  return lines.join('\n');
}
