/**
 * Work tools — claim, update, prove, and complete features.
 */

import type { ManifestClient } from '../client.js';
import { ApiError, ConflictError } from '../client.js';
import { featureWebUrl } from '../format.js';
import { countSpecCriteria, detectEscalation, resolveTier } from '../session.js';
import type {
  CommitRef,
  EvidenceInput,
  Feature,
  FeatureWithContext,
  FeatureProof,
  StartFeatureResponse,
  TestResultInput,
  TestSuiteInput,
  UpdateFeatureInput,
} from '../types.js';

// ============================================================
// start_feature
// ============================================================

interface StartFeatureParams {
  feature_id: string;
  agent_type?: string;
  force?: boolean;
  claim_metadata?: string;
}

interface AssessPlanParams {
  feature_id: string;
  plan: string;
}

export async function handleStartFeature(
  client: ManifestClient,
  params: StartFeatureParams,
): Promise<string> {
  try {
    const result = await client.startFeature(params.feature_id, {
      agent_type: params.agent_type ?? 'claude',
      force: params.force ?? false,
      claim_metadata: params.claim_metadata,
    });
    return formatStartResult(result, client.webUrl);
  } catch (err) {
    if (err instanceof ConflictError) {
      return `Error: ${err.body}`;
    }
    if (err instanceof ApiError) {
      return `Error (${err.status}): ${err.body}`;
    }
    throw err;
  }
}

export async function handleAssessPlan(
  client: ManifestClient,
  params: AssessPlanParams,
): Promise<string> {
  try {
    const feature = await client.getFeatureContext(params.feature_id);
    return formatPlanAssessment(feature, params.plan);
  } catch (err) {
    if (err instanceof ApiError) {
      return `Error (${err.status}): ${err.body}`;
    }
    throw err;
  }
}

function formatStartResult(result: StartFeatureResponse, baseUrl?: string): string {
  if (!result || typeof result !== 'object') return 'Feature started.';

  const parts: string[] = [];

  // Header
  const displayId = result.display_id ?? result.id?.slice(0, 8) ?? '';
  parts.push(`Started: ${displayId} ${result.title ?? ''} (${result.state ?? 'in_progress'})`);
  if (result.feature_tier) parts.push(`Tier: ${result.feature_tier}`);
  const webUrl = baseUrl ? featureWebUrl(baseUrl, result.project_slug, result.display_id) : null;
  if (webUrl) parts.push(`Web: ${webUrl}`);

  // Spec status
  if (result.spec_status) parts.push(`Spec: ${result.spec_status}`);

  // Breadcrumb
  if (result.breadcrumb?.length > 0) {
    const path = result.breadcrumb.map((b) => b.title).join(' > ');
    parts.push(`Path: ${path}`);
  }

  // Details (the spec to implement against)
  if (result.details) {
    parts.push('');
    parts.push('## Specification');
    parts.push(result.details);
  }

  // Desired details (change request)
  if (result.desired_details) {
    parts.push('');
    parts.push('## Requested Changes');
    parts.push(result.desired_details);
  }

  // Spec guidance
  if (result.spec_guidance) {
    parts.push('');
    parts.push('## Spec Guidance');
    parts.push(result.spec_guidance);
  }

  // Testing guidance
  if (result.testing_guidance) {
    parts.push('');
    parts.push('## Testing');
    parts.push(result.testing_guidance);
  }

  // Workflow instructions
  parts.push('');
  parts.push('## Next');
  parts.push('');
  parts.push('Investigate the codebase, then write a numbered plan and call assess_plan.');

  return parts.join('\n');
}

