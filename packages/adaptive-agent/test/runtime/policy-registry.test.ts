import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import { afterEach, describe, expect, it } from "vitest";
import {
	canonicalJson,
	fingerprintPolicyBundle,
	InMemoryPolicyRegistry,
	JsonlPolicyRegistry,
	type PolicyBundle,
	type PolicyBundleRef,
	PolicyRegistryError,
	sha256Hex,
} from "../../src/index.ts";
import { adaptiveBundle, createBundleFixtures, permissiveBundle } from "./stage5-fixtures.ts";

const cleanupDirectories = new Set<string>();
afterEach(() => {
	for (const directory of cleanupDirectories) rmSync(directory, { recursive: true, force: true });
	cleanupDirectories.clear();
});

function jsonlRegistry(): JsonlPolicyRegistry {
	const directory = mkdtempSync(join(tmpdir(), "pi-policy-registry-"));
	cleanupDirectories.add(directory);
	return new JsonlPolicyRegistry({ directory });
}

function json(value: unknown): string {
	return canonicalJson(value as JsonValue);
}

describe("canonical fingerprinting", () => {
	it("serializes object keys in sorted order deterministically", () => {
		const left = json({ b: 1, a: { d: true, c: "x" } });
		const right = json({ a: { c: "x", d: true }, b: 1 });
		expect(left).toBe(right);
		expect(left).toBe('{"a":{"c":"x","d":true},"b":1}');
	});

	it("rejects non-integer numbers so fingerprints stay exact", () => {
		expect(() => json({ value: 0.5 })).toThrow(/canonical JSON/);
	});

	it("fingerprints policy bundles with stable sha256 hex", () => {
		const bundle = permissiveBundle("0".repeat(64));
		const fingerprint = fingerprintPolicyBundle(bundle);
		expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(fingerprint).toBe(sha256Hex(json(bundle)));
		expect(fingerprintPolicyBundle(structuredClone(bundle))).toBe(fingerprint);
	});
});

describe("PolicyRegistry publication", () => {
	it("publishes and resolves canonical bundles through memory and JSONL identically", async () => {
		const bundle = adaptiveBundle("f".repeat(64));
		const memory = new InMemoryPolicyRegistry();
		const durable = jsonlRegistry();
		const fromMemory = await memory.publish(bundle);
		const fromDurable = await durable.publish(bundle);
		expect(fromDurable).toEqual(fromMemory);
		expect(await durable.resolve(fromMemory)).toEqual(bundle);
		expect(await memory.resolve(fromDurable)).toEqual(bundle);
		await memory.close();
		await durable.close();
	});

	it("never overwrites a version with different content", async () => {
		const registry = new InMemoryPolicyRegistry();
		await registry.publish(permissiveBundle("a".repeat(64)));
		await expect(
			registry.publish({ ...permissiveBundle("a".repeat(64)), description: "changed" }),
		).rejects.toMatchObject({
			code: "conflict",
		});
		// Identical content is an idempotent re-publication.
		await expect(registry.publish(permissiveBundle("a".repeat(64)))).resolves.toEqual({
			version: "permissive-v1",
			fingerprint: fingerprintPolicyBundle(permissiveBundle("a".repeat(64))),
		});
	});

	it("rejects invalid bundles at publish time", async () => {
		const registry = new InMemoryPolicyRegistry();
		const cases: Array<{ name: string; bundle: PolicyBundle }> = [
			{
				name: "unsupported schema version",
				bundle: { ...permissiveBundle("a".repeat(64)), schemaVersion: 2 } as unknown as PolicyBundle,
			},
			{
				name: "guard without pathArguments (material rewrite)",
				bundle: adaptiveBundle("a".repeat(64), {
					toolRules: [{ id: "bad-guard", toolName: "read", decision: { kind: "guard", reasonCodes: [] } }],
				}),
			},
			{
				name: "guard targeting bash",
				bundle: adaptiveBundle("a".repeat(64), {
					toolRules: [
						{
							id: "bad-bash-guard",
							toolName: "bash",
							decision: { kind: "guard", reasonCodes: [], pathArguments: ["command"] },
						},
					],
				}),
			},
			{
				name: "invalid regex in condition",
				bundle: adaptiveBundle("a".repeat(64), {
					toolRules: [
						{
							id: "bad-regex",
							toolName: "bash",
							when: { commandMatches: "([unclosed" },
							decision: { kind: "block", reason: "x", reasonCodes: [] },
						},
					],
				}),
			},
			{
				name: "invalid budgets",
				bundle: adaptiveBundle("a".repeat(64), {
					budgets: { maxTurns: 0, maxToolCalls: 1, maxTokens: 1 },
				}),
			},
			{
				name: "invalid catalog fingerprint",
				bundle: permissiveBundle("not-a-sha256"),
			},
		];
		for (const testCase of cases) {
			await expect(registry.publish(testCase.bundle), testCase.name).rejects.toMatchObject({
				code: "invalid_bundle",
			});
		}
	});

	it("fails closed on missing and mismatched refs", async () => {
		const registry = new InMemoryPolicyRegistry();
		const ref: PolicyBundleRef = { version: "missing", fingerprint: "a".repeat(64) };
		await expect(registry.resolve(ref)).rejects.toMatchObject({ code: "missing" });
		const published = await registry.publish(permissiveBundle("b".repeat(64)));
		await expect(registry.resolve({ version: published.version, fingerprint: "c".repeat(64) })).rejects.toMatchObject(
			{
				code: "corrupt",
			},
		);
		await expect(registry.resolve({ version: published.version, fingerprint: "short" })).rejects.toMatchObject({
			code: "invalid_bundle",
		});
	});
});

