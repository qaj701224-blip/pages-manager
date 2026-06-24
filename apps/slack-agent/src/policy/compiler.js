import { SLACK_AGENT_POLICY_PACKAGE } from './package.js';
import {
  PLATFORM_AREAS,
  PLATFORM_ISSUE_TYPES,
  PLATFORM_RISKS,
  REPEAT_PREVIOUS_MESSAGE_TARGETS,
  SLACK_AGENT_INTENTS,
  SLACK_AGENT_LANES,
  SLACK_AGENT_TOOL_NAMES,
  WORK_ITEM_STATES,
} from './schema.js';
import { selectSlackAgentSkills } from './skills.js';

function compactIssueLinks(issueLinks = []) {
  return (Array.isArray(issueLinks) ? issueLinks : []).slice(0, 5).map((link) => ({
    publishingJobId: link.publishingJobId || null,
    issueNumber: link.issueNumber || null,
    prNumber: link.prNumber || null,
    previewUrl: link.previewUrl || null,
    relationship: link.relationship || null,
  }));
}

function compactConversationContext(context = null) {
  if (!context || typeof context !== 'object') return null;
  return {
    recentTurns: Array.isArray(context.recentTurns) ? context.recentTurns.slice(-10) : [],
    lastAssistantMessage: context.lastAssistantMessage || null,
    focus: context.focus || context.currentFocus || null,
    currentFocus: context.currentFocus || context.focus || null,
    lastWorkItemList: context.lastWorkItemList || null,
  };
}

function renderSkill(skill) {
  return [`## skill:${skill.id} - ${skill.title}`, ...skill.content.map((line) => `- ${line}`)].join('\n');
}

function buildSystemPrompt(selectedSkills = []) {
  const selectedIds = selectedSkills.map((skill) => skill.id);
  return [
    `Policy package: ${SLACK_AGENT_POLICY_PACKAGE.version}`,
    `Available skills: ${SLACK_AGENT_POLICY_PACKAGE.skills.join(', ')}`,
    `Selected runtime skills: ${selectedIds.join(', ')}`,
    '',
    [
      'Use the selected runtime skills as the decision policy for this turn. ',
      'Skills describe semantic intent; gateway remains the permission and side-effect boundary.',
    ].join(''),
    '',
    ...selectedSkills.map(renderSkill),
    '',
    '全局优先级：',
    '先判断危险批量破坏请求、明确关闭会话、复读/上一条、查询/切换/恢复任务、诊断、repo 咨询，再判断已有任务续接，最后才判断新建个人站点或平台需求。',
    [
      '如果用户询问“我的 PR / 我的 issue / 我的任务 / 有几个 / 哪几个 / 还有哪些 / 还没有处理”，',
      'intent 必须返回 list_work_items，不要新建任务，不要续接当前 focus，并设置 toolCall.name=list_my_work_items。',
    ].join(''),
    `list_my_work_items.args.state 只能是 ${WORK_ITEM_STATES.join(' | ')}。查询当前可继续任务用 active；查询历史/全部用 all；查询已关闭/已取消/失败用 closed。`,
    '如果上一轮刚返回任务 / issue / PR 列表，用户追问“只有这一个么 / 还有吗 / 只有这些吗”，继续返回 list_work_items；优先沿用上一轮列表范围，没有范围时用 state=all。',
    '如果用户明确说“继续 PR #数字 / issue #数字 / 切换到 #数字”，intent 返回 switch_work_item，不要新建任务，并设置 toolCall.name=switch_work_item。',
    '如果用户明确说“重新打开 / 恢复 / reopen PR #数字 或 issue #数字”，intent 返回 reopen_work_item，不要新建任务，并设置 toolCall.name=reopen_work_item。',
    [
      '如果用户要求关闭、删除、取消“所有 / 全部 / 我名下 / 我的” GitHub issue、PR 或发布任务，',
      '这是危险批量操作；intent 必须返回 unsupported_destructive_request，不要返回 list_work_items，不要假装已执行。',
    ].join(''),
    '关闭 Slack 会话只适用于“关闭会话 / 结束对话 / 这个 preview 不用了”这类当前上下文操作；不要把“关闭所有 issue”理解为 close_session。',
    '如果用户是在已有任务上补充“这个 issue / 接着改 / 改为 / 不再修改 X / 换成 Y”，优先 record_followup，不要新建 issue。',
    [
      `issueType 只能是 ${PLATFORM_ISSUE_TYPES.join(' | ')}；`,
      `risk 只能是 ${PLATFORM_RISKS.join(' | ')}；areas 常用值：${PLATFORM_AREAS.join(', ')}。`,
    ].join(''),
    '',
    'Tool contract：',
    `toolCall.name 只能使用：${SLACK_AGENT_TOOL_NAMES.join(', ')}。`,
    `repeat_previous_message.args.target 只能是 ${REPEAT_PREVIOUS_MESSAGE_TARGETS.join(' | ')}。`,
    '',
    '输出合同：',
    `lane 只能是：${SLACK_AGENT_LANES.join(' | ')}。`,
    `intent 常用值：${SLACK_AGENT_INTENTS.join(', ')}。`,
    [
      'JSON 字段：visibleReply, dialogAct, lane, intent, toolCall, workItemState, focus, card, confirmationRequirement,',
      'employeeSlug, siteSlug, issueType, areas, risk, agentEligible, requiresHumanGate, title, summary, approvalMode,',
      'needsClarification, clarifyingQuestion, contextResolution, sourceMessages。',
    ].join(' '),
    'dialogAct 只能是 answer、ask_clarification、request_confirmation、run_tool、deny、handoff；需要按钮确认时使用 request_confirmation。',
    [
      'confirmationRequirement 只能是 none、create_site_issue、create_platform_issue、continue_work_item、',
      'retry_work_item、append_diagnosis_to_issue、human_triage、reopen_work_item。',
    ].join(''),
    'card 是可选卡片意图，只描述 kind/title/summary/fields/actions，不要输出 Slack Block Kit。',
  ].join('\n');
}

export function compileSlackAgentPolicy(input = {}, fallbackAnalysis, sessionContext) {
  const selectedSkills = selectSlackAgentSkills(input, fallbackAnalysis, sessionContext);
  return {
    system: buildSystemPrompt(selectedSkills),
    userPayload: {
      slackText: input.text || input.event?.text || '',
      fallbackAnalysis,
      sessionContext,
      selectedSkills: selectedSkills.map((skill) => skill.id),
      sessionMemory: input.sessionMemory || null,
      conversationContext: compactConversationContext(
        input.conversationContext || input.sessionMemory?.conversationContext || null
      ),
      issueLinks: compactIssueLinks(input.issueLinks),
      employeeSlugHint: input.employeeSlug || input.employee_slug || null,
      siteSlugHint: input.siteSlug || input.site_slug || null,
    },
    policyVersion: SLACK_AGENT_POLICY_PACKAGE.version,
  };
}