function formatPlanAssessment(feature: FeatureWithContext, planText: string): string {
  const steps = extractPlanSteps(planText);
  const criteriaCount = countSpecCriteria(feature?.details ?? null);
  const escalated = detectEscalation(planText);
  const tier = steps.length === 0
    ? 'full'
    : resolveTier(steps.length, criteriaCount, escalated);

  const displayId = feature?.display_id ?? feature?.id ?? 'unknown';
  const title = feature?.title ?? 'Unknown feature';
  const parts: string[] = [
    `Plan assessment: ${tier}`,
    `Feature: ${displayId} ${title}`,
    `Steps: ${steps.length}`,
    `Unchecked acceptance criteria: ${criteriaCount}`,
    `Escalated: ${escalated ? 'yes ([COMPLEX])' : 'no'}`,
  ];

  if (steps.length === 0) {
    parts.push('');
    parts.push('No numbered implementation steps were detected.');
    parts.push('Write the plan under a `Plan:` header with numbered items, for example:');
    parts.push('');
    parts.push('Plan:');
    parts.push('1. Add or update tests');
    parts.push('2. Implement the change');
    parts.push('3. Record proof and completion state');
    return parts.join('\n');
  }

  parts.push('');
  parts.push('Plan');
  for (const [index, step] of steps.entries()) {
    parts.push(`${index + 1}. ${step}`);
  }

  parts.push('');
  parts.push('Guidance');
  if (tier === 'auto') {
    parts.push('Proceed with implementation. No approval needed.');
  } else if (tier === 'tracked') {
    parts.push('Proceed with implementation. Mark progress with [DONE:n] as you complete each step.');
  } else {
    parts.push('Present this plan to the user for approval before implementing. The scope is large enough to warrant a checkpoint.');
  }

  parts.push('');
  parts.push('Why');
  if (escalated) {
    parts.push('- The plan includes a `[COMPLEX]` escalation marker.');
  }
  if (steps.length >= 6) {
    parts.push(`- The plan has ${steps.length} numbered steps.`);
  } else if (steps.length <= 2 && criteriaCount <= 3 && !escalated) {
    parts.push(`- The plan is small (${steps.length} step${steps.length === 1 ? '' : 's'}) and the spec has limited unchecked scope.`);
  } else {
    parts.push(`- The plan has ${steps.length} numbered steps, which lands in the middle ceremony band.`);
  }
  if (criteriaCount >= 7) {
    parts.push(`- The feature spec still has ${criteriaCount} unchecked acceptance criteria.`);
  } else if (criteriaCount > 0) {
    parts.push(`- The feature spec still has ${criteriaCount} unchecked acceptance criteria.`);
  } else {
    parts.push('- The feature spec does not currently expose unchecked acceptance criteria.');
  }

  return parts.join('\n');
}

function extractPlanSteps(planText: string): string[] {
  const scopedText = extractPlanSection(planText) ?? planText;
  const steps: string[] = [];

  for (const match of scopedText.matchAll(/^\s*(\d+)[.)]\s+(.+)$/gm)) {
    const step = match[2].trim();
    if (step.length > 0) steps.push(step);
  }

  return steps;
}

function extractPlanSection(planText: string): string | null {
  const headerMatch = planText.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
  if (!headerMatch) return null;
  return planText.slice(planText.indexOf(headerMatch[0]) + headerMatch[0].length);
}

// ============================================================
// update_feature
// ============================================================

interface UpdateFeatureParams {
  feature_id: string;
}

export async function handleUpdateFeature(
  client: ManifestClient,
  params: UpdateFeatureParams,
): Promise<string> {
  const { feature_id, ...input } = params;
  try {
    const result: Feature = await client.updateFeature(feature_id, input as UpdateFeatureInput);
    return `Updated '${result.title}' (${result.state})`;
  } catch (err) {
    if (err instanceof ApiError) {
      return `Error (${err.status}): ${err.body}`;
    }
    throw err;
  }
}

// ============================================================
// prove_feature
// ============================================================

interface ProveFeatureParams {
  feature_id: string;
  command: string;
  exit_code: number;
  output?: string;
  test_suites?: TestSuiteInput[];
  tests?: TestResultInput[];
  evidence?: EvidenceInput[];
  commit_sha?: string;
}

export async function handleProveFeature(
  client: ManifestClient,
  params: ProveFeatureParams,
): Promise<string> {
  const { feature_id, ...input } = params;
  try {
    const result: FeatureProof = await client.proveFeature(feature_id, input);
    const status = params.exit_code === 0 ? 'PASS' : 'FAIL';
    return `Proof recorded (${status})\nexit_code: ${params.exit_code}\ncommand: ${params.command}${result?.id ? `\nproof_id: ${result.id}` : ''}`;
  } catch (err) {
    if (err instanceof ApiError) {
      return `Error (${err.status}): ${err.body}`;
    }
    throw err;
  }
}

// ============================================================
// complete_feature
// ============================================================

interface CompleteFeatureParams {
  feature_id: string;
  summary: string;
  commits: (string | CommitRef)[];
  backfill?: boolean;
}

export async function handleCompleteFeature(
  client: ManifestClient,
  params: CompleteFeatureParams,
): Promise<string> {
  try {
    const result: Feature = await client.completeFeature(params.feature_id, {
      summary: params.summary,
      commits: params.commits,
      backfill: params.backfill ?? false,
    });
    const state = result?.state ?? 'implemented';
    return `Feature completed (${state})\nsummary: ${params.summary}`;
  } catch (err) {
    if (err instanceof ApiError) {
      return `Error (${err.status}): ${err.body}`;
    }
    throw err;
  }
}

// ============================================================
// Helpers
// ============================================================

function formatResponse(data: unknown): string {
  if (typeof data === 'string') return data;
  return JSON.stringify(data, null, 2);
}
