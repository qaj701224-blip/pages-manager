import { SLACK_AGENT_POLICY_PACKAGE } from './package.js';
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
      explicitWorkItemReference: input.explicitWorkItemReference || input.explicit_work_item_reference || null,
      issueLinks: compactIssueLinks(input.issueLinks),
      employeeSlugHint: input.employeeSlug || input.employee_slug || null,
      siteSlugHint: input.siteSlug || input.site_slug || null,
    },
    policyVersion: SLACK_AGENT_POLICY_PACKAGE.version,
  };
}
