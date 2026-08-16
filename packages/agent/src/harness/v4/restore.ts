import type { AgentMessage } from "../../types.ts";
import type { Entry } from "./base.ts";
import type {
	Control,
	LaneState,
	NavigationState,
	Operation,
	OperationState,
	RunPhase,
	StructuralDecision,
	ToolBatch,
} from "./operation.ts";
import { type Register, type RegisterNamespace, type Session, SessionError } from "./storage.ts";
import type { CurrentOperation, SuspendedOperation } from "./surface.ts";

export type RestoredLane =
	| {
			kind: "idle";
			lane: string;
			leafId: string | null;
			laneState: LaneState;
			laneStateSeq: number;
	  }
	| { kind: "suspended"; current: CurrentOperation; loaded: ReadonlyMap<string, Entry | Register> };

interface HydrationInventory {
	entryIds: Set<string>;
	registers: Array<{ namespace: RegisterNamespace; key: string }>;
}

function corruption(message: string): never {
	throw new SessionError("corruption", message);
}

function requireRegister<N extends RegisterNamespace>(
	register: Register<N> | undefined,
	namespace: N,
	key: string,
): Register<N> {
	if (register === undefined) corruption(`Required register ${namespace}/${key} is missing`);
	return register;
}

function pendingIds(state: LaneState, operationState: OperationState | undefined): string[] {
	const result = [...state.pendingNextRun];
	if (operationState?.kind !== "run") return result;
	result.push(...operationState.inbox.steer, ...operationState.inbox.followUp, ...operationState.inbox.writes);
	if (operationState.control.status === "cancel_requested") {
		result.push(...operationState.control.drainedSteer, ...operationState.control.drainedFollowUp);
	}
	return result;
}

function addStructuralRegister(
	inventory: HydrationInventory,
	operationId: string,
	structural: StructuralDecision,
): void {
	inventory.registers.push({ namespace: "op.preparation", key: `${operationId}:${structural.taskId}` });
}

function collectPhaseInventory(inventory: HydrationInventory, operationId: string, phase: RunPhase): void {
	switch (phase.kind) {
		case "checkpoint":
			inventory.entryIds.add(phase.triggerEntryId);
			return;
		case "assistant":
			inventory.entryIds.add(phase.generation.context.triggerEntryId);
			return;
		case "tools":
			inventory.entryIds.add(phase.batch.assistantEntryId);
			if (phase.batch.argumentAuthority.kind === "adaptive_tool_batch_entry") {
				inventory.entryIds.add(phase.batch.argumentAuthority.entryId);
			}
			for (const call of phase.batch.calls) {
				if (
					call.status === "effect_pending" &&
					phase.batch.argumentAuthority.kind === "standard_tool_args_registers"
				) {
					inventory.registers.push({
						namespace: "op.tool_args",
						key: `${operationId}:${phase.batch.turnId}:${call.sourceIndex}`,
					});
				}
				if (call.status === "completed") inventory.entryIds.add(call.resultEntryId);
			}
			return;
		case "compaction":
			addStructuralRegister(inventory, operationId, phase.structural);
			collectPhaseInventory(inventory, operationId, phase.resumeAfter);
			return;
		case "deferred":
			inventory.entryIds.add(phase.deferred.sourceEntryId);
			return;
		case "failure_drain":
			if (phase.provenance.kind === "response") inventory.entryIds.add(phase.provenance.entryId);
			return;
	}
}

function collectInventory(
	laneState: LaneState,
	leafId: string | null,
	operation: Operation | undefined,
	operationState: OperationState | undefined,
): HydrationInventory {
	const inventory: HydrationInventory = { entryIds: new Set<string>(), registers: [] };
	if (leafId !== null) inventory.entryIds.add(leafId);
	for (const id of pendingIds(laneState, operationState)) {
		inventory.registers.push({ namespace: "pending.entry", key: id });
	}
	if (operation === undefined || operationState === undefined) return inventory;
	if (operation.sourceLeafId !== null) inventory.entryIds.add(operation.sourceLeafId);
	if (operation.intent.kind === "run") {
		for (const id of operation.intent.promptEntryIds) inventory.entryIds.add(id);
	} else if (operation.intent.kind === "navigation" && operation.intent.targetId !== null) {
		inventory.entryIds.add(operation.intent.targetId);
	}
	if (operationState.kind === "run") {
		if (operationState.latestAssistantEntryId !== null) inventory.entryIds.add(operationState.latestAssistantEntryId);
		collectPhaseInventory(inventory, operation.operationId, operationState.phase);
	} else if (operationState.kind === "compaction") {
		addStructuralRegister(inventory, operation.operationId, operationState.structural);
	} else if (operationState.summarize) {
		addStructuralRegister(inventory, operation.operationId, operationState.phase.structural);
	}
	return inventory;
}

