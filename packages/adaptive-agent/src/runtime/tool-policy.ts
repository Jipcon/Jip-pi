import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
	AdaptiveToolBatchClearance,
	AdaptiveToolClearanceDecision,
	AdaptiveToolClearanceInput,
	AdaptiveToolClearanceResult,
	AgentToolCall,
	JsonValue,
	Session,
} from "@earendil-works/pi-agent-core/harness-v4";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { CandidatePolicyState } from "./candidate-policy-state.ts";
import type { ProjectionBasis } from "./harness-v4-contract.ts";
import { FIXED_TOOL_NAMES, type PolicyBundle, type ToolRule, validateFixedToolCatalog } from "./policy-bundle.ts";
import type { PolicyRegistry } from "./policy-registry.ts";
import { CandidateStateProjector, PolicyProjectionFault, type ProjectionFacts } from "./state-projector.ts";
import type { TrajectoryRecord, TrajectoryStore } from "./trajectory-store.ts";

export const DEFAULT_POLICY_TIMEOUT_MS = 5_000;

export interface ToolPolicyProjectionOptions {
	registry: PolicyRegistry;
	session: Session;
	projector?: CandidateStateProjector;
	/**
	 * Exact-continuation children: resolves the source session owning the
	 * usage rows of the inherited prefix (forks never copy the usage ledger).
	 * Without it a child batch clearance reconstructs the inherited capsule
	 * without its token ledger and fails closed.
	 */
	usageSourceResolver?: (sourceSessionId: string) => Promise<Session | undefined>;
}

interface ProjectedBatch {
	basis: ProjectionBasis;
	state: CandidatePolicyState;
	policyStateFingerprint: string;
}

async function projectBatch(
	input: AdaptiveToolClearanceInput,
	options: ToolPolicyProjectionOptions,
): Promise<ProjectedBatch> {
	if (input.basisEntryId === undefined) {
		throw new PolicyProjectionFault("ToolPolicy clearance is missing the durable run basis entry id");
	}
	const projector = options.projector ?? new CandidateStateProjector({ registry: options.registry });
	const entries = await options.session.getEntries([input.basisEntryId]);
	const basisEntry = entries.get(input.basisEntryId);
	if (basisEntry === undefined || basisEntry.type !== "custom") {
		throw new PolicyProjectionFault(`Run basis entry ${input.basisEntryId} does not exist`);
	}
	const data = basisEntry.data as unknown as {
		taskId?: string;
		candidateId?: string;
		policyBundle?: { version?: string; fingerprint?: string };
		projectorVersion?: string;
		inheritedPolicyState?: { fingerprint?: string };
		start?: { kind?: string; source?: { parentSessionId?: string } };
	} | null;
	if (
		data === null ||
		typeof data !== "object" ||
		typeof data.taskId !== "string" ||
		typeof data.candidateId !== "string" ||
		typeof data.policyBundle?.version !== "string" ||
		typeof data.policyBundle?.fingerprint !== "string" ||
		typeof data.projectorVersion !== "string" ||
		typeof data.inheritedPolicyState?.fingerprint !== "string"
	) {
		throw new PolicyProjectionFault(
			`Run basis entry ${input.basisEntryId} does not carry the required projection identity`,
		);
	}
	const basis: ProjectionBasis = {
		taskId: data.taskId,
		candidateId: data.candidateId,
		sessionId: input.sessionId,
		lane: input.lane,
		operationId: input.operationId,
		cursor: { kind: "tool_batch_start", assistantEntryId: input.assistantEntry.id },
		policyBundle: { version: data.policyBundle.version, fingerprint: data.policyBundle.fingerprint },
		projectorVersion: data.projectorVersion,
		inheritedStateFingerprint: data.inheritedPolicyState.fingerprint,
	};
	const facts: ProjectionFacts = { session: options.session, basisEntryId: input.basisEntryId };
	const sourceSessionId = data.start?.source?.parentSessionId;
	if (sourceSessionId !== undefined && options.usageSourceResolver !== undefined) {
		const source = await options.usageSourceResolver(sourceSessionId);
		if (source !== undefined) facts.inheritedUsageSource = source;
	}
	let capsule: Awaited<ReturnType<CandidateStateProjector["project"]>>;
	try {
		capsule = await projector.project(basis, facts);
	} catch (error) {
		console.error("PROJECTBATCH FAULT:", error instanceof Error ? error.message : String(error));
		throw error;
	}
	return { basis, state: capsule.snapshot, policyStateFingerprint: capsule.fingerprint };
}

function toolByName(tools: AgentTool[], name: string): AgentTool | undefined {
	return tools.find((tool) => tool.name === name);
}

