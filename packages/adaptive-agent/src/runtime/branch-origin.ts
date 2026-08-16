import type { JsonValue, Session } from "@earendil-works/pi-agent-core/harness-v4";
import { BranchOriginConflictError, BranchOriginFrozenError, WorkspaceManagerFault } from "./workspace-errors.ts";

/**
 * Durable branch-origin ownership (DESIGN §12.2 Stage 7, S7.6). The freeze
 * marker is a `fact.custom` register on the source session itself, so it
 * survives crash/reopen with the same file as the session and never depends
 * on process-local state. Stage 7 delivers the primitive; wiring every v4
 * advance/resume/prompt/queue/write/config path through the guard is the
 * Stage 8 controller's job.
 */

export interface BranchOriginRecord {
	schemaVersion: 1;
	sessionId: string;
	lane: string;
	operationId: string;
	groupId: string;
	frozenAt: number;
}

const BRANCH_ORIGIN_REGISTER_PREFIX = "pi.adaptive.branch_origin";

export function branchOriginRegisterKey(lane: string): string {
	return `${BRANCH_ORIGIN_REGISTER_PREFIX}:${lane}`;
}

export interface BranchOriginRegistry {
	/** Idempotent per lane: same group re-freeze is a no-op, a different group faults. */
	freeze(input: { session: Session; lane: string; operationId: string; groupId: string }): Promise<BranchOriginRecord>;
	/** Durably removes the marker; a no-op when nothing is frozen. */
	unfreeze(input: { session: Session; lane: string }): Promise<void>;
	/** Reads the durable marker (undefined when not frozen). */
	get(input: { session: Session; lane: string }): Promise<BranchOriginRecord | undefined>;
	/** Throws BranchOriginFrozen when a marker exists. */
	assertAvailable(input: { session: Session; lane: string }): Promise<void>;
}

export class SessionRegisterBranchOriginRegistry implements BranchOriginRegistry {
	private readonly now: () => number;

	constructor(options: { now?: () => number } = {}) {
		this.now = options.now ?? Date.now;
	}

	async freeze(input: {
		session: Session;
		lane: string;
		operationId: string;
		groupId: string;
	}): Promise<BranchOriginRecord> {
		const key = branchOriginRegisterKey(input.lane);
		const existing = await this.get({ session: input.session, lane: input.lane });
		if (existing !== undefined) {
			if (
				existing.groupId === input.groupId &&
				existing.operationId === input.operationId &&
				existing.sessionId === input.session.metadata.id
			) {
				return existing;
			}
			throw new BranchOriginConflictError(
				`source lane ${input.lane} is already a frozen branch origin of group ${existing.groupId}`,
			);
		}
		const record: BranchOriginRecord = {
			schemaVersion: 1,
			sessionId: input.session.metadata.id,
			lane: input.lane,
			operationId: input.operationId,
			groupId: input.groupId,
			frozenAt: this.now(),
		};
		await input.session.commit({
			writes: [
				{ kind: "register", op: "set", namespace: "fact.custom", key, value: record as unknown as JsonValue },
			],
		});
		return record;
	}

	async unfreeze(input: { session: Session; lane: string }): Promise<void> {
		const key = branchOriginRegisterKey(input.lane);
		const existing = await this.get({ session: input.session, lane: input.lane });
		if (existing === undefined) return;
		await input.session.commit({
			writes: [{ kind: "register", op: "delete", namespace: "fact.custom", key }],
		});
	}

	async get(input: { session: Session; lane: string }): Promise<BranchOriginRecord | undefined> {
		const key = branchOriginRegisterKey(input.lane);
		let register: Awaited<ReturnType<Session["getRegister"]>>;
		try {
			register = await input.session.getRegister("fact.custom", key);
		} catch (error) {
			throw new WorkspaceManagerFault(
				`failed to read branch-origin register for lane ${input.lane}`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		if (register === undefined) return undefined;
		const value = register.value as unknown;
		if (
			typeof value !== "object" ||
			value === null ||
			(value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
			typeof (value as { sessionId?: unknown }).sessionId !== "string" ||
			typeof (value as { lane?: unknown }).lane !== "string" ||
			typeof (value as { operationId?: unknown }).operationId !== "string" ||
			typeof (value as { groupId?: unknown }).groupId !== "string" ||
			typeof (value as { frozenAt?: unknown }).frozenAt !== "number"
		) {
			throw new WorkspaceManagerFault(`branch-origin register ${key} is corrupt`);
		}
		return structuredClone(value as BranchOriginRecord);
	}

	async assertAvailable(input: { session: Session; lane: string }): Promise<void> {
		const frozen = await this.get({ session: input.session, lane: input.lane });
		if (frozen === undefined) return;
		throw new BranchOriginFrozenError(
			`lane ${input.lane} is a read-only branch origin of group ${frozen.groupId}; advance/resume is frozen`,
		);
	}
}
