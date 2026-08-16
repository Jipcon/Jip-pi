import {
	type Api,
	type AssistantMessage,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness, HarnessClosedError, InMemorySessionRepo } from "../../src/harness-v4.ts";

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

async function createRuntime() {
	const faux = fauxProvider({ provider: "idle-provider", api: "idle-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const repo = new InMemorySessionRepo({ now: () => 2_800_000_000_000 });
	const session = await repo.create({ id: "idle" });
	const { harness } = await AgentHarness.create({ session, models, model });
	return { faux, harness, model, models, repo, session };
}

/** Blocks the provider until the operation signal aborts or a manual release fires. */
function blockingProviderStep(
	firstRequest: { promise: Promise<void>; resolve: () => void },
	release?: { promise: Promise<void>; resolve: () => void },
) {
	return (_context: unknown, options: { signal?: AbortSignal } | undefined) => {
		firstRequest.resolve();
		return new Promise<AssistantMessage>((resolve) => {
			const finish = () => resolve(fauxAssistantMessage(""));
			if (options?.signal?.aborted) {
				(release === undefined ? Promise.resolve() : release.promise).then(finish);
				return;
			}
			options?.signal?.addEventListener(
				"abort",
				() => {
					(release === undefined ? Promise.resolve() : release.promise).then(finish);
				},
				{ once: true },
			);
			release?.promise.then(() => {
				if (!options?.signal?.aborted) finish();
			});
		});
	};
}

function waitMs(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

describe("Harness v4 R6 idle waiters", () => {
	it("resolves a single waiter only after the in-flight run and its driver finish", async () => {
		const { faux, harness } = await createRuntime();
		const firstRequest = createDeferred();
		const release = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest, release)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;

		let resolved = false;
		const idle = harness.waitForIdle().then(() => {
			resolved = true;
		});
		await Promise.race([idle, waitMs(30)]);
		expect(resolved).toBe(false);
		release.resolve();
		await run;
		await idle;
		expect(resolved).toBe(true);
		await harness.close();
	});

	it("resolves multiple waiters together", async () => {
		const { faux, harness } = await createRuntime();
		const firstRequest = createDeferred();
		const release = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest, release)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		const order: string[] = [];
		const first = harness.waitForIdle().then(() => {
			order.push("first");
		});
		const second = harness.waitForIdle().then(() => {
			order.push("second");
		});
		release.resolve();
		await run;
		await Promise.all([first, second]);
		expect(order.sort()).toEqual(["first", "second"]);
		await harness.close();
	});

	it("does not block the next operation after the waiters resolve", async () => {
		const { faux, harness } = await createRuntime();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.waitForIdle();
		await harness.prompt("first");
		await harness.waitForIdle();
		const second = harness.prompt("second");
		await expect(second).resolves.toMatchObject({ ok: true, value: { kind: "completed" } });
		expect(faux.state.callCount).toBe(2);
		await harness.close();
	});

	it("runs runWhenIdle callbacks at the idle boundary and propagates errors", async () => {
		const { faux, harness } = await createRuntime();
		faux.setResponses([fauxAssistantMessage("done")]);
		const order: string[] = [];
		await harness.runWhenIdle(async () => {
			order.push("callback");
		});
		expect(order).toEqual(["callback"]);
		await expect(
			harness.runWhenIdle(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		// The lane stays usable after a throwing callback.
		expect(await harness.prompt("after throw")).toMatchObject({ ok: true, value: { kind: "completed" } });
		await harness.close();
	});

	it("holds the lane reservation during the callback and releases it after", async () => {
		const { faux, harness } = await createRuntime();
		faux.setResponses([fauxAssistantMessage("queued")]);
		const started = createDeferred();
		const release = createDeferred();
		const callbackDone = harness.runWhenIdle(async () => {
			started.resolve();
			await release.promise;
		});
		await started.promise;
		// The reservation blocks new admissions until the callback returns.
		const admitted = harness.prompt("blocked");
		const raced = await Promise.race([
			admitted.then(() => "settled" as const),
			waitMs(50).then(() => "pending" as const),
		]);
		expect(raced).toBe("pending");
		release.resolve();
		await callbackDone;
		await expect(admitted).resolves.toMatchObject({ ok: true, value: { kind: "completed" } });
		await harness.close();
	});

	it("close rejects a not-yet-started runWhenIdle callback", async () => {
		const { faux, harness } = await createRuntime();
		const firstRequest = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		const pending = harness.runWhenIdle(async () => {
			throw new Error("must not run");
		});
		const closing = Promise.all([harness.close(), run]).then(([, result]) => result);
		await expect(pending).rejects.toBeInstanceOf(HarnessClosedError);
		await expect(closing).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });
	});

	it("close waits for an already-running callback to exit", async () => {
		const { harness } = await createRuntime();
		const started = createDeferred();
		const release = createDeferred();
		const callbackDone = harness.runWhenIdle(async () => {
			started.resolve();
			await release.promise;
		});
		await started.promise;
		const closing = harness.close();
		let closed = false;
		void closing.then(() => {
			closed = true;
		});
		await waitMs(30);
		expect(closed).toBe(false);
		release.resolve();
		await callbackDone;
		await closing;
		expect(closed).toBe(true);
	});

	it("rejects waitForIdle registered after close", async () => {
		const { harness } = await createRuntime();
		await harness.close();
		await expect(harness.waitForIdle()).rejects.toBeInstanceOf(HarnessClosedError);
	});
});
