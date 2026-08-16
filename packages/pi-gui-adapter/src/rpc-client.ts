/**
 * RPC client for the Pi RPC subprocess protocol.
 *
 * Responsibilities:
 * - Send JSONL commands over stdin with unique request ids.
 * - Correlate `response` records with pending requests via `id`.
 * - Route non-response records to event / extension-UI handlers.
 * - Time out and reject requests that never get a response.
 */

import { randomUUID } from "node:crypto";
import { JsonlParser } from "./rpc-parser.ts";

/** Structural shape of a Pi RPC command (subset; extra fields allowed). */
export interface PiRpcCommand {
	id?: string;
	type: string;
	[key: string]: unknown;
}

/** Structural shape of a Pi RPC response record. */
export interface PiRpcResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

/** A raw Pi event record (agent_start, message_update, ...). */
export interface PiJsonEvent {
	type: string;
	[key: string]: unknown;
}

/** A raw Pi extension UI request record. */
export interface PiExtensionUiRequest {
	type: "extension_ui_request";
	id: string;
	method: string;
	[key: string]: unknown;
}

export interface RpcRequestResult<T = unknown> {
	success: boolean;
	command: string;
	data?: T;
	error?: string;
}

export interface RpcClientOptions {
	/** Write one JSONL line to the backend's stdin. */
	sendLine: (line: string) => void;
	/** Called for every non-response, non-extension-UI record. */
	onEvent?: (event: PiJsonEvent) => void;
	/** Called for `extension_ui_request` records. */
	onExtensionUiRequest?: (request: PiExtensionUiRequest) => void;
	/** Called for protocol-level problems (e.g. parse error responses, orphan responses). */
	onProtocolError?: (message: string) => void;
	/** Called for malformed JSON lines. */
	onParseError?: (line: string, error: Error) => void;
	/** Default per-request timeout. */
	requestTimeoutMs?: number;
	/** Id generator, injectable for tests. */
	generateId?: () => string;
}

interface PendingRequest {
	resolve: (result: RpcRequestResult) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
}

export class RpcClient {
	private readonly options: RpcClientOptions;
	private readonly parser: JsonlParser;
	private readonly pending = new Map<string, PendingRequest>();
	private closed = false;
	private closedReason = "RPC client closed";

	constructor(options: RpcClientOptions) {
		this.options = options;
		this.parser = new JsonlParser({
			onRecord: (record) => this.handleRecord(record),
			onError: (line, error) => {
				options.onParseError?.(line, error);
			},
		});
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/**
	 * Send a command and resolve when the correlated response arrives.
	 * `timeoutMs: null` disables the client-side timeout for long-running
	 * interactive commands (OAuth login): cancellation is protocol-driven.
	 */
	request<T = unknown>(command: Omit<PiRpcCommand, "id">, timeoutMs?: number | null): Promise<RpcRequestResult<T>> {
		if (this.closed) {
			return Promise.reject(new Error(this.closedReason));
		}
		const id = this.options.generateId ? this.options.generateId() : randomUUID();
		const timeout = timeoutMs === undefined ? (this.options.requestTimeoutMs ?? 30_000) : timeoutMs;

		return new Promise<RpcRequestResult<T>>((resolve, reject) => {
			const timer =
				timeout === null
					? undefined
					: setTimeout(() => {
							this.pending.delete(id);
							reject(new Error(`RPC request timed out after ${timeout}ms: ${command.type}`));
						}, timeout);
			this.pending.set(id, { resolve: resolve as (result: RpcRequestResult) => void, reject, timer });
			this.options.sendLine(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	/** Send an extension UI response (dialog answer) to the backend. */
	respondExtensionUi(id: string, response: Record<string, unknown>): void {
		this.options.sendLine(`${JSON.stringify({ type: "extension_ui_response", id, ...response })}\n`);
	}

	/** Send an OAuth auth prompt response (login answer) to the backend. */
	sendAuthPromptResponse(requestId: string, response: { value?: string; cancelled?: boolean }): void {
		this.options.sendLine(`${JSON.stringify({ type: "auth_prompt_response", requestId, ...response })}\n`);
	}

	/** Feed a stdout chunk into the JSONL parser. */
	pushStdout(chunk: string | Uint8Array): void {
		this.parser.push(chunk);
	}

	/** Flush trailing stdout bytes (backend exited). */
	flushStdout(): void {
		this.parser.flush();
	}

	/** Close the client: reject all pending requests. */
	close(reason = "RPC client closed"): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.closedReason = reason;
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.pending.clear();
	}

	private handleRecord(record: unknown): void {
		if (typeof record !== "object" || record === null) {
			return;
		}
		const typed = record as Record<string, unknown>;
		const type = typed.type;

		if (type === "response") {
			this.handleResponse(typed as unknown as PiRpcResponse);
			return;
		}
		if (type === "extension_ui_request") {
			this.options.onExtensionUiRequest?.(typed as unknown as PiExtensionUiRequest);
			return;
		}
		if (typeof type === "string") {
			this.options.onEvent?.(typed as unknown as PiJsonEvent);
		}
	}

	private handleResponse(response: PiRpcResponse): void {
		if (response.id !== undefined) {
			const pending = this.pending.get(response.id);
			if (!pending) {
				this.options.onProtocolError?.(`Response for unknown request id ${response.id}`);
				return;
			}
			this.pending.delete(response.id);
			clearTimeout(pending.timer);
			pending.resolve({
				success: response.success,
				command: response.command,
				data: response.data,
				error: response.error,
			});
			return;
		}

		// Responses without id: Pi emits these for stdin parse errors.
		this.options.onProtocolError?.(`Protocol error: ${response.command}: ${response.error ?? "no error message"}`);
	}
}