async function hydrate(
	session: Session,
	inventory: HydrationInventory,
): Promise<{
	entries: ReadonlyMap<string, Entry>;
	registers: Register[];
	loaded: ReadonlyMap<string, Entry | Register>;
}> {
	const entryIds = [...inventory.entryIds];
	const [entries, registers] = await Promise.all([
		entryIds.length === 0 ? Promise.resolve(new Map<string, Entry>()) : session.getEntries(entryIds),
		Promise.all(inventory.registers.map(({ namespace, key }) => session.getRegister(namespace, key))),
	]);
	const hydratedRegisters: Register[] = [];
	const loaded = new Map<string, Entry | Register>();
	for (const id of entryIds) {
		const entry = entries.get(id);
		if (entry === undefined) corruption(`Required entry ${id} is missing`);
		loaded.set(id, entry);
	}
	for (let index = 0; index < inventory.registers.length; index++) {
		const reference = inventory.registers[index]!;
		const register = registers[index];
		if (register === undefined) corruption(`Required register ${reference.namespace}/${reference.key} is missing`);
		hydratedRegisters.push(register);
		loaded.set(`${register.namespace}/${register.key}`, register);
	}
	return { entries, registers: hydratedRegisters, loaded };
}

function validateOperationCompatibility(operation: Operation, state: OperationState, lane: string): void {
	if (operation.lane !== lane)
		corruption(`Operation ${operation.operationId} belongs to lane ${operation.lane}, not ${lane}`);
	if (operation.intent.kind !== state.kind) {
		corruption(
			`Operation ${operation.operationId} intent ${operation.intent.kind} is incompatible with ${state.kind} state`,
		);
	}
	if (state.kind === "navigation") validateNavigation(operation, state);
	if (state.kind === "run" && state.phase.kind === "tools") validateToolBatch(state.phase.batch);
}

function validateNavigation(operation: Operation, state: NavigationState): void {
	if (operation.intent.kind !== "navigation") corruption(`Navigation state has non-navigation metadata`);
	if (operation.intent.targetId !== state.targetId || operation.intent.summarize !== state.summarize) {
		corruption(`Navigation state does not match operation intent`);
	}
}

function validateToolBatch(batch: ToolBatch): void {
	const sourceIndices = batch.calls.map((call) => call.sourceIndex);
	const uniqueIndices = new Set(sourceIndices);
	const uniqueResults = new Set(batch.calls.map((call) => call.resultEntryId));
	if (uniqueIndices.size !== batch.calls.length || uniqueResults.size !== batch.calls.length) {
		corruption(`Tool batch contains duplicate source indices or result ids`);
	}
	for (let index = 0; index < sourceIndices.length; index++) {
		if (sourceIndices[index] !== index) corruption(`Tool batch source indices must be complete and ordered`);
	}
	if (batch.argumentAuthority.kind === "adaptive_tool_batch_entry") {
		if (batch.argumentAuthority.entryId.length === 0) corruption(`Adaptive tool batch authority is empty`);
	}
}

function validateControl(control: Control, state: OperationState): void {
	if (control.status !== "cancel_requested") return;
	if (state.kind === "navigation" && control.drainedSteer.length + control.drainedFollowUp.length > 0) {
		corruption(`Navigation cancellation cannot own run queue items`);
	}
}

function validateEntries(
	operation: Operation | undefined,
	state: OperationState | undefined,
	entries: ReadonlyMap<string, Entry>,
): void {
	if (operation?.intent.kind === "run") {
		for (const id of operation.intent.promptEntryIds) {
			if (entries.get(id)?.type !== "message") corruption(`Run prompt entry ${id} is not a message`);
		}
	}
	if (state?.kind === "run") {
		if (state.latestAssistantEntryId !== null) {
			const latest = entries.get(state.latestAssistantEntryId);
			if (latest?.type !== "message" || latest.message.role !== "assistant") {
				corruption(`Latest assistant entry ${state.latestAssistantEntryId} is invalid`);
			}
		}
		if (state.phase.kind === "tools") {
			const assistant = entries.get(state.phase.batch.assistantEntryId);
			if (assistant?.type !== "message" || assistant.message.role !== "assistant") {
				corruption(`Tool batch assistant entry ${state.phase.batch.assistantEntryId} is invalid`);
			}
			for (const call of state.phase.batch.calls) {
				if (call.status !== "completed") continue;
				const result = entries.get(call.resultEntryId);
				if (result?.type !== "message" || result.message.role !== "toolResult") {
					corruption(`Completed tool result ${call.resultEntryId} is invalid`);
				}
			}
		}
	}
}

function messagePayload(entry: Register<"pending.entry">): AgentMessage | undefined {
	if (entry.value.type !== "message" || entry.value.payload === undefined) return undefined;
	return entry.value.payload as unknown as AgentMessage;
}

