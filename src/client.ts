/**
 * Manifest HTTP Client
 *
 * Thin fetch wrapper for the Manifest API.
 * Each method maps to one HTTP endpoint.
 */

import type {
  Project,
  ProjectWithDirectories,
  ProjectLookupResult,
  Feature,
  FeatureTreeNode,
  FeatureWithContext,
  FeatureHistory,
  CreateFeatureInput,
  UpdateFeatureInput,
  CreateVersionInput,
  VersionListResponse,
  Version,
  TestSuiteInput,
  TestResultInput,
  EvidenceInput,
  CommitRef,
  ProposedFeature,
  VerificationComment,
  FeatureListItem,
  FeatureProof,
  StartFeatureResponse,
  ProjectHistoryEntry,
} from './types.js';

// ============================================================
// Error Types
// ============================================================

export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: string,
  ) {
    super(`${status} ${statusText}: ${body}`);
    this.name = 'ApiError';
  }
}

export class NotFoundError extends ApiError {
  constructor(body: string) {
    super(404, 'Not Found', body);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends ApiError {
  constructor(body: string) {
    super(409, 'Conflict', body);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends ApiError {
  constructor(body: string) {
    super(422, 'Unprocessable Entity', body);
    this.name = 'ValidationError';
  }
}

export class ConnectionError extends Error {
  constructor(public baseUrl: string) {
    super(`Failed to connect to ${baseUrl}. Is the server running?`);
    this.name = 'ConnectionError';
  }
}

// ============================================================
// Client Config
// ============================================================

export interface ManifestClientConfig {
  baseUrl?: string;
  apiKey?: string;
  accessToken?: string;
  defaultHeaders?: Record<string, string>;
  /** Enable session-scoped workflow state tracking. Default true (stdio), set false for stateless transports (Worker). */
  enableSessionState?: boolean;
}

const DEFAULT_BASE_URL = 'http://localhost:4242';

// ============================================================
// Client
// ============================================================

export class ManifestClient {
  private baseUrl: string;
  private accessToken?: string;
  private defaultHeaders: Record<string, string>;

  constructor(config?: ManifestClientConfig) {
    const raw = config?.baseUrl ?? DEFAULT_BASE_URL;
    this.baseUrl = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    this.accessToken = config?.accessToken ?? config?.apiKey;
    this.defaultHeaders = { ...(config?.defaultHeaders ?? {}) };
  }

  get webUrl(): string { return this.baseUrl; }

  private get apiUrl(): string {
    return `${this.baseUrl}/api/v1`;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      'Content-Type': 'application/json',
    };

    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }

    const options: RequestInit = { method, headers };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, options);
    } catch {
      throw new ConnectionError(this.baseUrl);
    }

    if (!response.ok) {
      const text = await response.text();
      switch (response.status) {
        case 404:
          throw new NotFoundError(text);
        case 409:
          throw new ConflictError(text);
        case 422:
          throw new ValidationError(text);
        default:
          throw new ApiError(response.status, response.statusText, text);
      }
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  // ============================================================
  // Projects
  // ============================================================

  async listProjects(): Promise<Project[]> {
    return this.request('GET', '/projects');
  }

  async listProjectsByDirectory(directoryPath: string): Promise<ProjectLookupResult> {
    const encoded = encodeURIComponent(directoryPath);
    return this.request('GET', `/projects?directory=${encoded}`);
  }

  async getProject(id: string): Promise<ProjectWithDirectories> {
    return this.request('GET', `/projects/${id}`);
  }

  async getProjectTemplate(projectId: string): Promise<{ name: string; content: string } | null> {
    try {
      return await this.request('GET', `/projects/${projectId}/template`);
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  async initProject(input: {
    directory_path: string;
    skip_default_versions?: boolean;
  }): Promise<unknown> {
    return this.request('POST', '/projects', input);
  }

  async addProjectDirectory(
    projectId: string,
    input: { path: string; git_remote?: string; is_primary?: boolean; instructions?: string },
  ): Promise<unknown> {
    return this.request('POST', `/projects/${projectId}/directories`, input);
  }

  async getProjectHistory(
    projectId: string,
    options?: { feature_id?: string; limit?: number },
  ): Promise<ProjectHistoryEntry[]> {
    let path = `/projects/${projectId}/history`;
    const params = new URLSearchParams();
    if (options?.feature_id) params.set('feature_id', options.feature_id);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    if (qs) path += `?${qs}`;
    return this.request('GET', path);
  }

  // ============================================================
  // Features
  // ============================================================

  async getFeature(id: string): Promise<Feature> {
    return this.request('GET', `/features/${id}`);
  }

  async getFeatureContext(id: string): Promise<FeatureWithContext> {
    return this.request('GET', `/features/${id}/context`);
  }

  async createFeature(projectId: string, input: CreateFeatureInput): Promise<Feature> {
    return this.request('POST', `/projects/${projectId}/features`, input);
  }

  async updateFeature(id: string, input: UpdateFeatureInput): Promise<Feature> {
    return this.request('PUT', `/features/${id}`, input);
  }

  async deleteFeature(id: string): Promise<void> {
    return this.request('DELETE', `/features/${id}`);
  }

  async getFeatureTree(projectId: string): Promise<FeatureTreeNode[]> {
    return this.request('GET', `/projects/${projectId}/features?format=tree`);
  }

  async findFeatures(params: {
    project_id?: string;
    state?: string;
    query?: string;
    version_id?: string;
    limit?: number;
    offset?: number;
  }): Promise<FeatureListItem[]> {
    const { project_id, ...rest } = params;
    const base = project_id ? `/projects/${project_id}/features` : '/features';
    const qs = new URLSearchParams();
    for (const [key, val] of Object.entries(rest)) {
      if (val !== undefined && val !== null) qs.set(key, String(val));
    }
    const query = qs.toString();
    return this.request('GET', query ? `${base}?${query}` : base);
  }

  async getNextFeature(projectId: string, versionId?: string): Promise<FeatureWithContext> {
    let path = `/projects/${projectId}/features?next=true`;
    if (versionId) path += `&version_id=${versionId}`;
    return this.request('GET', path);
  }

  async getFeatureHistory(featureId: string): Promise<FeatureHistory[]> {
    return this.request('GET', `/features/${featureId}/history`);
  }

  async startFeature(
    featureId: string,
    input: { agent_type?: string; force?: boolean; claim_metadata?: string },
  ): Promise<StartFeatureResponse> {
    return this.request('PUT', `/features/${featureId}/claim`, input);
  }

  async completeFeature(
    featureId: string,
    input: { summary: string; commits: (string | CommitRef)[]; backfill?: boolean },
  ): Promise<Feature> {
    return this.request('POST', `/features/${featureId}/complete`, input);
  }

  async proveFeature(
    featureId: string,
    input: {
      command: string;
      exit_code: number;
      output?: string;
      test_suites?: TestSuiteInput[];
      tests?: TestResultInput[];
      evidence?: EvidenceInput[];
      commit_sha?: string;
    },
  ): Promise<FeatureProof> {
    return this.request('POST', `/features/${featureId}/proofs`, input);
  }

  async getFeatureProof(featureId: string): Promise<FeatureProof> {
    return this.request('GET', `/features/${featureId}/proofs?latest=true`);
  }

  // ============================================================
  // Versions
  // ============================================================

  async listVersions(projectId: string): Promise<VersionListResponse> {
    return this.request('GET', `/projects/${projectId}/versions`);
  }

  async createVersion(projectId: string, input: CreateVersionInput): Promise<Version> {
    return this.request('POST', `/projects/${projectId}/versions`, input);
  }

  async setFeatureVersion(featureId: string, versionId: string | null): Promise<unknown> {
    return this.request('PUT', `/features/${featureId}/version`, {
      version_id: versionId,
    });
  }

  async releaseVersion(versionId: string): Promise<unknown> {
    return this.request('PUT', `/versions/${versionId}`, {
      released_at: new Date().toISOString(),
    });
  }

  // ============================================================
  // Planning
  // ============================================================

  async planFeatures(
    projectId: string,
    input: {
      features: ProposedFeature[];
      confirm: boolean;
      target_version_id?: string;
    },
  ): Promise<unknown> {
    return this.request('POST', `/projects/${projectId}/features`, input);
  }

  // ============================================================
  // Analysis & Sync
  // ============================================================

  async syncFeatures(projectId: string): Promise<unknown> {
    return this.request('POST', `/projects/${projectId}/sync`);
  }

  // ============================================================
  // Verification
  // ============================================================

  async verifyFeature(featureId: string, commitRange?: string): Promise<unknown> {
    let path = `/features/${featureId}/verify`;
    if (commitRange) path += `?commit_range=${encodeURIComponent(commitRange)}`;
    return this.request('POST', path, {});
  }

  async recordVerification(
    featureId: string,
    input: { comments: VerificationComment[] },
  ): Promise<unknown> {
    return this.request('PUT', `/features/${featureId}/verification`, input);
  }
}