function validatedArgs(tool: AgentTool, call: AgentToolCall): Record<string, JsonValue> | undefined {
	try {
		const validated = validateToolArguments(tool, call) as Record<string, JsonValue>;
		return validated;
	} catch {
		return undefined;
	}
}

function decisionFor(
	sourceIndex: number,
	call: AgentToolCall,
	decision: Omit<AdaptiveToolClearanceDecision, "sourceIndex" | "toolCallId" | "toolName">,
): AdaptiveToolClearanceDecision {
	return {
		kind: decision.kind,
		sourceIndex,
		toolCallId: call.id,
		toolName: call.name,
		replay: decision.replay ?? "never",
		...(decision.effectiveArgs === undefined ? {} : { effectiveArgs: decision.effectiveArgs }),
		...(decision.reason === undefined ? {} : { reason: decision.reason }),
	};
}

/**
 * Permissive baseline: uses the same Registry and CandidateStateProjector as
 * the adaptive adapter (no fixed fake fingerprint), then allows every
 * schema-valid call exactly like the legacy execution path.
 */
export class PermissiveToolPolicyAdapter implements AdaptiveToolBatchClearance {
	private readonly options: ToolPolicyProjectionOptions;

	constructor(options: ToolPolicyProjectionOptions) {
		this.options = options;
	}

	async clearBatch(input: AdaptiveToolClearanceInput): Promise<AdaptiveToolClearanceResult> {
		const projected = await projectBatch(input, this.options);
		return {
			policyStateFingerprint: projected.policyStateFingerprint,
			decisions: input.calls.map(({ sourceIndex, call }) => {
				const tool = toolByName(input.tools, call.name);
				if (tool === undefined) {
					return decisionFor(sourceIndex, call, {
						kind: "block",
						reason: `Tool ${call.name} not found`,
						replay: "never",
					});
				}
				const validated = validatedArgs(tool, call);
				if (validated === undefined) {
					return decisionFor(sourceIndex, call, {
						kind: "block",
						reason: "Tool arguments are schema-invalid",
						replay: "never",
					});
				}
				return decisionFor(sourceIndex, call, {
					kind: "allow",
					effectiveArgs: validated,
					replay: (tool as { replay?: "never" | "safe" }).replay ?? "never",
				});
			}),
		};
	}
}

export interface AdaptiveToolPolicyOptions extends ToolPolicyProjectionOptions {
	/** Absolute lexical root the fixed tools are bound to. */
	workspaceRoot: string;
	trajectory?: TrajectoryStore;
	policyTimeoutMs?: number;
}

export interface PathResolution {
	kind: "inside";
	path: string;
}

export interface PathEscape {
	kind: "escape";
	reason: string;
}

/**
 * Pure lexical path canonicalization: relative resolution against the root,
 * separator normalization, `.` and `..` collapse. Never touches the
 * filesystem; escapes above the root are rejected.
 */
export function canonicalizeWorkspacePath(path: string, workspaceRoot: string): PathResolution | PathEscape {
	const input = normalizePathString(path);
	const root = parsePath(workspaceRoot);
	if (root === undefined) return { kind: "escape", reason: "workspace root is not a valid absolute path" };
	const parsed = parsePath(input);
	if (parsed === undefined) return { kind: "escape", reason: `path ${path} is not a valid path` };
	if (parsed.root !== "" && parsed.root !== root.root) {
		return { kind: "escape", reason: `path ${path} is outside the workspace root` };
	}
	const resolved: string[] = [];
	for (const segment of parsed.segments) {
		if (segment === "..") {
			if (resolved.length === 0) return { kind: "escape", reason: `path ${path} escapes the workspace root` };
			resolved.pop();
			continue;
		}
		resolved.push(segment);
	}
	if (parsed.root !== "") {
		// An absolute path must still name a location inside the root after
		// `..` collapse: /root/../etc is outside even though it starts at root.
		if (
			resolved.length < root.segments.length ||
			!root.segments.every((segment, index) => resolved[index] === segment)
		) {
			return { kind: "escape", reason: `path ${path} is outside the workspace root` };
		}
		return { kind: "inside", path: resolved.slice(root.segments.length).join("/") || "." };
	}
	return { kind: "inside", path: resolved.join("/") || "." };
}

function normalizePathString(path: string): string {
	return path.replace(/\\/g, "/");
}

function parsePath(path: string): { root: string; segments: string[] } | undefined {
	const normalized = normalizePathString(path);
	const drive = /^([a-zA-Z]):\//.exec(normalized);
	const root = drive !== null ? `${drive[1]!.toLowerCase()}:/` : normalized.startsWith("/") ? "/" : "";
	const rest = drive !== null ? normalized.slice(drive[0]!.length) : normalized.replace(/^\/+/, "");
	const segments = rest.split("/").filter((segment) => segment.length > 0 && segment !== ".");
	return { root, segments };
}

