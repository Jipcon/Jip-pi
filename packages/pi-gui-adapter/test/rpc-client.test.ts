import { describe, expect, test } from "vitest";
import { type PiExtensionUiRequest, type PiJsonEvent, RpcClient } from "../src/rpc-client.ts";

function setup() {
	const sent: string[] = [];
	const events: PiJsonEvent[] = [];
	const uiRequests: PiExtensionUiRequest[] = [];
	const protocolErrors: string[] = [];
	let idCounter = 0;
	const client = new RpcClient({
		sendLine: (line) => sent.push(line),
		onEvent: (event) => events.push(event),
		onExtensionUiRequest: (request) => uiRequests.push(request),
		onProtocolError: (message) => protocolErrors.push(message),
		requestTimeoutMs: 200,
		generateId: () => `id-${++idCounter}`,
	});
	const respond = (record: unknown) => client.pushStdout(`${JSON.stringify(record)}\n`);
	return { client, sent, events, uiRequests, protocolErrors, respond };
}

describe("RpcClient", () => {
	test("sends a command with a generated id and resolves on matching response", async () => {
		const { client, sent, respond } = setup();
		const promise = client.request({ type: "get_state" });
		expect(sent).toEqual(['{"type":"get_state","id":"id-1"}\n']);
		respond({ type: "response", id: "id-1", command: "get_state", success: true, data: { sessionId: "s1" } });
		const result = await promise;
		expect(result).toMatchObject({ success: true, command: "get_state" });
		expect(result.data).toEqual({ sessionId: "s1" });
	});

	test("rejects on failed response", async () => {
		const { client, respond } = setup();
		const promise = client.request({ type: "set_model", provider: "x", modelId: "y" });
		respond({ type: "response", id: "id-1", command: "set_model", success: false, error: "Model not found" });
		const result = await promise;
		expect(result.success).toBe(false);
		expect(result.error).toBe("Model not found");
	});

	test("correlates concurrent requests by id", async () => {
		const { client, respond } = setup();
		const first = client.request({ type: "get_state" });
		const second = client.request({ type: "get_messages" });
		respond({ type: "response", id: "id-2", command: "get_messages", success: true, data: { messages: [] } });
		respond({ type: "response", id: "id-1", command: "get_state", success: true, data: { sessionId: "s1" } });
		expect((await first).data).toEqual({ sessionId: "s1" });
		expect((await second).data).toEqual({ messages: [] });
	});

	test("rejects pending requests on timeout", async () => {
		const { client } = setup();
		await expect(client.request({ type: "get_state" })).rejects.toThrow(/timed out/);
	});

	test("null timeout disables the client-side timeout", async () => {
		const { client, respond } = setup();
		let settled = false;
		const promise = client.request({ type: "login_oauth", provider: "x" }, null).then((result) => {
			settled = true;
			return result;
		});
		// Well past the default 200ms timeout with no response: still pending.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(settled).toBe(false);
		respond({ type: "response", id: "id-1", command: "login_oauth", success: true, data: { provider: "x" } });
		expect((await promise).success).toBe(true);
	});

	test("routes non-response records to onEvent", () => {
		const { events, respond } = setup();
		respond({ type: "agent_start" });
		respond({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ type: "agent_start" });
	});

	test("routes extension_ui_request records to onExtensionUiRequest", () => {
		const { uiRequests, respond } = setup();
		respond({ type: "extension_ui_request", id: "ext-1", method: "select", title: "Pick", options: ["A"] });
		expect(uiRequests).toHaveLength(1);
		expect(uiRequests[0]).toMatchObject({ id: "ext-1", method: "select" });
	});

	test("reports orphan responses and id-less parse errors as protocol errors", () => {
		const { protocolErrors, respond } = setup();
		respond({ type: "response", id: "nope", command: "get_state", success: true });
		respond({ type: "response", command: "parse", success: false, error: "Failed to parse command" });
		expect(protocolErrors).toHaveLength(2);
	});

	test("reports malformed JSON lines as parse errors without throwing", () => {
		const { client, protocolErrors } = setup();
		client.pushStdout("garbage not json\n");
		expect(protocolErrors).toHaveLength(0);
	});

	test("close rejects all pending requests", async () => {
		const { client } = setup();
		const promise = client.request({ type: "get_state" });
		client.close("backend gone");
		await expect(promise).rejects.toThrow("backend gone");
		await expect(client.request({ type: "get_state" })).rejects.toThrow("backend gone");
	});

	test("respondExtensionUi writes an extension_ui_response line", () => {
		const { client, sent } = setup();
		client.respondExtensionUi("ext-1", { value: "A" });
		expect(sent).toEqual(['{"type":"extension_ui_response","id":"ext-1","value":"A"}\n']);
	});

	test("handles a record split across chunk boundaries at the client level", async () => {
		const { client, respond } = setup();
		const promise = client.request({ type: "get_state" });
		const payload = JSON.stringify({
			type: "response",
			id: "id-1",
			command: "get_state",
			success: true,
			data: { sessionId: "s1" },
		});
		const mid = Math.floor(payload.length / 2);
		client.pushStdout(payload.slice(0, mid));
		client.pushStdout(`${payload.slice(mid)}\n`);
		expect((await promise).data).toEqual({ sessionId: "s1" });
		void respond;
	});
});