function promptForSuspension(operation: Operation, entries: ReadonlyMap<string, Entry>): AgentMessage[] | undefined {
	if (operation.intent.kind !== "run") return undefined;
	const prompt = operation.intent.promptEntryIds
		.map((id) => entries.get(id))
		.filter((entry): entry is Extract<Entry, { type: "message" }> => entry?.type === "message")
		.map((entry) => entry.message);
	return prompt.length === 0 ? undefined : prompt;
}

function drainedForSuspension(
	state: OperationState,
	registers: readonly Register[],
): SuspendedOperation["aborting"] | undefined {
	if (state.kind !== "run" || state.control.status !== "cancel_requested") return undefined;
	const byKey = new Map(
		registers
			.filter((register): register is Register<"pending.entry"> => register.namespace === "pending.entry")
			.map((register) => [register.key, register]),
	);
	return {
		steer: state.control.drainedSteer
			.map((id) => messagePayload(byKey.get(id)!))
			.filter((value) => value !== undefined),
		followUp: state.control.drainedFollowUp
			.map((id) => messagePayload(byKey.get(id)!))
			.filter((value) => value !== undefined),
	};
}

export function toSuspendedOperation(restored: Extract<RestoredLane, { kind: "suspended" }>): SuspendedOperation {
	const { operation, state, configuration } = restored.current;
	const entries = new Map<string, Entry>();
	const registers: Register[] = [];
	for (const value of restored.loaded.values()) {
		if ("namespace" in value) registers.push(value);
		else entries.set(value.id, value);
	}
	const deferred =
		state.kind === "run" && state.phase.kind === "deferred"
			? (() => {
					const source = entries.get(state.phase.deferred.sourceEntryId);
					if (
						source?.type !== "message" ||
						source.message.role !== "assistant" ||
						source.message.stopReason !== "deferred"
					) {
						return undefined;
					}
					return source.message.deferred;
				})()
			: undefined;
	return {
		lane: operation.lane,
		operationId: operation.operationId,
		kind: state.kind,
		reason: "crash",
		startedAt: operation.startedAt,
		...(promptForSuspension(operation, entries) === undefined
			? {}
			: { prompt: promptForSuspension(operation, entries) }),
		...(deferred === undefined ? {} : { deferred }),
		...(drainedForSuspension(state, registers) === undefined
			? {}
			: { aborting: drainedForSuspension(state, registers) }),
		missing: { tools: [...configuration.activeToolNames], models: [] },
	};
}

export async function restoreLane(session: Session, lane: string): Promise<RestoredLane> {
	const configurationRegister = requireRegister(await session.getRegister("lane.config", lane), "lane.config", lane);
	const laneStateRegister = requireRegister(await session.getRegister("lane.state", lane), "lane.state", lane);
	const leafRegister = requireRegister(await session.getRegister("lane.leaf", lane), "lane.leaf", lane);
	const operationId = laneStateRegister.value.currentOperationId;
	const operationRegister =
		operationId === null
			? undefined
			: requireRegister(await session.getRegister("op.meta", operationId), "op.meta", operationId);
	const operationStateRegister =
		operationId === null
			? undefined
			: requireRegister(await session.getRegister("op.state", operationId), "op.state", operationId);
	// A queued id may only ever appear in exactly one pending list per commit
	// boundary; cross-list duplicates would make cancellation and consumption
	// ambiguous.
	const queuedIds = pendingIds(laneStateRegister.value, operationStateRegister?.value);
	const seenQueued = new Set<string>();
	for (const id of queuedIds) {
		if (seenQueued.has(id)) corruption(`Pending id ${id} is queued in more than one list`);
		seenQueued.add(id);
	}
	const inventory = collectInventory(
		laneStateRegister.value,
		leafRegister.value,
		operationRegister?.value,
		operationStateRegister?.value,
	);
	const hydrated = await hydrate(session, inventory);
	validateEntries(operationRegister?.value, operationStateRegister?.value, hydrated.entries);

	if (operationId === null) {
		return {
			kind: "idle",
			lane,
			leafId: leafRegister.value,
			laneState: laneStateRegister.value,
			laneStateSeq: laneStateRegister.seq,
		};
	}
	const operation = operationRegister!.value;
	const state = operationStateRegister!.value;
	if (operation.operationId !== operationId) corruption(`Operation register key does not match its value`);
	validateOperationCompatibility(operation, state, lane);
	validateControl(state.control, state);
	return {
		kind: "suspended",
		current: {
			operation,
			state,
			operationStateSeq: operationStateRegister!.seq,
			laneState: laneStateRegister.value,
			laneStateSeq: laneStateRegister.seq,
			leafId: leafRegister.value,
			configuration: configurationRegister.value,
			configurationSeq: configurationRegister.seq,
		},
		loaded: hydrated.loaded,
	};
}
