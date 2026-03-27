/**
 * Session-scoped workflow state, gates, and tier resolution.
 *
 * Ported from manifest-pi — pure TypeScript, zero dependencies.
 * Tracks which features have been started, proved, and had their
 * spec updated within a single MCP server process lifetime.
 *
 * Non-Claude MCP clients are unaffected: state tracking is advisory,
 * and gates return warnings (not errors) when preconditions are unmet.
 */

import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Marker file path ────────────────────────────────
// Hooks (Layer 2) read this to know the current workflow phase.
// Uses parent PID so each Claude Code session gets its own marker.

const MARKER_PATH = join(tmpdir(), `manifest-session-${process.ppid}.json`);

// ── Tier Resolution ─────────────────────────────────

export type PlanTier = 'auto' | 'tracked' | 'full';

export function countSpecCriteria(details: string | null): number {
  if (!details) return 0;
  return (details.match(/^- \[ \]/gm) ?? []).length;
}

export function detectEscalation(planText: string): boolean {
  return /\[COMPLEX\]/i.test(planText);
}

export function resolveTier(
  stepCount: number,
  criteriaCount: number,
  agentEscalated: boolean,
): PlanTier {
  if (agentEscalated) return 'full';
  if (stepCount >= 6) return 'full';
  if (criteriaCount >= 7) return 'full';
  if (stepCount <= 2 && criteriaCount <= 3) return 'auto';
  return 'tracked';
}

// ── Workflow State ───────────────────────────────────

export type WorkflowPhase =
  | 'speccing'
  | 'spec_approved'
  | 'implementing'
  | 'critical_reviewing'
  | 'complete';

/** Phase names used in the marker file (simplified for hooks). */
export type MarkerPhase = 'plan' | 'implement' | 'review' | 'complete';

export interface FeatureWorkState {
  featureId: string;
  proved: boolean;
  specUpdated: boolean;
  phase: WorkflowPhase;
  verified: boolean;
  dispatched: boolean;
  claimedAt: string | null;
}

export class WorkflowState {
  private features = new Map<string, FeatureWorkState>();
  private _currentFeatureId: string | null = null;
  private _teamMode = false;
  private _markerEnabled: boolean;

  constructor(options?: { enableMarker?: boolean }) {
    this._markerEnabled = options?.enableMarker ?? true;
  }

  get currentFeatureId(): string | null {
    return this._currentFeatureId;
  }

  get teamMode(): boolean {
    return this._teamMode;
  }

  hasActiveFeature(): boolean {
    return this._currentFeatureId !== null;
  }

  enterTeamMode(featureId: string): void {
    this._teamMode = true;
    this.featureStarted(featureId);
  }

  exitTeamMode(): void {
    this._teamMode = false;
  }

  featureStarted(featureId: string, claimedAt?: string): void {
    this._currentFeatureId = featureId;
    if (!this.features.has(featureId)) {
      this.features.set(featureId, {
        featureId,
        proved: false,
        specUpdated: false,
        phase: 'speccing',
        verified: false,
        dispatched: false,
        claimedAt: claimedAt ?? new Date().toISOString(),
      });
    }
    this.writeMarker('plan');
  }

  featureProved(featureId: string): void {
    const state = this.features.get(featureId);
    if (state) {
      state.proved = true;
    }
    this.writeMarker('review');
  }

  featureSpecUpdated(featureId: string): void {
    const state = this.features.get(featureId);
    if (state) {
      state.specUpdated = true;
    }
  }

  featureCompleted(featureId: string): void {
    this.features.delete(featureId);
    if (this._currentFeatureId === featureId) {
      this._currentFeatureId = null;
      this._teamMode = false;
    }
    this.deleteMarker();
  }

  /** Transition from plan to implement (called after assess_plan). */
  advanceToImplement(featureId: string): void {
    const state = this.features.get(featureId);
    if (state) {
      state.phase = 'implementing';
    }
    this.writeMarker('implement');
  }

  getFeatureState(featureId: string): FeatureWorkState | undefined {
    return this.features.get(featureId);
  }

  getPhase(featureId: string): WorkflowPhase | undefined {
    return this.features.get(featureId)?.phase;
  }

  advancePhase(featureId: string, phase: WorkflowPhase): void {
    const state = this.features.get(featureId);
    if (state) {
      state.phase = phase;
    }
  }

  setDispatched(featureId: string, dispatched: boolean): void {
    const state = this.features.get(featureId);
    if (state) {
      state.dispatched = dispatched;
    }
  }

  setVerified(featureId: string, verified: boolean): void {
    const state = this.features.get(featureId);
    if (state) {
      state.verified = verified;
    }
  }

  reset(): void {
    this.features.clear();
    this._currentFeatureId = null;
    this._teamMode = false;
    this.deleteMarker();
  }

  // ── Marker file (IPC with Claude Code hooks) ──────

  private writeMarker(phase: MarkerPhase): void {
    if (!this._markerEnabled) return;
    try {
      const marker = {
        featureId: this._currentFeatureId,
        phase,
        pid: process.pid,
        mtime: Date.now(),
      };
      writeFileSync(MARKER_PATH, JSON.stringify(marker) + '\n');
    } catch {
      // Non-fatal: hooks just won't enforce plan mode
    }
  }

  private deleteMarker(): void {
    if (!this._markerEnabled) return;
    try {
      unlinkSync(MARKER_PATH);
    } catch {
      // File may not exist
    }
  }
}

// ── Gate Evaluation ─────────────────────────────────

export interface GateDecision {
  allow: boolean;
  reason?: string;
  warning?: string;
}

/** Soft gate: warn when editing/writing without an active feature. */
export function evaluateMustStart(state: WorkflowState): GateDecision {
  if (!state.hasActiveFeature()) {
    return {
      allow: true,
      warning: 'No feature claimed. Call start_feature to track your work.',
    };
  }
  return { allow: true };
}

/** Advisory gate: warn if completing without a passing proof. */
export function evaluateMustProve(state: WorkflowState, featureId: string): GateDecision {
  const feature = state.getFeatureState(featureId);
  if (!feature || !feature.proved) {
    return {
      allow: true,
      warning: 'No test proof was recorded for this feature. Consider calling prove_feature with exit_code 0 first.',
    };
  }
  return { allow: true };
}

/** Advisory gate: warn if completing without a spec update. */
export function evaluateMustUpdateSpec(state: WorkflowState, featureId: string): GateDecision {
  const feature = state.getFeatureState(featureId);
  if (!feature || !feature.specUpdated) {
    return {
      allow: true,
      warning: 'Feature spec was not updated. Consider calling update_feature with details to document what was built.',
    };
  }
  return { allow: true };
}

/**
 * Evaluate all completion gates for a feature.
 * Returns warnings (not errors) for any unmet preconditions.
 */
export function evaluateCompletionGates(state: WorkflowState, featureId: string): string[] {
  const warnings: string[] = [];
  const proofGate = evaluateMustProve(state, featureId);
  if (proofGate.warning) warnings.push(proofGate.warning);
  const specGate = evaluateMustUpdateSpec(state, featureId);
  if (specGate.warning) warnings.push(specGate.warning);
  return warnings;
}
