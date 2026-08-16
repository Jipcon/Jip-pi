import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, createModels, fauxProvider, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness, InMemorySessionRepo, type Session } from "../../../agent/src/harness-v4.ts";
import {
	BranchOriginBarrier,
	BranchOriginFrozenError,
	PermissiveToolPolicyAdapter,
	SessionRegisterBranchOriginRegistry,
} from "../../src/index.ts";
import type { HarnessV4AdaptiveLane } from "../../src/runtime/harness-leaf-turn-adapter.ts";
import { createBundleFixtures, makeFixedTools } from "./stage5-fixtures.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

interface SurfaceFixture {
	session: Session;
	harness: AgentHarness<undefined>;
	model: Model<Api>;
	barrier: BranchOriginBarrier;
}

async function createSurfaceFixture(): Promise<SurfaceFixture> {
	const repo = new InMemorySessionRepo({ now: () => 5_000_000_000_000 });
	const session = await repo.create({ id: "origin-surface" });
	const faux = fauxProvider({ provider: "origin", api: "origin-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const fixtures = await createBundleFixtures();
	const { harness } = await AgentHarness.create<undefined>({
		session,
		models,
		model,
		tools: makeFixedTools() as unknown as Parameters<typeof AgentHarness.create>[0]["tools"],
		activeToolNames: ["read", "write", "edit", "bash"],
		adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session }),
	});
	const barrier = new BranchOriginBarrier({
		session,
		lane: "main",
		registry: new SessionRegisterBranchOriginRegistry(),
	});
	cleanups.push(() => void harness.close());
	return { session, harness, model, barrier };
}

async function entryCount(session: Session): Promise<number> {
	return (await session.findEntries({})).length;
}

describe("branch-origin full-surface barrier", () => {
	it("blocks every mutation surface with zero writes and zero effects after a durable freeze", async () => {
		const { session, harness, model, barrier } = await createSurfaceFixture();
		const guarded = barrier.guardLane(harness as unknown as HarnessV4AdaptiveLane);
		const guardedSession = barrier.guardSession();
		await new SessionRegisterBranchOriginRegistry().freeze({
			session,
			lane: "main",
			operationId: "op",
			groupId: "group",
		});
		const before = await entryCount(session);

		await expect(guarded.prompt(userMessage("hi"))).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.promptAdaptive(userMessage("hi"), {})).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.promptAdaptiveTurn(userMessage("hi"), {})).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.resume()).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.resumeAdaptiveTurn()).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.abort()).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.steer("s")).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.followUp("f")).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.nextRun("n")).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.cancelQueued("entry")).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(
			guarded.recordUsage({
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			}),
		).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.setModel(model)).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.setThinkingLevel("off")).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.setActiveTools(["read"])).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.executeAction()).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.runToCompletion()).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.compact()).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.navigateTree(null)).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guarded.acceptAdaptiveContinuation({}, {})).rejects.toBeInstanceOf(BranchOriginFrozenError);

		await expect(guardedSession.commit({ writes: [] })).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guardedSession.setName("name")).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guardedSession.setLabel("x", "y")).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guardedSession.setCustomFact("k", "v")).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guardedSession.appendMessage(userMessage("m"))).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guardedSession.appendCustomEntry("t", {})).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(guardedSession.view("main").appendMessage(userMessage("m"))).rejects.toBeInstanceOf(
			BranchOriginFrozenError,
		);
		await expect(guardedSession.view("main").appendCustomEntry("t", {})).rejects.toBeInstanceOf(
			BranchOriginFrozenError,
		);

		expect(await entryCount(session)).toBe(before);
	});

	it("keeps getters, watch and close working while frozen", async () => {
		const { session, harness, barrier } = await createSurfaceFixture();
		const guarded = barrier.guardLane(harness as unknown as HarnessV4AdaptiveLane);
		const guardedSession = barrier.guardSession();
		await new SessionRegisterBranchOriginRegistry().freeze({
			session,
			lane: "main",
			operationId: "op",
			groupId: "group",
		});
		await expect(guarded.getLeafId()).resolves.toBeNull();
		await expect(guarded.getLastResult()).resolves.toBeUndefined();
		await expect(guarded.getModel()).resolves.toBeDefined();
		await expect(guarded.getThinkingLevel()).resolves.toBeDefined();
		await expect(guarded.getActiveTools()).resolves.toEqual(["read", "write", "edit", "bash"]);
		await expect(guarded.peekAction()).resolves.toBeUndefined();
		await expect(guardedSession.getStats()).resolves.toBeDefined();
		await expect(guardedSession.getName()).resolves.toBeUndefined();
		await expect(guardedSession.close()).resolves.toBeUndefined();
	});

	it("freeze vs guarded mutation races: exactly one side succeeds", async () => {
		// The barrier re-checks the durable marker after the test hook, so a
		// freeze that commits during the hook always wins and the mutation
		// fails with zero writes.
		const { session, harness } = await createSurfaceFixture();
		let release: () => void = () => undefined;
		const hook = new Promise<void>((resolve) => {
			release = resolve;
		});
		const barrier = new BranchOriginBarrier({ session, lane: "main", checkHook: () => hook });
		const guarded = barrier.guardLane(harness as unknown as HarnessV4AdaptiveLane);
		const before = await entryCount(session);
		const attempt = guarded.prompt(userMessage("race"));
		const frozen = new SessionRegisterBranchOriginRegistry().freeze({
			session,
			lane: "main",
			operationId: "op",
			groupId: "group",
		});
		// The freeze must be durable before the hook releases the guard check.
		await frozen;
		release();
		await expect(attempt).rejects.toBeInstanceOf(BranchOriginFrozenError);
		expect(await entryCount(session)).toBe(before);

		// Inverse: no hook delay means the mutation wins first; the freeze
		// still succeeds afterwards and the next mutation fails.
		const { session: session2, harness: harness2 } = await createSurfaceFixture();
		const barrier2 = new BranchOriginBarrier({ session: session2, lane: "main" });
		const guarded2 = barrier2.guardLane(harness2 as unknown as HarnessV4AdaptiveLane);
		const model = await harness2.getModel();
		const second = guarded2.prompt(userMessage("first"));
		await new SessionRegisterBranchOriginRegistry().freeze({
			session: session2,
			lane: "main",
			operationId: "op",
			groupId: "group",
		});
		await second;
		await expect(guarded2.prompt(userMessage("second"))).rejects.toBeInstanceOf(BranchOriginFrozenError);
		void model;
	});
});
