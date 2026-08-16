import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { AgentMessage } from "../../types.ts";
import type { Entry, JsonValue, PendingEntry, ProvisionedEntry, UsageRow } from "./base.ts";
import type { Control, LaneLastResult, LaneState, Operation, OperationState } from "./operation.ts";
import {
	type Register,
	type RegisterNamespace,
	type RegisterValues,
	type SessionCodecOptions,
	SessionError,
	type Transaction,
} from "./storage.ts";

type JsonValidationFrame = { value: unknown; path: string } | { exit: object };

function invalid(path: string, reason: string): never {
	throw new SessionError("invalid_payload", `${path} ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) invalid(path, "must be an object");
	return value;
}

function requireString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) invalid(path, "must be a non-empty string");
	return value;
}

function requireStringValue(value: unknown, path: string): string {
	if (typeof value !== "string") invalid(path, "must be a string");
	return value;
}

function requireNullableString(value: unknown, path: string): string | null {
	if (value !== null && typeof value !== "string") invalid(path, "must be a string or null");
	return value;
}

function requireBoolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") invalid(path, "must be a boolean");
	return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) invalid(path, "must be a finite number");
	return value;
}

function requireSafeInteger(value: unknown, path: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		invalid(path, `must be a safe integer >= ${minimum}`);
	}
	return value as number;
}

function requireStringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) invalid(path, "must be an array");
	for (let index = 0; index < value.length; index++) requireString(value[index], `${path}[${index}]`);
	return value as string[];
}

const REGISTER_NAMESPACES = [
	"lane.leaf",
	"lane.config",
	"lane.state",
	"lane.lastResult",
	"op.meta",
	"op.state",
	"op.tool_args",
	"op.preparation",
	"pending.entry",
	"fact.name",
	"fact.label",
	"fact.custom",
] as const;

function requireRegisterNamespace(value: unknown, path: string): RegisterNamespace {
	const namespace = requireString(value, path);
	if (!(REGISTER_NAMESPACES as readonly string[]).includes(namespace)) invalid(path, "is unknown");
	return namespace as RegisterNamespace;
}

export function assertJsonValue(value: unknown, rootPath = "value"): asserts value is JsonValue {
	const active = new WeakSet<object>();
	const stack: JsonValidationFrame[] = [{ value, path: rootPath }];
	while (stack.length > 0) {
		const frame = stack.pop()!;
		if ("exit" in frame) {
			active.delete(frame.exit);
			continue;
		}
		const candidate = frame.value;
		if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") continue;
		if (typeof candidate === "number") {
			if (!Number.isFinite(candidate)) invalid(frame.path, "contains a non-finite number");
			continue;
		}
		if (typeof candidate !== "object") invalid(frame.path, `contains unsupported ${typeof candidate}`);
		if (active.has(candidate)) invalid(frame.path, "contains a cycle");
		active.add(candidate);
		stack.push({ exit: candidate });

		if (Array.isArray(candidate)) {
			if (Object.getPrototypeOf(candidate) !== Array.prototype) invalid(frame.path, "contains a non-standard array");
			if (
				Object.getOwnPropertySymbols(candidate).length > 0 ||
				Object.getOwnPropertyNames(candidate).length !== candidate.length + 1
			) {
				invalid(frame.path, "contains unsupported array properties");
			}
			for (let index = candidate.length - 1; index >= 0; index--) {
				if (!Object.hasOwn(candidate, index)) invalid(frame.path, "contains a sparse array");
				const descriptor = Object.getOwnPropertyDescriptor(candidate, index)!;
				if (!("value" in descriptor)) invalid(`${frame.path}[${index}]`, "is an accessor");
				stack.push({ value: descriptor.value, path: `${frame.path}[${index}]` });
			}
			continue;
		}

		const prototype = Object.getPrototypeOf(candidate);
		if (prototype !== Object.prototype && prototype !== null) invalid(frame.path, "contains a non-plain object");
		if (Object.getOwnPropertySymbols(candidate).length > 0) invalid(frame.path, "contains a symbol-keyed property");
		const keys = Object.keys(candidate);
		if (Object.getOwnPropertyNames(candidate).length !== keys.length) {
			invalid(frame.path, "contains a non-enumerable property");
		}
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index]!;
			const descriptor = Object.getOwnPropertyDescriptor(candidate, key)!;
			if (!("value" in descriptor)) invalid(`${frame.path}.${key}`, "is an accessor");
			stack.push({ value: descriptor.value, path: `${frame.path}.${key}` });
		}
	}
}

export function validateUsage(value: unknown, path = "usage"): void {
	const usage = requireRecord(value, path);
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		requireFiniteNumber(usage[field], `${path}.${field}`);
	}
	if (usage.cacheWrite1h !== undefined) requireFiniteNumber(usage.cacheWrite1h, `${path}.cacheWrite1h`);
	if (usage.reasoning !== undefined) requireFiniteNumber(usage.reasoning, `${path}.reasoning`);
	const cost = requireRecord(usage.cost, `${path}.cost`);
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		requireFiniteNumber(cost[field], `${path}.cost.${field}`);
	}
}

function validateContent(value: unknown, path: string, allowToolCalls: boolean): void {
	if (!Array.isArray(value)) invalid(path, "must be an array");
	for (let index = 0; index < value.length; index++) {
		const part = requireRecord(value[index], `${path}[${index}]`);
		switch (part.type) {
			case "text":
				requireStringValue(part.text, `${path}[${index}].text`);
				break;
			case "thinking":
				requireStringValue(part.thinking, `${path}[${index}].thinking`);
				if (part.thinkingSignature !== undefined) {
					requireStringValue(part.thinkingSignature, `${path}[${index}].thinkingSignature`);
				}
				if (part.redacted !== undefined) requireBoolean(part.redacted, `${path}[${index}].redacted`);
				break;
			case "image":
				requireStringValue(part.data, `${path}[${index}].data`);
				requireString(part.mimeType, `${path}[${index}].mimeType`);
				break;
			case "toolCall":
				if (!allowToolCalls) invalid(`${path}[${index}].type`, "is not allowed here");
				requireString(part.id, `${path}[${index}].id`);
				requireString(part.name, `${path}[${index}].name`);
				requireRecord(part.arguments, `${path}[${index}].arguments`);
				if (part.thoughtSignature !== undefined) {
					requireStringValue(part.thoughtSignature, `${path}[${index}].thoughtSignature`);
				}
				break;
			default:
				invalid(`${path}[${index}].type`, "is unknown");
		}
	}
}

function validateControl(value: unknown, path: string): asserts value is Control {
	const control = requireRecord(value, path);
	if (control.status === "running") return;
	if (control.status !== "cancel_requested") invalid(`${path}.status`, "is unknown");
	requireSafeInteger(control.requestedAt, `${path}.requestedAt`);
	requireStringArray(control.drainedSteer, `${path}.drainedSteer`);
	requireStringArray(control.drainedFollowUp, `${path}.drainedFollowUp`);
}

function validateLaneState(value: unknown, path: string): asserts value is LaneState {
	const state = requireRecord(value, path);
	requireNullableString(state.currentOperationId, `${path}.currentOperationId`);
	requireStringArray(state.pendingNextRun, `${path}.pendingNextRun`);
}

function validateLaneLastResult(value: unknown, path: string): asserts value is LaneLastResult {
	const result = requireRecord(value, path);
	requireString(result.operationId, `${path}.operationId`);
	if (result.kind !== "run" && result.kind !== "compaction" && result.kind !== "navigation") {
		invalid(`${path}.kind`, "is unknown");
	}
	requireNullableString(result.leafId, `${path}.leafId`);
	if (result.finalAssistantEntryId !== undefined) {
		requireString(result.finalAssistantEntryId, `${path}.finalAssistantEntryId`);
	}
	if (!["completed", "failed", "declined", "aborted"].includes(String(result.outcome))) {
		invalid(`${path}.outcome`, "is unknown");
	}
	if (result.outcome === "failed") validateOperationError(result.error, `${path}.error`);
	if (
		result.runCompletion !== undefined &&
		result.runCompletion !== "assistant" &&
		result.runCompletion !== "terminated_tools"
	) {
		invalid(`${path}.runCompletion`, "is unknown");
	}
}

function validateOperationError(value: unknown, path: string): void {
	const error = requireRecord(value, path);
	requireString(error.code, `${path}.code`);
	requireString(error.message, `${path}.message`);
	if (error.details !== undefined) assertJsonValue(error.details, `${path}.details`);
}

function validateOperation(value: unknown, path: string): asserts value is Operation {
	const operation = requireRecord(value, path);
	requireString(operation.operationId, `${path}.operationId`);
	requireString(operation.lane, `${path}.lane`);
	requireNullableString(operation.sourceLeafId, `${path}.sourceLeafId`);
	requireSafeInteger(operation.startedAt, `${path}.startedAt`);
	const intent = requireRecord(operation.intent, `${path}.intent`);
	switch (intent.kind) {
		case "run":
			requireStringArray(intent.promptEntryIds, `${path}.intent.promptEntryIds`);
			if (intent.systemPromptOverride !== undefined) {
				requireString(intent.systemPromptOverride, `${path}.intent.systemPromptOverride`);
			}
			if (intent.resumeData !== undefined) assertJsonValue(intent.resumeData, `${path}.intent.resumeData`);
			if (intent.adaptive !== undefined) {
				const adaptive = requireRecord(intent.adaptive, `${path}.intent.adaptive`);
				requireString(adaptive.basisEntryId, `${path}.intent.adaptive.basisEntryId`);
			}
			break;
		case "compaction":
			if (intent.customInstructions !== undefined) {
				requireString(intent.customInstructions, `${path}.intent.customInstructions`);
			}
			break;
		case "navigation":
			requireNullableString(intent.targetId, `${path}.intent.targetId`);
			requireBoolean(intent.summarize, `${path}.intent.summarize`);
			if (intent.label !== undefined) requireString(intent.label, `${path}.intent.label`);
			if (intent.customInstructions !== undefined) {
				requireString(intent.customInstructions, `${path}.intent.customInstructions`);
			}
			break;
		default:
			invalid(`${path}.intent.kind`, "is unknown");
	}
}

function validateInbox(value: unknown, path: string): void {
	const inbox = requireRecord(value, path);
	requireStringArray(inbox.steer, `${path}.steer`);
	requireStringArray(inbox.followUp, `${path}.followUp`);
	requireStringArray(inbox.writes, `${path}.writes`);
}

function validateConfiguration(value: unknown, path: string): void {
	const configuration = requireRecord(value, path);
	const model = requireRecord(configuration.model, `${path}.model`);
	requireString(model.provider, `${path}.model.provider`);
	requireString(model.modelId, `${path}.model.modelId`);
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(configuration.thinkingLevel))) {
		invalid(`${path}.thinkingLevel`, "is unknown");
	}
	requireStringArray(configuration.activeToolNames, `${path}.activeToolNames`);
}

function validateStructuralDecision(value: unknown, path: string): void {
	const structural = requireRecord(value, path);
	requireString(structural.taskId, `${path}.taskId`);
	if (structural.status === "deciding") return;
	if (structural.status !== "generating") invalid(`${path}.status`, "is unknown");
	validateSummaryGeneration(structural.generation, `${path}.generation`);
}

function validateSummaryGeneration(value: unknown, path: string): void {
	const generation = requireRecord(value, path);
	if (!isRecord(generation.context)) invalid(`${path}.context`, "must be an object");
	if (generation.status === "ready") {
		requireSafeInteger(generation.nextAttempt, `${path}.nextAttempt`, 1);
		return;
	}
	if (generation.status === "effect_pending") {
		requireSafeInteger(generation.attempt, `${path}.attempt`, 1);
		requireStringArray(generation.usageIds, `${path}.usageIds`);
		return;
	}
	if (generation.status === "retry_wait") {
		requireSafeInteger(generation.nextAttempt, `${path}.nextAttempt`, 1);
		requireSafeInteger(generation.notBefore, `${path}.notBefore`);
		requireString(generation.errorMessage, `${path}.errorMessage`);
		return;
	}
	invalid(`${path}.status`, "is unknown");
}

function validateRunPhase(value: unknown, path: string): void {
	const phase = requireRecord(value, path);
	switch (phase.kind) {
		case "checkpoint": {
			const continuation = requireRecord(phase.continuation, `${path}.continuation`);
			if (continuation.kind === "need_assistant") {
				requireBoolean(continuation.overflowRecoveryUsed, `${path}.continuation.overflowRecoveryUsed`);
			} else if (continuation.kind === "may_finish") {
				requireBoolean(continuation.includeFinalAssistant, `${path}.continuation.includeFinalAssistant`);
			} else {
				invalid(`${path}.continuation.kind`, "is unknown");
			}
			requireString(phase.triggerEntryId, `${path}.triggerEntryId`);
			return;
		}
		case "assistant": {
			const generation = requireRecord(phase.generation, `${path}.generation`);
			if (!isRecord(generation.context)) invalid(`${path}.generation.context`, "must be an object");
			if (!["ready", "effect_pending", "retry_wait"].includes(String(generation.status))) {
				invalid(`${path}.generation.status`, "is unknown");
			}
			return;
		}
		case "tools": {
			const batch = requireRecord(phase.batch, `${path}.batch`);
			requireString(batch.assistantEntryId, `${path}.batch.assistantEntryId`);
			requireString(batch.turnId, `${path}.batch.turnId`);
			validateConfiguration(batch.configuration, `${path}.batch.configuration`);
			const authority = requireRecord(batch.argumentAuthority, `${path}.batch.argumentAuthority`);
			if (authority.kind === "adaptive_tool_batch_entry") {
				requireString(authority.entryId, `${path}.batch.argumentAuthority.entryId`);
			} else if (authority.kind !== "standard_tool_args_registers" && authority.kind !== "adaptive_pending") {
				invalid(`${path}.batch.argumentAuthority.kind`, "is unknown");
			}
			if (!Array.isArray(batch.calls)) invalid(`${path}.batch.calls`, "must be an array");
			for (let index = 0; index < batch.calls.length; index++) {
				const call = requireRecord(batch.calls[index], `${path}.batch.calls[${index}]`);
				requireSafeInteger(call.sourceIndex, `${path}.batch.calls[${index}].sourceIndex`);
				requireString(call.resultEntryId, `${path}.batch.calls[${index}].resultEntryId`);
				if (call.status === "planned") {
					if (call.blocked !== undefined && call.blocked !== true) {
						invalid(`${path}.batch.calls[${index}].blocked`, "must be true when present");
					}
					if (call.truncated !== undefined && call.truncated !== true) {
						invalid(`${path}.batch.calls[${index}].truncated`, "must be true when present");
					}
				} else if (call.status === "effect_pending") {
					if (call.replay !== "safe" && call.replay !== "never") {
						invalid(`${path}.batch.calls[${index}].replay`, "is unknown");
					}
				} else if (call.status === "completed") {
					requireBoolean(call.terminate, `${path}.batch.calls[${index}].terminate`);
				} else {
					invalid(`${path}.batch.calls[${index}].status`, "is unknown");
				}
			}
			return;
		}
		case "compaction":
			validateStructuralDecision(phase.structural, `${path}.structural`);
			validateRunPhase(phase.resumeAfter, `${path}.resumeAfter`);
			return;
		case "deferred":
			if (!isRecord(phase.deferred)) invalid(`${path}.deferred`, "must be an object");
			return;
		case "failure_drain":
			validateOperationError(phase.error, `${path}.error`);
			if (!isRecord(phase.provenance)) invalid(`${path}.provenance`, "must be an object");
			return;
		default:
			invalid(`${path}.kind`, "is unknown");
	}
}

function validateOperationState(value: unknown, path: string): asserts value is OperationState {
	const state = requireRecord(value, path);
	validateControl(state.control, `${path}.control`);
	switch (state.kind) {
		case "run": {
			const settings = requireRecord(state.settings, `${path}.settings`);
			if (!isRecord(settings.compaction)) invalid(`${path}.settings.compaction`, "must be an object");
			if (settings.steeringMode !== "all" && settings.steeringMode !== "one-at-a-time") {
				invalid(`${path}.settings.steeringMode`, "is unknown");
			}
			if (settings.followUpMode !== "all" && settings.followUpMode !== "one-at-a-time") {
				invalid(`${path}.settings.followUpMode`, "is unknown");
			}
			if (settings.toolExecution !== "sequential" && settings.toolExecution !== "parallel") {
				invalid(`${path}.settings.toolExecution`, "is unknown");
			}
			validateRunPhase(state.phase, `${path}.phase`);
			validateInbox(state.inbox, `${path}.inbox`);
			requireNullableString(state.latestAssistantEntryId, `${path}.latestAssistantEntryId`);
			if (state.control.status === "cancel_requested") {
				// R6 drained-queue invariants: no internal duplicates and the
				// drained ids must be disjoint from the live steer/follow-up
				// queues of the same state.
				const drained = new Set<string>([...state.control.drainedSteer, ...state.control.drainedFollowUp]);
				if (drained.size !== state.control.drainedSteer.length + state.control.drainedFollowUp.length) {
					invalid(`${path}.control.drainedSteer`, "contains duplicate ids");
				}
				const inbox = state.inbox as { steer: string[]; followUp: string[] };
				for (const id of [...inbox.steer, ...inbox.followUp]) {
					if (drained.has(id)) invalid(`${path}.inbox`, "overlaps drained queue ids");
				}
			}
			return;
		}
		case "compaction":
			validateStructuralDecision(state.structural, `${path}.structural`);
			return;
		case "navigation":
			requireNullableString(state.targetId, `${path}.targetId`);
			requireBoolean(state.summarize, `${path}.summarize`);
			if (!isRecord(state.phase)) invalid(`${path}.phase`, "must be an object");
			return;
		default:
			invalid(`${path}.kind`, "is unknown");
	}
}

function validatePendingEntry(
	value: unknown,
	path: string,
	validateMessage?: (message: unknown, path: string) => void,
): asserts value is PendingEntry {
	const pending = requireRecord(value, path);
	if (pending.type === "message") {
		if (pending.payload === undefined) invalid(`${path}.payload`, "is required for message pending entries");
		if (validateMessage === undefined) invalid(path, "requires a message validator");
		validateMessage(pending.payload, `${path}.payload`);
		return;
	}
	if (pending.type === "custom") {
		if (pending.customType === undefined) invalid(`${path}.customType`, "is required for custom pending entries");
		requireString(pending.customType, `${path}.customType`);
		if (pending.payload !== undefined) assertJsonValue(pending.payload, `${path}.payload`);
		return;
	}
	invalid(`${path}.type`, "is unknown");
}

function validateStructuralPreparation(value: unknown, path: string): void {
	const preparation = requireRecord(value, path);
	if (preparation.kind !== "compaction" && preparation.kind !== "branch_summary") {
		invalid(`${path}.kind`, "is unknown");
	}
}

function validateRegisterValue<Namespace extends RegisterNamespace>(
	namespace: Namespace,
	value: unknown,
	path: string,
	validateMessage?: (message: unknown, path: string) => void,
): asserts value is RegisterValues[Namespace] {
	assertJsonValue(value, path);
	switch (namespace) {
		case "lane.leaf":
			requireNullableString(value, path);
			return;
		case "lane.config":
			validateConfiguration(value, path);
			return;
		case "lane.state":
			validateLaneState(value, path);
			return;
		case "lane.lastResult":
			validateLaneLastResult(value, path);
			return;
		case "op.meta":
			validateOperation(value, path);
			return;
		case "op.state":
			validateOperationState(value, path);
			return;
		case "op.tool_args":
			if (!isRecord(value)) invalid(path, "must be an object");
			return;
		case "op.preparation":
			validateStructuralPreparation(value, path);
			return;
		case "pending.entry":
			validatePendingEntry(value, path, validateMessage);
			return;
		case "fact.name":
		case "fact.label":
			requireStringValue(value, path);
			return;
		case "fact.custom":
			return;
	}
}

function validateUsageRow(row: unknown, path: string): asserts row is Omit<UsageRow, "seq"> {
	const candidate = requireRecord(row, path);
	requireString(candidate.id, `${path}.id`);
	validateUsage(candidate.usage, `${path}.usage`);
	if (candidate.entryId !== undefined) requireString(candidate.entryId, `${path}.entryId`);
	requireBoolean(candidate.adjustment, `${path}.adjustment`);
	if (candidate.details !== undefined) assertJsonValue(candidate.details, `${path}.details`);
}

export class SessionCodec {
	private readonly customMessageValidators = new Map<string, ReturnType<typeof Compile>>();

	constructor(options: SessionCodecOptions = {}) {
		for (const [role, schema] of Object.entries(options.customMessageSchemas ?? {})) {
			this.customMessageValidators.set(role, Compile(schema as TSchema));
		}
	}

	validateMessage(message: unknown, path = "message"): asserts message is AgentMessage {
		assertJsonValue(message, path);
		const candidate = requireRecord(message, path);
		const role = requireString(candidate.role, `${path}.role`);
		requireSafeInteger(candidate.timestamp, `${path}.timestamp`);
		if (role === "user") {
			if (typeof candidate.content === "string") return;
			if (!Array.isArray(candidate.content)) {
				invalid(`${path}.content`, "must be a string or array");
			}
			validateContent(candidate.content, `${path}.content`, false);
			return;
		}
		if (role === "assistant") {
			validateContent(candidate.content, `${path}.content`, true);
			requireString(candidate.api, `${path}.api`);
			requireString(candidate.provider, `${path}.provider`);
			requireString(candidate.model, `${path}.model`);
			if (!["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(String(candidate.stopReason))) {
				invalid(`${path}.stopReason`, "must be settled");
			}
			validateUsage(candidate.usage, `${path}.usage`);
			return;
		}
		if (role === "toolResult") {
			requireString(candidate.toolCallId, `${path}.toolCallId`);
			requireString(candidate.toolName, `${path}.toolName`);
			validateContent(candidate.content, `${path}.content`, false);
			requireBoolean(candidate.isError, `${path}.isError`);
			if (candidate.usage !== undefined) validateUsage(candidate.usage, `${path}.usage`);
			return;
		}

		const validator = this.customMessageValidators.get(role);
		if (!validator) invalid(`${path}.role`, `has no registered schema for ${role}`);
		if (!validator.Check(candidate)) invalid(path, `does not match the registered schema for ${role}`);
	}

	validateEntry(entry: unknown, path = "entry"): asserts entry is ProvisionedEntry {
		assertJsonValue(entry, path);
		const candidate = requireRecord(entry, path);
		requireString(candidate.id, `${path}.id`);
		requireNullableString(candidate.parentId, `${path}.parentId`);
		if (candidate.seq !== undefined || candidate.timestamp !== undefined) {
			invalid(path, "must not provide storage-assigned seq or timestamp");
		}
		switch (candidate.type) {
			case "message":
				this.validateMessage(candidate.message, `${path}.message`);
				if (candidate.terminate !== undefined && candidate.terminate !== true) {
					invalid(`${path}.terminate`, "must be true when present");
				}
				return;
			case "compaction":
				requireString(candidate.summary, `${path}.summary`);
				if (!Array.isArray(candidate.retainedTail)) invalid(`${path}.retainedTail`, "must be an array");
				for (let index = 0; index < candidate.retainedTail.length; index++) {
					this.validateMessage(candidate.retainedTail[index], `${path}.retainedTail[${index}]`);
				}
				requireSafeInteger(candidate.tokensBefore, `${path}.tokensBefore`);
				requireBoolean(candidate.fromHook, `${path}.fromHook`);
				if (candidate.usage !== undefined) validateUsage(candidate.usage, `${path}.usage`);
				return;
			case "branch_summary":
				requireString(candidate.fromId, `${path}.fromId`);
				requireString(candidate.summary, `${path}.summary`);
				requireBoolean(candidate.fromHook, `${path}.fromHook`);
				if (candidate.usage !== undefined) validateUsage(candidate.usage, `${path}.usage`);
				return;
			case "custom":
				requireString(candidate.customType, `${path}.customType`);
				return;
			default:
				invalid(`${path}.type`, "is unknown");
		}
	}

	validateStoredEntry(entry: unknown, path = "entry"): asserts entry is Entry {
		assertJsonValue(entry, path);
		const candidate = requireRecord(entry, path);
		requireSafeInteger(candidate.seq, `${path}.seq`, 1);
		requireSafeInteger(candidate.timestamp, `${path}.timestamp`);
		const { seq: _seq, timestamp: _timestamp, ...provisioned } = candidate;
		this.validateEntry(provisioned, path);
	}

	validateStoredRegister<N extends RegisterNamespace>(
		register: unknown,
		path = "register",
	): asserts register is Register<N> {
		assertJsonValue(register, path);
		const candidate = requireRecord(register, path);
		const namespace = requireRegisterNamespace(candidate.namespace, `${path}.namespace`);
		requireStringValue(candidate.key, `${path}.key`);
		requireSafeInteger(candidate.seq, `${path}.seq`, 1);
		validateRegisterValue(namespace, candidate.value, `${path}.value`, (value, valuePath) =>
			this.validateMessage(value, valuePath),
		);
	}

	validateTransaction(transaction: Transaction): void {
		assertJsonValue(transaction, "transaction");
		if (!Array.isArray(transaction.writes) || transaction.writes.length === 0) {
			invalid("transaction.writes", "must be a non-empty array");
		}
		for (let index = 0; index < transaction.writes.length; index++) {
			const write: Transaction["writes"][number] = transaction.writes[index]!;
			const path = `transaction.writes[${index}]`;
			if (write.kind === "entry") {
				this.validateEntry(write.entry, `${path}.entry`);
			} else if (write.kind === "usage") {
				validateUsageRow(write.row, `${path}.row`);
			} else if (write.kind === "register") {
				requireStringValue(write.key, `${path}.key`);
				const namespace = requireRegisterNamespace(write.namespace, `${path}.namespace`);
				if (write.op === "set") {
					validateRegisterValue(namespace, write.value, `${path}.value`, (value, valuePath) =>
						this.validateMessage(value, valuePath),
					);
				} else if (write.op !== "delete") {
					invalid(`${path}.op`, "is unknown");
				}
			} else {
				invalid(`${path}.kind`, "is unknown");
			}
		}
	}
}
