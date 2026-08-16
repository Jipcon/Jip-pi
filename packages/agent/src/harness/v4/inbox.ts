import type { AgentMessage, QueueMode } from "../../types.ts";
import type { PendingEntry } from "./base.ts";
import type { Inbox, RunState } from "./operation.ts";
import { SessionError } from "./storage.ts";
import type { InboxDrainEntry, InboxDrainPlan, PlannerInputs } from "./surface.ts";

/**
 * Pure R5 inbox logic: pending payload decoding, queue-mode eligibility,
 * projection classification, and drain selection. No storage reads or writes;
 * the planner feeds it the bounded hydration map plus process-local
 * configuration, so every decision is re-decidable after crash.
 */

export interface InboxSelection {
	consumedWrites: string[];
	consumedSteer: string[];
	consumedFollowUp: string[];
	entries: InboxDrainEntry[];
	/** Any consumed item projects into provider context. */
	projected: boolean;
}

/** Reads a pending register from the bounded hydration map by its queue id. */
export function requirePendingEntry(loaded: PlannerInputs["loaded"], id: string): PendingEntry {
	const value = loaded.get(`pending.entry/${id}`);
	if (value === undefined || !("namespace" in value)) {
		throw new SessionError("corruption", `Pending register ${id} is missing`);
	}
	return structuredClone(value.value) as PendingEntry;
}

export function pendingMessagePayload(loaded: PlannerInputs["loaded"], id: string): AgentMessage {
	const pending = requirePendingEntry(loaded, id);
	if (pending.type !== "message") {
		throw new SessionError("corruption", `Pending item ${id} has no message payload`);
	}
	return structuredClone(pending.payload);
}

/** `all` consumes every eligible item; `one-at-a-time` only the oldest. */
export function eligibleQueueIds(ids: readonly string[], mode: QueueMode): string[] {
	if (ids.length === 0) return [];
	return mode === "all" ? [...ids] : [ids[0]!];
}

/** A pending custom write projects iff its customType has a registered projector. */
export function customWriteProjects(customType: string, projectedTypes: ReadonlySet<string> | undefined): boolean {
	return projectedTypes?.has(customType) === true;
}

export function inboxEmpty(inbox: Inbox): boolean {
	return inbox.steer.length === 0 && inbox.followUp.length === 0 && inbox.writes.length === 0;
}

export function remainingInbox(inbox: Inbox, selection: InboxSelection): Inbox {
	return {
		steer: inbox.steer.slice(selection.consumedSteer.length),
		followUp: inbox.followUp.slice(selection.consumedFollowUp.length),
		writes: inbox.writes.slice(selection.consumedWrites.length),
	};
}

/**
 * Selects the drain consumption for one checkpoint or failure boundary.
 * Writes are always fully applied; steer and follow-up obey the captured queue
 * modes. Follow-up is only eligible once the assistant/tool continuation is
 * exhausted (`includeFollowUp`). Returns undefined when there is nothing to
 * consume, so the planner falls through to generation or terminal handling.
 */
export function selectInboxDrain(
	inbox: Inbox,
	settings: { steeringMode: QueueMode; followUpMode: QueueMode },
	includeFollowUp: boolean,
	loaded: PlannerInputs["loaded"],
	projectedTypes: ReadonlySet<string> | undefined,
): InboxSelection | undefined {
	if (inbox.writes.length === 0 && inbox.steer.length === 0 && (!includeFollowUp || inbox.followUp.length === 0)) {
		return undefined;
	}
	const consumedWrites = [...inbox.writes];
	const consumedSteer = eligibleQueueIds(inbox.steer, settings.steeringMode);
	const consumedFollowUp = includeFollowUp ? eligibleQueueIds(inbox.followUp, settings.followUpMode) : [];
	const entries: InboxDrainEntry[] = [];
	let projected = false;
	const add = (entry: InboxDrainEntry, projects: boolean): void => {
		entries.push(entry);
		if (projects) projected = true;
	};
	for (const id of consumedWrites) {
		const pending = requirePendingEntry(loaded, id);
		if (pending.type === "message") {
			add({ id, type: "message", message: pendingMessagePayload(loaded, id) }, true);
		} else {
			add(
				{
					id,
					type: "custom",
					customType: pending.customType,
					...(pending.payload === undefined ? {} : { data: structuredClone(pending.payload) }),
				},
				customWriteProjects(pending.customType, projectedTypes),
			);
		}
	}
	for (const id of consumedSteer) add({ id, type: "message", message: pendingMessagePayload(loaded, id) }, true);
	for (const id of consumedFollowUp) add({ id, type: "message", message: pendingMessagePayload(loaded, id) }, true);
	return { consumedWrites, consumedSteer, consumedFollowUp, entries, projected };
}

/**
 * Successor checkpoint for a drain that consumed projecting input: a fresh
 * need_assistant boundary whose trigger is the last materialized entry and
 * whose skipInboxOnce forces the next planner pass into generation instead of
 * draining again. Crash between this commit and generation therefore cannot
 * double-consume.
 */
export function projectedCheckpointPhase(selection: InboxSelection): InboxDrainPlan["next"]["phase"] {
	const last = selection.entries.at(-1);
	if (last === undefined) {
		throw new SessionError("corruption", "Projected inbox drain has no trigger entry");
	}
	return {
		kind: "checkpoint",
		continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
		triggerEntryId: last.id,
		skipInboxOnce: true,
	};
}

/** Builds the complete drain plan for one boundary; the phase stays untouched when nothing projects. */
export function buildInboxDrainPlan(state: RunState, selection: InboxSelection): InboxDrainPlan {
	const phase = state.phase;
	const source: InboxDrainPlan["source"] =
		phase.kind === "checkpoint"
			? { kind: "checkpoint", continuation: phase.continuation.kind }
			: { kind: "failure_drain" };
	const next: RunState = structuredClone(state);
	next.inbox = remainingInbox(state.inbox, selection);
	if (selection.projected) next.phase = projectedCheckpointPhase(selection);
	return {
		next,
		entries: selection.entries,
		consumedWrites: selection.consumedWrites,
		consumedSteer: selection.consumedSteer,
		consumedFollowUp: selection.consumedFollowUp,
		source,
	};
}
