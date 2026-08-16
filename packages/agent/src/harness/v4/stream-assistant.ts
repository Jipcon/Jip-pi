import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ProviderResponse,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import type { AgentEventSink } from "../../agent-loop.ts";
import type { SettledAssistantMessage } from "./base.ts";
import { SessionCodec, validateUsage } from "./codec.ts";
import type { StreamAssistant, StreamAssistantConfig } from "./surface.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const RESPONSE_CODEC: SessionCodec = new SessionCodec();

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function validUsage(value: unknown): Usage | undefined {
	try {
		validateUsage(value);
		return structuredClone(value as Usage);
	} catch {
		return undefined;
	}
}

function omitUndefined(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value !== "object" || value === null) return value;
	if (Array.isArray(value)) {
		if (
			Object.getPrototypeOf(value) !== Array.prototype ||
			Object.getOwnPropertySymbols(value).length > 0 ||
			Object.getOwnPropertyNames(value).length !== value.length + 1
		) {
			return value;
		}
		if (seen.has(value)) throw new Error("provider message contains a cycle");
		seen.add(value);
		const normalized = value.map((item) => omitUndefined(item, seen));
		seen.delete(value);
		return normalized;
	}
	const prototype = Object.getPrototypeOf(value);
	const keys = Object.keys(value);
	if (
		(prototype !== Object.prototype && prototype !== null) ||
		Object.getOwnPropertySymbols(value).length > 0 ||
		Object.getOwnPropertyNames(value).length !== keys.length ||
		keys.some((key) => !("value" in Object.getOwnPropertyDescriptor(value, key)!))
	) {
		return value;
	}
	if (seen.has(value)) throw new Error("provider message contains a cycle");
	seen.add(value);
	const normalized: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		if (descriptor.value !== undefined) normalized[key] = omitUndefined(descriptor.value, seen);
	}
	seen.delete(value);
	return normalized;
}

function syntheticProviderError(
	config: StreamAssistantConfig,
	error: unknown,
	candidate?: Partial<AssistantMessage>,
): SettledAssistantMessage {
	const detail = errorMessage(error);
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: validUsage(candidate?.usage) ?? structuredClone(ZERO_USAGE),
		stopReason: "error",
		errorMessage: `Invalid provider response: ${detail}`,
		timestamp: Date.now(),
	};
}

function validateSettledMessage(message: unknown, config: StreamAssistantConfig): SettledAssistantMessage {
	const normalized = omitUndefined(message);
	RESPONSE_CODEC.validateMessage(normalized, "provider.message");
	if ((normalized as AssistantMessage).role !== "assistant") {
		throw new Error("final message must have assistant role");
	}
	const assistant = normalized as SettledAssistantMessage;
	if (assistant.stopReason === "aborted" && !config.signal.aborted) {
		throw new Error("aborted stop reason requires the Harness-owned signal");
	}
	return structuredClone(assistant);
}

async function emitFinal(
	emit: AgentEventSink,
	started: boolean,
	message: SettledAssistantMessage,
): Promise<SettledAssistantMessage> {
	if (!started) await emit({ type: "message_start", message: structuredClone(message) });
	await emit({ type: "message_end", message: structuredClone(message) });
	return message;
}

export const streamAssistant: StreamAssistant = async (messages, config, emit): Promise<SettledAssistantMessage> => {
	let responseMetadata: ProviderResponse | undefined;
	let started = false;
	let stream: AssistantMessageEventStream;
	try {
		const providerMessages = await config.toProviderMessages(
			config.transformContext === undefined
				? structuredClone(messages)
				: await config.transformContext(structuredClone(messages), config.signal),
		);
		const context: Context = {
			systemPrompt: config.systemPrompt ?? "",
			messages: providerMessages,
			...(config.tools === undefined ? {} : { tools: config.tools }),
		};
		const options: SimpleStreamOptions = {
			...(config.streamOptions ?? {}),
			...(config.thinkingLevel === "off" ? {} : { reasoning: config.thinkingLevel }),
			telemetryContext: config.telemetryContext,
			signal: config.signal,
			...(config.transformPayload === undefined
				? {}
				: {
						onPayload: (payload: unknown) => config.transformPayload?.(payload, config.model),
					}),
			onResponse: (response) => {
				responseMetadata = structuredClone(response);
			},
		};
		stream = config.models.streamSimple(config.model, context, options);
	} catch (error) {
		return emitFinal(emit, false, syntheticProviderError(config, error));
	}

	let finalMessage: AssistantMessage;
	try {
		for await (const event of stream) {
			switch (event.type) {
				case "start":
					started = true;
					await emit({ type: "message_start", message: structuredClone(event.partial) });
					break;
				case "text_start":
				case "text_delta":
				case "text_end":
				case "thinking_start":
				case "thinking_delta":
				case "thinking_end":
				case "toolcall_start":
				case "toolcall_delta":
				case "toolcall_end":
					await emit({
						type: "message_update",
						message: structuredClone(event.partial),
						assistantMessageEvent: structuredClone(event as AssistantMessageEvent),
					});
					break;
				case "done":
				case "error":
					break;
			}
		}
		finalMessage = await stream.result();
	} catch (error) {
		return emitFinal(emit, started, syntheticProviderError(config, error));
	}

	let settled: SettledAssistantMessage;
	try {
		settled = validateSettledMessage(finalMessage, config);
	} catch (error) {
		return emitFinal(emit, started, syntheticProviderError(config, error, finalMessage));
	}

	let transformed: unknown = settled;
	if (config.transformResponse !== undefined) {
		try {
			transformed = await config.transformResponse(structuredClone(settled), {
				...(responseMetadata?.status === undefined ? {} : { status: responseMetadata.status }),
				...(responseMetadata?.headers === undefined ? {} : { headers: responseMetadata.headers }),
			});
		} catch {
			transformed = settled;
		}
	}
	try {
		return emitFinal(emit, started, validateSettledMessage(transformed, config));
	} catch {
		return emitFinal(emit, started, settled);
	}
};
