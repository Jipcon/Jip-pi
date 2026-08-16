import { Agent, type AgentMessage, type AgentOptions } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LeafTurnSemanticExecutor, LeafTurnSemanticObservation } from "./leaf-turn-executor.ts";

export type LegacyAgentLeafAdapterOptions = Omit<AgentOptions, "shouldStopAfterTurn">;

export class LegacyLeafTurnBusy extends Error {
	constructor() {
		super("LegacyAgentLeafAdapter is already executing a turn");
		this.name = "LegacyLeafTurnBusy";
	}
}

export class LegacyLeafTurnInvariantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LegacyLeafTurnInvariantError";
	}
}

type ObservedTurn = {
	message: AgentMessage;
	toolResults: ToolResultMessage[];
};

/**
 * Process-local characterization Adapter over the legacy Agent loop.
 *
 * It deliberately does not implement LeafTurnExecutor: the legacy loop has no
 * durable run, entry, or checkpoint identities to return.
 */
export class LegacyAgentLeafAdapter implements LeafTurnSemanticExecutor {
	private readonly agent: Agent;
	private executing = false;

	constructor(options: LegacyAgentLeafAdapterOptions) {
		this.agent = new Agent({
			...options,
			shouldStopAfterTurn: () => true,
		});
	}

	async execute(prompt: AgentMessage | AgentMessage[]): Promise<LeafTurnSemanticObservation> {
		if (this.executing) {
			throw new LegacyLeafTurnBusy();
		}

		this.executing = true;
		const turns: ObservedTurn[] = [];
		const unsubscribe = this.agent.subscribe((event) => {
			if (event.type === "turn_end") {
				turns.push({
					message: event.message,
					toolResults: event.toolResults.slice(),
				});
			}
		});

		try {
			await this.agent.prompt(prompt);
		} finally {
			unsubscribe();
			this.executing = false;
		}

		if (turns.length !== 1) {
			throw new LegacyLeafTurnInvariantError(`Expected exactly one completed turn, observed ${turns.length}`);
		}

		const turn = turns[0];
		if (!turn || turn.message.role !== "assistant") {
			throw new LegacyLeafTurnInvariantError("Completed turn did not contain an assistant message");
		}

		const message: AssistantMessage = turn.message;
		return {
			message,
			toolResults: turn.toolResults,
			usage: message.usage,
		};
	}

	abort(): void {
		this.agent.abort();
	}
}