interface MatchedRule {
	rule: ToolRule;
	decision: "allow" | "guard" | "block";
}

function matchRules(
	rules: ToolRule[],
	toolName: string,
	args: Record<string, JsonValue>,
	path: string | undefined,
	phase: string,
): MatchedRule[] {
	const matches: MatchedRule[] = [];
	for (const rule of rules) {
		if (rule.toolName !== undefined && rule.toolName !== toolName) continue;
		const when = rule.when;
		if (when !== undefined) {
			if (when.toolNames !== undefined && !when.toolNames.includes(toolName)) continue;
			if (when.phases !== undefined && !when.phases.includes(phase)) continue;
			if (when.pathMatches !== undefined && (path === undefined || !new RegExp(when.pathMatches).test(path)))
				continue;
			if (when.commandMatches !== undefined) {
				const command = args.command;
				if (typeof command !== "string" || !new RegExp(when.commandMatches).test(command)) continue;
			}
			if (when.argMatches !== undefined) {
				let mismatch = false;
				for (const [key, pattern] of Object.entries(when.argMatches)) {
					const value = args[key];
					if (typeof value !== "string" || !new RegExp(pattern).test(value)) {
						mismatch = true;
						break;
					}
				}
				if (mismatch) continue;
			}
		}
		matches.push({ rule, decision: rule.decision.kind });
	}
	return matches;
}

/**
 * Adaptive guardrail policy: pinned PolicyBundle + reconstructed
 * CandidatePolicyState, one projection per batch, source-ordered decisions.
 * allow / semantics-preserving argument_guard / block only.
 */
export class AdaptiveToolPolicyAdapter implements AdaptiveToolBatchClearance {
	private readonly options: AdaptiveToolPolicyOptions;
	private readonly projector: CandidateStateProjector;

	constructor(options: AdaptiveToolPolicyOptions) {
		this.options = options;
		this.projector = options.projector ?? new CandidateStateProjector({ registry: options.registry });
	}

	async clearBatch(input: AdaptiveToolClearanceInput): Promise<AdaptiveToolClearanceResult> {
		const timeoutMs = this.options.policyTimeoutMs ?? DEFAULT_POLICY_TIMEOUT_MS;
		return withTimeout(timeoutMs, () => this.clearBatchWithinTimeout(input));
	}

	private async clearBatchWithinTimeout(input: AdaptiveToolClearanceInput): Promise<AdaptiveToolClearanceResult> {
		// One projection per batch: every decision reads the same fingerprint.
		const projected = await projectBatch(input, {
			registry: this.options.registry,
			session: this.options.session,
			projector: this.projector,
		});
		const bundle = await this.options.registry.resolve(projected.basis.policyBundle);
		const drift = validateFixedToolCatalog(input.tools, bundle.rules.toolCatalogFingerprint);
		if (drift !== undefined) throw new PolicyProjectionFault(drift);
		const budgets = bundle.rules.budgets;
		const state = projected.state;
		const decisions = input.calls.map(({ sourceIndex, call }) =>
			this.decideCall(bundle, call, sourceIndex, state, input.tools),
		);
		// Budget exhaustion blocks the whole batch before any effect.
		if (state.budgets.tokens.used >= budgets.maxTokens) {
			decisions.forEach((decision) => {
				decision.kind = "block";
				decision.reason = `Token budget exhausted (${state.budgets.tokens.used}/${budgets.maxTokens})`;
				delete decision.effectiveArgs;
			});
		} else if (state.budgets.tools.used + input.calls.length > budgets.maxToolCalls) {
			decisions.forEach((decision) => {
				decision.kind = "block";
				decision.reason = `Tool budget exhausted (${state.budgets.tools.used} used, ${budgets.maxToolCalls} limit)`;
				delete decision.effectiveArgs;
			});
		} else if (state.budgets.turns.used >= budgets.maxTurns) {
			decisions.forEach((decision) => {
				decision.kind = "block";
				decision.reason = `Turn budget exhausted (${state.budgets.turns.used}/${budgets.maxTurns})`;
				delete decision.effectiveArgs;
			});
		}

		void this.recordPolicyTrajectory(input, projected, decisions);
		return { policyStateFingerprint: projected.policyStateFingerprint, decisions };
	}

