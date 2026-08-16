import type { AgentMessage } from "../../types.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "../messages.ts";
import type { CustomEntry, Entry } from "./base.ts";

export type CustomEntryProjector = (
	entry: CustomEntry,
) => AgentMessage | AgentMessage[] | undefined | Promise<AgentMessage | AgentMessage[] | undefined>;

export interface ContextProjectionOptions {
	customEntryProjectors?: Readonly<Record<string, CustomEntryProjector>>;
}

function isProviderSafeMessage(message: AgentMessage): boolean {
	return (
		message.role !== "assistant" ||
		(message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "deferred")
	);
}

/** Projects an oldest-first durable branch into model context without exposing custom entries by default. */
export async function buildContextMessages(
	entries: readonly Entry[],
	options: ContextProjectionOptions = {},
): Promise<AgentMessage[]> {
	let messages: AgentMessage[] = [];
	for (const entry of entries) {
		switch (entry.type) {
			case "message":
				if (isProviderSafeMessage(entry.message)) messages.push(structuredClone(entry.message));
				break;
			case "compaction":
				messages = [
					createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
					...entry.retainedTail.filter(isProviderSafeMessage).map((message) => structuredClone(message)),
				];
				break;
			case "branch_summary":
				messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
				break;
			case "custom": {
				const projector = options.customEntryProjectors?.[entry.customType];
				if (projector === undefined) break;
				const projected = await projector(structuredClone(entry));
				if (projected === undefined) break;
				const candidates = Array.isArray(projected) ? projected : [projected];
				messages.push(...candidates.filter(isProviderSafeMessage).map((message) => structuredClone(message)));
				break;
			}
		}
	}
	return messages;
}
