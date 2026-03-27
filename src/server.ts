/**
 * Manifest MCP Server
 *
 * Registers tools with zod schemas, delegates to pure handler functions.
 * Includes session-scoped workflow state tracking (Layer 1) that appends
 * advisory warnings to tool results. Non-Claude clients are unaffected.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ManifestClient, type ManifestClientConfig } from './client.js';
import {
  handleListProjects,
  handleFindFeatures,
  handleGetFeature,
  handleGetTemplate,
  handleGetNextFeature,
  handleRenderFeatureTree,
  handleOrient,
} from './tools/discovery.js';
import {
  handleStartFeature,
  handleAssessPlan,
  handleUpdateFeature,
  handleProveFeature,
  handleCompleteFeature,
} from './tools/work.js';
import {
  handleInitProject,
  handleAddProjectDirectory,
  handleCreateFeature,
  handleDeleteFeature,
  handlePlan,
  handleGetProjectHistory,
  handleSync,
} from './tools/setup.js';
import {
  handleListVersions,
  handleCreateVersion,
  handleSetFeatureVersion,
  handleReleaseVersion,
} from './tools/versions.js';
import {
  handleVerifyFeature,
  handleRecordVerification,
  handleGetFeatureProof,
} from './tools/verification.js';
import {
  handlePlanTeam,
  handleGetSpawnContext,
} from './tools/teams.js';
import type { ProposedFeature } from './types.js';
import { MANIFEST_INSTRUCTIONS } from './generated/instructions.js';
import { WorkflowState, evaluateCompletionGates } from './session.js';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function appendWarnings(text: string, warnings: string[]): string {
  if (warnings.length === 0) return text;
  return text + '\n\n--- Workflow Notice ---\n' + warnings.join('\n');
}

// ============================================================
// Shared zod fragments
// ============================================================

const FeatureStateEnum = z.enum(['proposed', 'blocked', 'in_progress', 'implemented', 'archived']);
const MutableFeatureStateEnum = z.enum(['proposed', 'blocked', 'in_progress', 'archived']);
const TestStateEnum = z.enum(['passed', 'failed', 'errored', 'skipped']);
const AgentTypeEnum = z.enum(['claude', 'gemini', 'codex', 'pi', 'copilot']);
const SeverityEnum = z.enum(['critical', 'major', 'minor']);

// Recursive type for plan features
const ProposedFeatureSchema: z.ZodType<ProposedFeature> = z.lazy(() =>
  z.object({
    title: z.string().describe('Feature capability name'),
    details: z.string().optional().describe('Leaf: user story + context + acceptance criteria checkboxes (see Spec Format). Parent: shared architectural context.'),
    priority: z.number().describe('Priority (lower = first)'),
    state: FeatureStateEnum.optional().describe("Initial state. Default 'proposed'."),
    children: z.array(ProposedFeatureSchema),
  }) as z.ZodType<ProposedFeature>,
);

// ============================================================
// createServer
// ============================================================

export function createServer(config?: ManifestClientConfig): McpServer {
  const client = new ManifestClient(config);
  const enableSessionState = config?.enableSessionState !== false;
  const session = enableSessionState ? new WorkflowState() : null;

  const server = new McpServer(
    { name: 'manifest', version: '0.1.0' },
    { instructions: MANIFEST_INSTRUCTIONS },
  );

  // ----------------------------------------------------------
  // Discovery Tools (8)
  // ----------------------------------------------------------

  server.tool(
    'list_projects',
    'List projects. If directory_path is provided, finds the project containing that directory.',
    {
      directory_path: z.string().optional().describe('Directory path to find the project for (auto-discovery)'),
    },
    async (params) => textResult(await handleListProjects(client, params)),
  );

  server.tool(
    'find_features',
    'Find features by project, state, or search query. Returns summaries only.',
    {
      project_id: z.string().optional().describe('Project UUID to filter by'),
      version_id: z.string().optional().describe('Version UUID to filter by'),
      state: FeatureStateEnum.optional().describe('State filter'),
      query: z.string().optional().describe('Search query for title and details'),
      limit: z.number().optional().describe('Max results to return'),
      offset: z.number().optional().describe('Number to skip for pagination'),
    },
    async (params) => textResult(await handleFindFeatures(client, params)),
  );

  server.tool(
    'get_feature',
    "Get feature spec. Default 'card' view is a compact pre-formatted card. Use 'full' for breadcrumb context, siblings, and optional history.",
    {
      feature_id: z.string().describe('Feature UUID or display ID (e.g., MAN-42)'),
      view: z.enum(['card', 'full']).optional().describe("View mode. 'card' (default) is a compact pre-formatted card. 'full' includes breadcrumb context, siblings, and optional history."),
      include_history: z.boolean().optional().describe('Include implementation history (full view only). Default false.'),
    },
    async (params) => textResult(await handleGetFeature(client, params)),
  );

  server.tool(
    'get_next_feature',
    "Get the highest-priority workable feature. Use ONLY when the user says \"next feature\" or \"what's next\".",
    {
      project_id: z.string().optional().describe('Project UUID'),
      directory_path: z.string().optional().describe('Directory path for auto-discovery (alternative to project_id)'),
      version_id: z.string().optional().describe('Optional version UUID to filter by'),
    },
    async (params) => textResult(await handleGetNextFeature(client, params)),
  );

  server.tool(
    'render_feature_tree',
    'Render the feature tree as ASCII art with state symbols. Optionally filter by leaf state.',
    {
      project_id: z.string().optional().describe('Project UUID'),
      directory_path: z.string().optional().describe('Directory path for auto-discovery (alternative to project_id)'),
      max_depth: z.number().optional().describe('Max depth (0 = unlimited). Default 0.'),
      state: FeatureStateEnum.optional().describe('Filter tree to branches containing leaves in this state'),
    },
    async (params) => textResult(await handleRenderFeatureTree(client, params)),
  );

  server.tool(
    'orient',
    'Session bootloader. Returns project overview: feature tree (depth 2), work queue, recent activity. Call at session start.',
    {
      project_id: z.string().optional().describe('Project UUID (optional if directory_path provided)'),
      directory_path: z.string().optional().describe('Directory path to auto-discover project'),
    },
    async (params) => textResult(await handleOrient(client, params)),
  );

  server.tool(
    'get_template',
    "Get the project's spec template for writing feature details. Fetch before writing specs in decompose or update_feature.",
    {
      project_id: z.string().describe('Project UUID'),
    },
    async (params) => textResult(await handleGetTemplate(client, params)),
  );

  // ----------------------------------------------------------
  // Work Tools (5)
  // ----------------------------------------------------------

  server.tool(
    'start_feature',
    'Transitions to in_progress and records your claim. Returns the spec to implement against.',
    {
      feature_id: z.string().describe('Feature UUID or display ID'),
      agent_type: AgentTypeEnum.optional().describe("Agent type. Defaults to 'claude'."),
      force: z.boolean().optional().describe('Force start even if claimed. Default false.'),
      claim_metadata: z.string().optional().describe('JSON metadata (branch, worktree, etc.)'),
    },
    async (params) => {
      const result = await handleStartFeature(client, params);
      if (session && !result.startsWith('Error')) {
        session.featureStarted(params.feature_id);
        // Hydrate proof state from API (handles re-claims of previously proved features)
        try {
          const proof = await client.getFeatureProof(params.feature_id);
          if (proof && (proof as { exit_code?: number }).exit_code === 0) {
            session.featureProved(params.feature_id);
          }
        } catch { /* No proof yet -- normal */ }
      }
      return textResult(result);
    },
  );

  server.tool(
    'assess_plan',
    'Assess a numbered implementation plan for a feature and return a graded ceremony tier: auto, tracked, or full. Call this after start_feature with your implementation plan. Returns a ceremony tier (auto/tracked/full) that determines whether to proceed directly or pause for approval.',
    {
      feature_id: z.string().describe('Feature UUID or display ID'),
      plan: z.string().describe('Implementation plan text. Prefer a `Plan:` header followed by numbered steps. Include `[COMPLEX]` to escalate.'),
    },
    async (params) => {
      const result = await handleAssessPlan(client, params);
      if (session && !result.startsWith('Error')) {
        session.advanceToImplement(params.feature_id);
      }
      return textResult(result);
    },
  );

  server.tool(
    'update_feature',
    'Update any feature field: title, details, state, priority, parent, version. Call before complete_feature to document what was built. The spec must be updated after starting work.',
    {
      feature_id: z.string().describe('Feature UUID or display ID'),
      title: z.string().optional().describe('New title'),
      details: z.string().optional().describe('New details/spec'),
      desired_details: z.string().optional().describe('Proposed changes for human review'),
      details_summary: z.string().optional().describe('Short summary for root features'),
      state: MutableFeatureStateEnum.optional().describe('New state'),
      priority: z.number().optional().describe('Priority (lower = first)'),
      parent_id: z.string().optional().describe('Move to different parent UUID'),
      target_version_id: z.string().optional().describe('Assign to version UUID'),
      clear_version: z.boolean().optional().describe('Unassign from version'),
      blocked_by: z.array(z.string()).optional().describe('Feature IDs that block this'),
    },
    async (params) => {
      const result = await handleUpdateFeature(client, params);
      if (session && !result.startsWith('Error') && 'details' in params && params.details) {
        session.featureSpecUpdated(params.feature_id);
      }
      return textResult(result);
    },
  );

  server.tool(
    'prove_feature',
    'Record test evidence for a feature. Call after implementation. Tests must pass (exit_code 0) before you can complete the feature. IMPORTANT: Parse test output into individual test entries (one per test case). Use verbose flags (rspec --format documentation, pytest -v, go test -v) to get parseable output. Never collapse multiple tests into one entry.',
    {
      feature_id: z.string().describe('Feature UUID or display ID'),
      command: z.string().describe("Test command run (e.g., 'vitest run')"),
      exit_code: z.number().describe('Process exit code (0 = pass)'),
      output: z.string().optional().describe('Raw stdout/stderr (max 10K chars)'),
      test_suites: z.array(z.object({
        name: z.string().describe('Suite name'),
        file: z.string().optional().describe('Source file path'),
        tests: z.array(z.object({
          name: z.string().describe('Test name'),
          state: TestStateEnum.describe('Test result state'),
          file: z.string().optional(),
          line: z.number().optional(),
          duration_ms: z.number().optional(),
          message: z.string().optional(),
        })),
      })).optional().describe('Structured test results grouped by suite (preferred)'),
      tests: z.array(z.object({
        name: z.string().describe('Test name'),
        suite: z.string().optional().describe('Suite name'),
        state: TestStateEnum.describe('Test result state'),
        file: z.string().optional(),
        line: z.number().optional(),
        duration_ms: z.number().optional(),
        message: z.string().optional(),
      })).optional().describe('Flat test results'),
      evidence: z.array(z.object({
        path: z.string().describe('File path'),
        note: z.string().optional().describe('Why this is evidence'),
      })).optional(),
      commit_sha: z.string().optional().describe('Git commit SHA at time of proving'),
    },
    async (params) => {
      const result = await handleProveFeature(client, params);
      if (session && !result.startsWith('Error') && params.exit_code === 0) {
        session.featureProved(params.feature_id);
      }
      return textResult(result);
    },
  );

  server.tool(
    'complete_feature',
    'Records history with summary and commits. The server validates proof and spec update requirements.',
    {
      feature_id: z.string().describe('Feature UUID or display ID'),
      summary: z.string().describe('Work summary. First line = headline.'),
      commits: z.array(z.union([
        z.string(),
        z.object({ sha: z.string(), message: z.string() }),
      ])).describe('Git commit SHAs or {sha, message} objects'),
      backfill: z.boolean().optional().describe('Skip proof/spec requirements. Default false.'),
    },
    async (params) => {
      // Pre-call: evaluate completion gates and collect warnings
      const warnings = session ? evaluateCompletionGates(session, params.feature_id) : [];
      const result = await handleCompleteFeature(client, params);
      if (session && !result.startsWith('Error')) {
        session.featureCompleted(params.feature_id);
      }
      return textResult(appendWarnings(result, warnings));
    },
  );

  // ----------------------------------------------------------
  // Setup Tools (7)
  // ----------------------------------------------------------

  server.tool(
    'init_project',
    'Initialize a project from a directory. Analyzes codebase, creates project, returns size signals.',
    {
      directory_path: z.string().describe('Absolute path to the project directory'),
      skip_default_versions: z.boolean().optional().describe('Skip creating default versions. Default false.'),
    },
    async (params) => textResult(await handleInitProject(client, params)),
  );

  server.tool(
    'add_project_directory',
    'Associate an additional directory with a project (monorepo support).',
    {
      project_id: z.string().describe('Project UUID'),
      path: z.string().describe('Absolute directory path'),
      git_remote: z.string().optional().describe('Git remote URL'),
      is_primary: z.boolean().optional().describe('Is primary directory. Default false.'),
      instructions: z.string().optional().describe('Directory-specific instructions'),
    },
    async (params) => textResult(await handleAddProjectDirectory(client, params)),
  );

  server.tool(
    'create_feature',
    'Create a single feature describing a system CAPABILITY (what users can do), not an implementation task. Features are living documentation — they should make sense long after the code is written. Good: "Image upload", "Email notifications". Bad: "Set up S3 bucket", "Phase 2: Add endpoint". Leaf feature details must follow the Spec Format (user story + context + acceptance criteria checkboxes). Check find_features for duplicates first.',
    {
      project_id: z.string().describe('Project UUID'),
      parent_id: z.string().optional().describe('Parent feature UUID'),
      title: z.string().describe('Short capability name (2-5 words)'),
      details: z.string().optional().describe('Leaf: user story + context + acceptance criteria checkboxes (see Spec Format). Parent: shared architectural context.'),
      state: FeatureStateEnum.optional().describe("Initial state. Default 'proposed'."),
      priority: z.number().optional().describe('Priority (lower = first). Default 0.'),
    },
    async (params) => textResult(await handleCreateFeature(client, params)),
  );

  server.tool(
    'delete_feature',
    'Permanently delete a feature and descendants. Use only for archived features.',
    {
      feature_id: z.string().describe('Feature UUID'),
    },
    async (params) => textResult(await handleDeleteFeature(client, params)),
  );

  server.tool(
    'decompose',
    'Decompose a PRD or vision into a feature tree of CAPABILITIES, not implementation phases or tasks. Each feature should describe what users can do, not how to build it. Leaf feature details (50-150 words) must follow the Spec Format: user story + brief context + acceptance criteria checkboxes (3-5 items). Parent details hold shared architectural context. For existing codebases, set state to "implemented" and check off criteria with [x]. Use confirm=false to preview, confirm=true to create.',
    {
      project_id: z.string().describe('Project UUID'),
      features: z.array(ProposedFeatureSchema).describe('Proposed feature tree'),
      confirm: z.boolean().describe('true to create, false to preview'),
      target_version_id: z.string().optional().describe('Version UUID for all features'),
    },
    async (params) => textResult(await handlePlan(client, params)),
  );

  server.tool(
    'get_project_history',
    'Get recent activity timeline. Display directly without reformatting.',
    {
      project_id: z.string().describe('Project UUID'),
      feature_id: z.string().optional().describe('Filter to feature and descendants'),
      limit: z.number().optional().describe('Max entries. Default 20.'),
    },
    async (params) => textResult(await handleGetProjectHistory(client, params)),
  );

  server.tool(
    'sync',
    'Reconcile the feature tree with git history. Returns sync proposals.',
    {
      project_id: z.string().describe('Project UUID'),
    },
    async (params) => textResult(await handleSync(client, params)),
  );

  // ----------------------------------------------------------
  // Version Tools (4)
  // ----------------------------------------------------------

  server.tool(
    'list_versions',
    'List versions with status indicators (next, planned, released).',
    {
      project_id: z.string().describe('Project UUID'),
    },
    async (params) => textResult(await handleListVersions(client, params)),
  );

  server.tool(
    'create_version',
    "Create a release milestone. Name must be semantic version (e.g., 0.2.0).",
    {
      project_id: z.string().describe('Project UUID'),
      name: z.string().describe("Version name (e.g., '0.2.0')"),
      description: z.string().optional().describe('Version description'),
    },
    async (params) => textResult(await handleCreateVersion(client, params)),
  );

  server.tool(
    'set_feature_version',
    'Assign a feature to a version. Pass null to unassign.',
    {
      feature_id: z.string().describe('Feature UUID'),
      version_id: z.string().nullable().describe('Version UUID or null to unassign'),
    },
    async (params) => textResult(await handleSetFeatureVersion(client, params)),
  );

  server.tool(
    'release_version',
    'Mark a version as shipped.',
    {
      version_id: z.string().describe('Version UUID'),
    },
    async (params) => textResult(await handleReleaseVersion(client, params)),
  );

  // ----------------------------------------------------------
  // Verification Tools (3)
  // ----------------------------------------------------------

  server.tool(
    'verify_feature',
    'Assemble spec + diff for checking implementation against spec. You are the LLM.',
    {
      feature_id: z.string().describe('Feature UUID or display ID'),
      commit_range: z.string().optional().describe("Git commit range (e.g., 'abc123..HEAD')"),
    },
    async (params) => textResult(await handleVerifyFeature(client, params)),
  );

  server.tool(
    'record_verification',
    'Store verification comments. Pass empty array if implementation satisfies spec.',
    {
      feature_id: z.string().describe('Feature UUID or display ID'),
      comments: z.array(z.object({
        severity: SeverityEnum.describe('Comment severity'),
        title: z.string().describe('One-line summary of the gap'),
        body: z.string().describe('Actionable explanation'),
        file: z.string().optional().describe('Affected file path'),
      })).describe('Verification comments (empty = passed)'),
    },
    async (params) => textResult(await handleRecordVerification(client, params)),
  );

  server.tool(
    'get_feature_proof',
    'Get latest proof and verification status for a feature.',
    {
      feature_id: z.string().describe('Feature UUID or display ID'),
    },
    async (params) => textResult(await handleGetFeatureProof(client, params)),
  );

  // ----------------------------------------------------------
  // Team Tools (2)
  // ----------------------------------------------------------

  server.tool(
    'plan_team',
    'Analyze the feature tree and recommend an Agent Team structure. Two scopes: pass version_id to plan across modules (teammates own different feature sets), or pass feature_id to plan within a feature set (teammates own different leaves). Recommends team size (5-6 features per teammate) and assigns features to avoid file conflicts.',
    {
      project_id: z.string().optional().describe('Project UUID'),
      directory_path: z.string().optional().describe('Directory path for auto-discovery (alternative to project_id)'),
      feature_id: z.string().optional().describe('Parent feature UUID or display ID for feature set scope (plan within one module)'),
      version_id: z.string().optional().describe('Version UUID for version scope (plan across modules, default: next unreleased)'),
      max_teammates: z.number().optional().describe('Maximum teammates (default 5, max 8)'),
    },
    async (params) => textResult(await handlePlanTeam(client, params)),
  );

  server.tool(
    'get_spawn_context',
    'Generate a self-contained spawn prompt for an Agent Team teammate. Includes feature specs, acceptance criteria, breadcrumb context, and project directories. Teammates do not inherit conversation history, so this provides everything they need.',
    {
      feature_ids: z.array(z.string()).min(1).max(6).describe('Feature UUIDs or display IDs to include (1-6)'),
      include_project_context: z.boolean().optional().describe('Include project directories and instructions (default true)'),
    },
    async (params) => textResult(await handleGetSpawnContext(client, params)),
  );

  return server;
}
