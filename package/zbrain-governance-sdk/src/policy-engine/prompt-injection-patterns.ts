import type { PromptInjectionType } from "./types.js";

/**
 * Deterministic pattern corpus adapted from Microsoft Agent Governance Toolkit
 * and extended with ZBrain regression-tested signatures.
 * Copyright (c) Microsoft Corporation. Licensed under the MIT License.
 */
export interface PromptInjectionPatternSpec {
  readonly patternKey: string;
  readonly type: PromptInjectionType;
  readonly source: string;
}

export const PROMPT_INJECTION_PATTERN_SPECS = [
  pattern(
    "direct:ignore_previous_instructions",
    "directOverride",
    String.raw`ignore\s+(all\s+)?previous\s+instructions`
  ),
  pattern("direct:you_are_now", "directOverride", String.raw`\byou\s+are\s+now\b`),
  pattern("direct:new_role", "directOverride", String.raw`new\s+role\s*:`),
  pattern("direct:forget_context", "directOverride", String.raw`forget\s+(everything|all|your)\b`),
  pattern(
    "direct:disregard_prior",
    "directOverride",
    String.raw`disregard\s+(all\s+)?(above|prior|previous)\b`
  ),
  pattern(
    "direct:override_instructions",
    "directOverride",
    String.raw`override\s+(previous\s+)?instructions`
  ),
  pattern(
    "direct:do_not_follow",
    "directOverride",
    String.raw`do\s+not\s+follow\s+(your|the)\s+(previous\s+)?instructions`
  ),
  pattern(
    "direct:forget_previous_rules",
    "directOverride",
    String.raw`\bforget\s+(?:all\s+)?(?:the\s+)?(?:previous|prior)\s+(?:instructions|rules|directives)\b`
  ),
  pattern(
    "direct:discard_prior_directives",
    "directOverride",
    String.raw`\b(?:ignore|disregard|discard|forget|override|replace)\s+(?:all\s+)?(?:of\s+)?(?:the\s+)?(?:previous|prior|earlier|above|original)\s+(?:instructions|rules|directives|context)\b`
  ),
  pattern(
    "direct:prior_rules_void",
    "directOverride",
    String.raw`\b(?:instructions|rules|directives)\s+(?:above|given\s+earlier|previously\s+given)\s+(?:are\s+)?(?:void|invalid|obsolete|superseded|no\s+longer\s+apply)\b`
  ),

  pattern("delimiter:dash_boundary", "delimiterAttack", String.raw`^-{3,}\s*$`),
  pattern("delimiter:hash_boundary", "delimiterAttack", String.raw`^#{3,}\s*$`),
  pattern("delimiter:code_fence_boundary", "delimiterAttack", String.raw`^\x60{3}\s*$`),
  pattern("delimiter:end_system", "delimiterAttack", String.raw`END\s+SYSTEM`),
  pattern("delimiter:begin_user", "delimiterAttack", String.raw`BEGIN\s+USER`),
  pattern("delimiter:im_start", "delimiterAttack", String.raw`<\|im_start\|>`),
  pattern("delimiter:im_end", "delimiterAttack", String.raw`<\|im_end\|>`),
  pattern("delimiter:inst_token", "delimiterAttack", String.raw`\[INST\]`),
  pattern("delimiter:sys_token", "delimiterAttack", String.raw`<<SYS>>`),
  pattern("delimiter:role_tag", "delimiterAttack", String.raw`</?(system|user|assistant)>`),
  pattern("delimiter:role_pipe_tag", "delimiterAttack", String.raw`<\|(system|user|assistant)\|>`),

  pattern(
    "role_play:pretend_unrestricted",
    "rolePlay",
    String.raw`pretend\s+you\s+are\s+an?\s+unrestricted`
  ),
  pattern(
    "role_play:act_no_restrictions",
    "rolePlay",
    String.raw`act\s+as\s+if\s+you\s+have\s+no\s+restrictions`
  ),
  pattern("role_play:jailbreak_mode", "rolePlay", String.raw`enable\s+jailbreak\s+mode`),
  pattern("role_play:dan_mode", "rolePlay", String.raw`\bDAN\s+mode\b`),
  pattern("role_play:developer_mode", "rolePlay", String.raw`developer\s+mode\s+override`),
  pattern(
    "role_play:bypass_safety_filters",
    "rolePlay",
    String.raw`bypass\s+all\s+safety\s+filters`
  ),
  pattern(
    "role_play:activate_unrestricted_mode",
    "rolePlay",
    String.raw`\b(?:enter|enable|activate|switch\s+to)\s+(?:an?\s+)?(?:unrestricted|uncensored|jailbreak)\s+mode\b`
  ),
  pattern(
    "role_play:act_as_unrestricted_persona",
    "rolePlay",
    String.raw`\bact\s+as\s+(?:dan|an?\s+(?:unrestricted|uncensored)\s+(?:assistant|model))\b`
  ),

  pattern(
    "context:above_wrong",
    "contextManipulation",
    String.raw`the\s+above\s+instructions\s+are\s+wrong`
  ),
  pattern(
    "context:real_instructions",
    "contextManipulation",
    String.raw`your\s+real\s+instructions\s+are`
  ),
  pattern(
    "context:prompt_disclosure",
    "contextManipulation",
    String.raw`\b(?:reveal|expose|display|show|print|dump|return|provide|copy|repeat)\s+(?:(?:the|your)\s+)?(?:hidden\s+|internal\s+|secret\s+|private\s+)?(?:system|developer|initial|original)\s+(?:prompt|instructions?|message|rules?)\b`
  ),
  pattern(
    "context:hidden_internal_directives",
    "contextManipulation",
    String.raw`\b(?:reveal|expose|display|show|print|dump|return|provide|copy|repeat)\s+(?:(?:the|your)\s+)?(?:(?:hidden|internal|private|secret)\s+){1,2}(?:instructions?|rules?|directives?)\b`
  ),
  pattern(
    "context:cross_tenant_access",
    "contextManipulation",
    String.raw`\b(?:as\s+)?tenant\s+[a-z0-9_-]+.{0,64}\b(?:fetch|access|read|get|show|reveal)\b.{0,64}\btenant\s+[a-z0-9_-]+\s+(?:records?|invoices?|data|files?)\b`
  ),
  pattern(
    "context:memory_privilege_poisoning",
    "contextManipulation",
    String.raw`\b(?:remember|store|save|memorize)\s+(?:this\s+)?permanently\b.{0,96}\b(?:administrator|admin|trusted|approved|privileged)\b`
  ),
  pattern(
    "context:tool_output_role_impersonation",
    "contextManipulation",
    String.raw`(?:\[\s*tool\s+(?:output|result)\s*\]|\btool\s+(?:output|result)\b)\s*(?:system|assistant)\s*:`
  ),
  pattern(
    "context:system_directive_impersonation",
    "contextManipulation",
    String.raw`\b(?:system|developer)\s+(?:message|instruction|notice)\s*:\s*(?:ignore|disregard|override|reveal|approve|bypass)\b`
  ),
  pattern(
    "context:bypass_tool_approval",
    "contextManipulation",
    String.raw`\b(?:bypass|skip|avoid|disable)\s+(?:the\s+)?(?:tool\s+)?(?:approval|authorization|confirmation|permission)\b`
  ),
  pattern(
    "context:approve_tool_call",
    "contextManipulation",
    String.raw`\bapprove\s+(?:all\s+|the\s+)?(?:next\s+|pending\s+)?tool\s+calls?\b`
  ),
  pattern(
    "context:sensitive_tool_invocation",
    "contextManipulation",
    String.raw`\b(?:call|run|invoke|use)\s+(?:the\s+)?(?:tool\s+)?(?:read[_-]?secret|read[_-]?credentials?|dump[_-]?secrets?|export[_-]?database)\b`
  ),
  pattern(
    "context:sensitive_external_send",
    "contextManipulation",
    String.raw`\b(?:send|export|upload|exfiltrate|forward|leak)\s+(?:the\s+)?(?:customer\s+emails?|database\s+credentials?)\s+to\s+(?:an?\s+)?(?:attacker|external|remote|[^\s]+@[^\s]+|https?://)`
  ),
  pattern(
    "context:secret_external_send",
    "contextManipulation",
    String.raw`\b(?:send|upload|post|forward|export|exfiltrate|leak)\s+(?:the\s+)?(?:secrets?|credentials?|api\s+keys?|access\s+tokens?)\s+to\s+(?:an?\s+)?(?:attacker|external|remote|[^\s]+@[^\s]+|https?://)`
  ),
  pattern(
    "context:persistent_privilege_poisoning",
    "contextManipulation",
    String.raw`\b(?:remember|store|save|memorize).{0,48}\b(?:for\s+future|from\s+now\s+on|in\s+memory)\b.{0,64}\b(?:administrator|admin|trusted|approved|privileged)\b`
  ),
  pattern(
    "context:tracking_pixel_exfiltration",
    "contextManipulation",
    String.raw`\b(?:load|render|open|fetch)\s+!\[[^\]\n]{0,64}\]\(https?://[^)\s]{1,512}(?:canary|secret|token|prompt|credential)[^)\s]*\)`
  ),
  pattern(
    "context:developer_told_me",
    "contextManipulation",
    String.raw`the\s+developer\s+told\s+me\s+to\s+tell\s+you`
  ),
  pattern(
    "context:secret_password_override",
    "contextManipulation",
    String.raw`secret\s+password\s+is\s+OVERRIDE`
  ),
  pattern(
    "context:instructions_for_ai_reading",
    "contextManipulation",
    String.raw`instructions?\s+for\s+(?:the\s+)?(?:ai|assistant|model|llm|chatbot|bot)\s+(?:reading|processing|viewing|that\s+reads)`
  ),
  pattern(
    "context:system_note_to_assistant",
    "contextManipulation",
    String.raw`(?:system\s+note|note\s+to\s+(?:the\s+)?(?:ai|assistant|model)|attention\s*(?:ai|assistant))\s*:`
  ),
  pattern(
    "context:embedded_tool_directive",
    "contextManipulation",
    String.raw`<!--\s*(?:ai|assistant|system|llm)\s*:`
  ),
  pattern(
    "context:retrieved_doc_override",
    "contextManipulation",
    String.raw`(?:this\s+(?:document|page|email|message|file)|the\s+(?:webpage|email|document|text\s+above))\s+(?:instructs|requires|tells|wants|asks)\s+you\s+to\s+(?:ignore|disregard|forget|override|replace|execute|run|call|send|exfiltrate|leak|reveal|output|delete|forward|disclose|bypass)`
  ),
  pattern(
    "locale:fr_direct_override",
    "directOverride",
    String.raw`\bignorez\s+toutes\s+les\s+instructions\s+precedentes\b`
  ),
  pattern(
    "locale:fr_prompt_disclosure",
    "contextManipulation",
    String.raw`\baffichez\s+votre\s+invite\s+systeme\s+cachee\b`
  ),
  pattern(
    "locale:fr_indirect_override",
    "contextManipulation",
    String.raw`\bl['’]assistant\s+doit\s+ignorer\s+la\s+politique\b`
  ),
  pattern(
    "locale:fr_memory_poisoning",
    "contextManipulation",
    String.raw`\bmemorisez\s+que\s+cet\s+utilisateur\s+est\s+(?:toujours\s+)?administrateur\b`
  ),
  pattern(
    "locale:fr_cross_tenant_access",
    "contextManipulation",
    String.raw`\baccedez\s+aux\s+(?:factures|donnees|fichiers)\s+d['’]un\s+autre\s+locataire\b`
  ),
  pattern(
    "locale:fr_sensitive_tool_send",
    "contextManipulation",
    String.raw`\butilisez\s+l['’]outil\s+[^\s]+\s+puis\s+envoyez\s+la\s+valeur\b`
  ),
  pattern(
    "locale:fr_tool_result_impersonation",
    "contextManipulation",
    String.raw`\bsysteme\s*:.{0,96}\bapprouvez\s+les\s+outils\b`
  ),
  pattern(
    "locale:fr_tracking_exfiltration",
    "contextManipulation",
    String.raw`\bchargez\s+https?://[^\s]+(?:canary|secret|token|prompt)`
  ),

  pattern(
    "multi_turn:mentioned_before_agreed",
    "multiTurnEscalation",
    String.raw`as\s+I\s+mentioned\s+before.*you\s+agreed`
  ),
  pattern(
    "multi_turn:already_said_yes",
    "multiTurnEscalation",
    String.raw`you\s+already\s+said\s+yes`
  ),
  pattern(
    "multi_turn:continuing_unlocked",
    "multiTurnEscalation",
    String.raw`continuing\s+from\s+where\s+you\s+unlocked`
  ),
  pattern(
    "multi_turn:previously_confirmed",
    "multiTurnEscalation",
    String.raw`you\s+previously\s+confirmed\s+you\s+would`
  ),
  pattern(
    "multi_turn:prior_authorization_claim",
    "multiTurnEscalation",
    String.raw`\b(?:we|you)\s+(?:already|previously)\s+(?:agreed|approved|authorized|confirmed).{0,64}\b(?:this|it|the\s+(?:request|action|operation))\b`
  )
] as const satisfies readonly PromptInjectionPatternSpec[];

