export class HarnessClosedError extends Error {
	constructor() {
		super("AgentHarness was closed while work was active");
		this.name = "HarnessClosed";
	}
}

export class HarnessFaultError extends Error {
	readonly cause: unknown;

	constructor(cause: unknown) {
		super("AgentHarness faulted because a storage commit failed", { cause });
		this.name = "HarnessFault";
		this.cause = cause;
	}
}

export class HarnessNotImplementedError extends Error {
	readonly operation: string;

	constructor(operation: string) {
		super(`AgentHarness.${operation} is not implemented in Harness Runtime R3`);
		this.name = "HarnessNotImplemented";
		this.operation = operation;
	}
}