describe("JsonlPolicyRegistry durability", () => {
	it("survives close and reopen and keeps versions independent", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-policy-reopen-"));
		cleanupDirectories.add(directory);
		const writer = new JsonlPolicyRegistry({ directory });
		const first = await writer.publish(permissiveBundle("d".repeat(64)));
		const second = await writer.publish(adaptiveBundle("e".repeat(64)));
		await writer.close();

		const reader = new JsonlPolicyRegistry({ directory });
		expect(await reader.list()).toEqual([second, first]);
		expect(await reader.resolve(second)).toEqual(adaptiveBundle("e".repeat(64)));
		await reader.close();
	});

	it("reports corrupt files instead of resolving them", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-policy-corrupt-"));
		cleanupDirectories.add(directory);
		const registry = new JsonlPolicyRegistry({ directory });
		const ref = await registry.publish(permissiveBundle("a".repeat(64)));
		// Corrupt the stored content: same version, different canonical bytes.
		const target = join(directory, `bundle-${sha256Hex(ref.version).slice(0, 24)}.json`);
		writeFileSync(target, `${json(adaptiveBundle("b".repeat(64)))}\n`);
		await expect(registry.resolve(ref)).rejects.toMatchObject({ code: "corrupt" });
	});

	it("never escapes the registry directory for hostile versions", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-policy-hostile-"));
		cleanupDirectories.add(directory);
		const registry = new JsonlPolicyRegistry({ directory });
		const bundle = { ...permissiveBundle("a".repeat(64)), version: "../../../escape" };
		const ref = await registry.publish(bundle);
		expect(await registry.resolve(ref)).toEqual(bundle);
		// Only registry-owned bundle files exist in the directory; the hostile
		// version never becomes a path component.
		expect(readdirSync(directory)).toHaveLength(1);
	});

	it("parity with memory: same refs, same resolution failures", async () => {
		const fixtures = await createBundleFixtures();
		const durable = jsonlRegistry();
		await durable.publish(fixtures.permissiveBundle);
		await durable.publish(fixtures.adaptiveBundle);
		expect(await durable.resolve(fixtures.adaptive)).toEqual(fixtures.adaptiveBundle);
		await expect(durable.resolve({ version: "nope", fingerprint: "a".repeat(64) })).rejects.toMatchObject({
			code: "missing",
		});
		await durable.close();
	});

	it("rejects every operation after close", async () => {
		const registry = new InMemoryPolicyRegistry();
		await registry.close();
		await expect(registry.publish(permissiveBundle("a".repeat(64)))).rejects.toMatchObject({ code: "closed" });
		await expect(registry.resolve({ version: "x", fingerprint: "a".repeat(64) })).rejects.toMatchObject({
			code: "closed",
		});
	});

	it("types missing bundles as PolicyRegistryError instances", async () => {
		const registry = new InMemoryPolicyRegistry();
		const error = await registry
			.resolve({ version: "absent", fingerprint: "a".repeat(64) })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(PolicyRegistryError);
	});
});