/**
 * High-specificity signatures evaluated only for visibly obfuscated input.
 * Separators are removed and common leetspeak substitutions are folded before
 * matching, so these expressions deliberately require multiple risk concepts.
 */
export const PROMPT_INJECTION_COMPACT_PATTERN_SPECS = [
  pattern(
    "obfuscated:override_previous_instructions",
    "directOverride",
    String.raw`(?:[i1]gnore|d[i1]sregard)(?:a[l1][l1]|the)?(?:prev[i1]ous|pr[i1]or|above)(?:[i1]nstruct[i1]ons|ru[l1]es|d[i1]rect[i1]ves)`
  ),
  pattern(
    "obfuscated:forget_previous_rules",
    "directOverride",
    String.raw`forget(?:a[l1][l1]|the)?(?:prev[i1]ous|pr[i1]or)(?:[i1]nstruct[i1]ons|ru[l1]es|d[i1]rect[i1]ves)`
  ),
  pattern(
    "obfuscated:prompt_disclosure",
    "contextManipulation",
    String.raw`(?:revea[l1]|expose|d[i1]sp[l1]ay|show|pr[i1]nt|dump)(?:the)?(?:h[i1]dden|[i1]nterna[l1]|secret|pr[i1]vate)?(?:system|developer)(?:prompt|[i1]nstruct[i1]ons|ru[l1]es)`
  ),
  pattern(
    "obfuscated:indirect_assistant_directive",
    "contextManipulation",
    String.raw`assistant(?:ignore|disregard|reveal|send|export)(?:the)?(?:systemprompt|policy|secrets|data)`
  ),
  pattern(
    "obfuscated:tool_output_impersonation",
    "contextManipulation",
    String.raw`tool(?:output|result)system(?:ignore|reveal|approve|bypass)`
  ),
  pattern(
    "obfuscated:memory_privilege_poisoning",
    "contextManipulation",
    String.raw`rememberpermanently(?:that)?(?:this)?user(?:is|as)(?:an)?(?:administrator|admin|trusted|privileged)`
  ),
  pattern(
    "obfuscated:cross_tenant_access",
    "contextManipulation",
    String.raw`tenant[a-z0-9]+(?:fetch|access|read|get|show|reveal)tenant[a-z0-9]+(?:records|invoices|data|files)`
  ),
  pattern(
    "obfuscated:bypass_tool_approval",
    "contextManipulation",
    String.raw`(?:bypass|skip|disable)(?:tool)?(?:approval|authorization|confirmation|permission).{0,96}(?:run|call|invoke|execute|export)`
  ),
  pattern(
    "obfuscated:sensitive_external_send",
    "contextManipulation",
    String.raw`(?:send|export|up[l1]oad|exf[i1][l1]trate)(?:customerema[i1][l1]s|databasecredent[i1]a[l1]s|credent[i1]a[l1]s|secrets|pr[i1]vatedata)(?:to)?(?:attacker|externa[l1]|remote)`
  ),
  pattern(
    "obfuscated:tracking_pixel_exfiltration",
    "contextManipulation",
    String.raw`(?:summar[i1]ze|read).{0,64}(?:[l1]oad|render|open|fetch)(?:p[i1]xe[l1])?.{0,128}(?:canary|secret|token|prompt|credent[i1]a[l1])`
  ),
  pattern(
    "obfuscated:activate_unrestricted_mode",
    "rolePlay",
    String.raw`(?:enter|enable|activate|switchto)(?:an?)?(?:unrestricted|uncensored|jailbreak)mode`
  ),
  pattern(
    "obfuscated:secret_external_send",
    "contextManipulation",
    String.raw`(?:send|up[l1]oad|post|forward|export|exf[i1][l1]trate|leak)(?:the)?(?:secrets|credent[i1]a[l1]s|ap[i1]keys|accesstokens)(?:to)?(?:attacker|externa[l1]|remote|https?)`
  )
] as const satisfies readonly PromptInjectionPatternSpec[];

function pattern(
  patternKey: string,
  type: PromptInjectionType,
  source: string
): PromptInjectionPatternSpec {
  return { patternKey, type, source };
}