	private decideCall(
		bundle: PolicyBundle,
		call: AgentToolCall,
		sourceIndex: number,
		state: CandidatePolicyState,
		tools: AgentTool[],
	): AdaptiveToolClearanceDecision {
		if (!(FIXED_TOOL_NAMES as readonly string[]).includes(call.name)) {
			return decisionFor(sourceIndex, call, {
				kind: "block",
				reason: `Tool ${call.name} is not part of the fixed catalog`,
				replay: "never",
			});
		}
		const tool = toolByName(tools, call.name);
		if (tool === undefined) {
			return decisionFor(sourceIndex, call, {
				kind: "block",
				reason: `Tool ${call.name} not found`,
				replay: "never",
			});
		}
		const validated = validatedArgs(tool, call);
		if (validated === undefined) {
			return decisionFor(sourceIndex, call, {
				kind: "block",
				reason: "Tool arguments are schema-invalid",
				replay: "never",
			});
		}
		const pathArg = typeof validated.path === "string" ? validated.path : undefined;
		const canonicalPath =
			pathArg !== undefined ? canonicalizeWorkspacePath(pathArg, this.options.workspaceRoot) : undefined;
		if (canonicalPath !== undefined && canonicalPath.kind === "escape") {
			return decisionFor(sourceIndex, call, { kind: "block", reason: canonicalPath.reason, replay: "never" });
		}
		const matches = matchRules(
			bundle.rules.toolRules,
			call.name,
			validated,
			canonicalPath?.kind === "inside" ? canonicalPath.path : pathArg,
			state.phase,
		);
		const kinds = new Set(matches.map((match) => match.decision));
		if (kinds.size > 1) {
			return decisionFor(sourceIndex, call, {
				kind: "block",
				reason: "Conflicting policy rules matched the tool call",
				replay: "never",
			});
		}
		const matched = matches[0];
		if (matched === undefined || matched.decision === "allow") {
			return decisionFor(sourceIndex, call, {
				kind: "allow",
				effectiveArgs: structuredClone(validated),
				replay: capReplay(tool, matched?.rule.decision.replay),
			});
		}
		if (matched.decision === "block") {
			return decisionFor(sourceIndex, call, {
				kind: "block",
				reason: matched.rule.decision.reason ?? "Blocked by policy",
				replay: "never",
			});
		}
		// argument_guard: only equivalent path canonicalization; everything
		// else passes through unchanged. Material rewrites are not expressible.
		const effective = structuredClone(validated);
		for (const argument of matched.rule.decision.pathArguments ?? ["path"]) {
			const value = effective[argument];
			if (typeof value !== "string") continue;
			const canonical = canonicalizeWorkspacePath(value, this.options.workspaceRoot);
			if (canonical.kind === "escape") {
				return decisionFor(sourceIndex, call, { kind: "block", reason: canonical.reason, replay: "never" });
			}
			effective[argument] = canonical.path;
		}
		// Guarded arguments must revalidate against the tool schema; a failure
		// here is a ToolPolicy fault, not a per-call block.
		const revalidated = validatedArgs(tool, { ...call, arguments: effective });
		if (revalidated === undefined) {
			throw new PolicyProjectionFault(`Guarded arguments for tool ${call.name} failed schema validation`);
		}
		return decisionFor(sourceIndex, call, {
			kind: "argument_guard",
			effectiveArgs: revalidated,
			replay: capReplay(tool, matched.rule.decision.replay),
		});
	}

	private recordPolicyTrajectory(
		input: AdaptiveToolClearanceInput,
		projected: ProjectedBatch,
		decisions: AdaptiveToolClearanceDecision[],
	): void {
		const trajectory = this.options.trajectory;
		if (trajectory === undefined) return;
		const record: TrajectoryRecord = {
			id: `policy:${input.operationId}:${input.assistantEntry.id}`,
			kind: "policy",
			taskId: projected.basis.taskId,
			candidateId: projected.basis.candidateId,
			sessionId: input.sessionId,
			operationId: input.operationId,
			assistantEntryId: input.assistantEntry.id,
			policyBundleVersion: projected.basis.policyBundle.version,
			policyBundleFingerprint: projected.basis.policyBundle.fingerprint,
			stateFingerprint: projected.policyStateFingerprint,
			metrics: {
				decisions: decisions.map((decision) => ({
					sourceIndex: decision.sourceIndex,
					toolName: decision.toolName,
					kind: decision.kind,
					reason: decision.reason,
				})),
			},
			recordedAt: Date.now(),
		};
		// Fire and forget: research data never affects clearance or execution.
		trajectory.append(record).catch(() => undefined);
	}
}

function capReplay(tool: AgentTool, ruleReplay: "never" | "safe" | undefined): "never" | "safe" {
	const toolReplay = (tool as { replay?: "never" | "safe" }).replay ?? "never";
	if (toolReplay !== "safe") return "never";
	return ruleReplay === "safe" ? "safe" : toolReplay;
}

async function withTimeout<T>(timeoutMs: number, work: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new PolicyProjectionFault(`ToolPolicy timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
		timer.unref?.();
	});
	try {
		return await Promise.race([work(), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
