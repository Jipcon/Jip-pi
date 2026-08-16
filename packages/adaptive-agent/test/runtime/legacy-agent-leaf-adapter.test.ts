import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { LegacyAgentLeafAdapter, LegacyLeafTurnBusy } from "../../src/index.ts";
import {
	type CreateLeafTurnSemanticFixture,
	createAssistantMessage,
	createDeferred,
	createUserMessage,
	describeLeafTurnSemanticContract,
} from "./leaf-turn-semantic-contract.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

const createLegacyFixture: CreateLeafTurnSemanticFixture = (options) => {
	let providerRequests = 0;
	const firstProviderRequest = createDeferred();
	const streamFn: StreamFn = (_model, _context, streamOptions) => {
		const step = options.providerSteps[providerRequests];
		providerRequests++;
		firstProviderRequest.resolve();

		if (!step) {
			throw new Error(`Unexpected provider request ${providerRequests}`);
		}
		if (step.kind === "throw") {
			throw step.error;
		}

		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			if (step.kind === "message") {
				if (step.message.stopReason === "pending") {
					const error = createAssistantMessage("", "error", "provider returned a pending final message");
					stream.push({ type: "error", reason: "error", error });
				} else if (step.message.stopReason === "error" || step.message.stopReason === "aborted") {
					stream.push({ type: "error", reason: step.message.stopReason, error: step.message });
				} else {
					stream.push({ type: "done", reason: step.message.stopReason, message: step.message });
				}
				return;
			}

			stream.push({ type: "start", partial: createAssistantMessage("") });
			const finishAborted = () => {
				const error = createAssistantMessage("", "aborted", "aborted by contract");
				stream.push({ type: "error", reason: "aborted", error });
			};
			if (streamOptions?.signal?.aborted) {
				finishAborted();
			} else {
				streamOptions?.signal?.addEventListener("abort", finishAborted, { once: true });
			}
		});
		return stream;
	};

	return {
		executor: new LegacyAgentLeafAdapter({
			streamFn,
			initialState: { tools: options.tools ?? [] },
			beforeToolCall: options.beforeToolCall,
			toolExecution: options.toolExecution,
		}),
		providerRequestCount: () => providerRequests,
		firstProviderRequest: firstProviderRequest.promise,
	};
};

describeLeafTurnSemanticContract("LegacyAgentLeafAdapter semantic contract", createLegacyFixture);

describe("LegacyAgentLeafAdapter", () => {
	it("rejects concurrent execute calls", async () => {
		const fixture = createLegacyFixture({ providerSteps: [{ kind: "wait_for_abort" }] });
		const firstExecution = fixture.executor.execute(createUserMessage("first"));
		await fixture.firstProviderRequest;

		await expect(fixture.executor.execute(createUserMessage("second"))).rejects.toBeInstanceOf(LegacyLeafTurnBusy);

		fixture.executor.abort();
		await firstExecution;
	});
});
