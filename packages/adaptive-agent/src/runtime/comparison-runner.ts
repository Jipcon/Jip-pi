import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { LeafTurnResult } from "./leaf-turn-executor.ts";
import { sha256Hex } from "./policy-bundle.ts";
import type { AdaptiveLoopMetrics, LoopPrompt, SingleCandidateAdaptiveToolLoop } from "./single-candidate-loop.ts";

export interface ComparisonStrategyRuntime {
	loop: SingleCandidateAdaptiveToolLoop;
	close(): Promise<void>;
}

export interface ComparisonStrategyOptions {
	name: string;
	/** Must create a disposable temp workspace; both strategies run isolated. */
	workspaceFactory: () => Promise<{ root: string; cleanup(): Promise<void> }>;
	create: (workspace: { root: string }) => Promise<ComparisonStrategyRuntime>;
}

export interface TurnShapeResult {
	toolName: string;
	isError: boolean;
	contentLength: number;
	contentHash: string;
}

export interface TurnShape {
	hasToolCalls: boolean;
	textContentHash: string;
	results: TurnShapeResult[];
}

export interface StrategyReport {
	name: string;
	outcome: string;
	/** True only when the TaskEvaluator produced a verified verdict. */
	verifiedSuccess: boolean;
	toolErrors: number;
	toolBlocks: number;
	redundantCalls: number;
	latencyMs: { total: number; perTurn: number[] };
	tokens: Usage;
	verificationCoverage: number;
	turns: TurnShape[];
}

export interface ComparisonReport {
	strategies: [StrategyReport, StrategyReport];
}

function textContent(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function isWithinTemporaryDirectory(root: string): boolean {
	const resolvedRoot = resolve(root);
	const resolvedTemp = resolve(tmpdir());
	const relation = relative(resolvedTemp, resolvedRoot);
	if (relation === "") return true;
	if (relation.startsWith("..") || isAbsolute(relation) || relation.split(sep).includes("..")) return false;
	return relation.length > 0;
}

/**
 * Permissive-vs-adaptive comparison over the same scripted input. Each
 * strategy gets its own disposable workspace; before WorkspaceManager exists
 * (Stage 7) the runner refuses to touch any non-temporary directory.
 */
export async function runStrategyComparison(options: {
	strategies: [ComparisonStrategyOptions, ComparisonStrategyOptions];
	prompt: LoopPrompt;
}): Promise<ComparisonReport> {
	const reports: StrategyReport[] = [];
	for (const strategy of options.strategies) {
		const workspace = await strategy.workspaceFactory();
		try {
			if (!isWithinTemporaryDirectory(workspace.root)) {
				throw new Error(
					`Comparison strategy ${strategy.name} requires a disposable temp workspace, got ${workspace.root}`,
				);
			}
			const runtime = await strategy.create({ root: workspace.root });
			try {
				reports.push(await driveStrategy(strategy.name, runtime.loop, options.prompt));
			} finally {
				await runtime.close();
			}
		} finally {
			await workspace.cleanup();
		}
	}
	return { strategies: [reports[0]!, reports[1]!] };
}

async function driveStrategy(
	name: string,
	loop: SingleCandidateAdaptiveToolLoop,
	prompt: LoopPrompt,
): Promise<StrategyReport> {
	const turns: TurnShape[] = [];
	let step = await loop.start(prompt);
	let outcome: string = step.kind;
	let verifiedSuccess = false;
	if (step.kind === "turn" && step.decision.kind === "continue" && step.settlement === undefined) {
		for (;;) {
			turns.push(shapeOf(step.turn));
			step = await loop.advance(step.turn.cursor);
			if (step.kind !== "turn") break;
			if (step.decision.kind !== "continue" || step.settlement !== undefined) {
				turns.push(shapeOf(step.turn));
				break;
			}
		}
	} else if (step.kind === "turn") {
		turns.push(shapeOf(step.turn));
		outcome = step.settlement?.kind ?? outcome;
	} else {
		outcome = step.kind;
	}
	if (step.kind === "turn" && step.settlement !== undefined) {
		outcome = step.settlement.kind;
		verifiedSuccess = step.evaluation?.kind === "verified";
	}
	const metrics: AdaptiveLoopMetrics = loop.metrics();
	return {
		name,
		outcome,
		verifiedSuccess,
		toolErrors: metrics.toolErrors,
		toolBlocks: metrics.toolBlocks,
		redundantCalls: metrics.redundantCalls,
		latencyMs: metrics.latencyMs,
		tokens: metrics.tokens,
		verificationCoverage: metrics.verificationCoverage,
		turns,
	};
}

function shapeOf(turn: LeafTurnResult): TurnShape {
	return {
		hasToolCalls: turn.message.content.some((part) => part.type === "toolCall"),
		textContentHash: sha256Hex(textContent(turn.message.content)),
		results: turn.toolResults.map((result) => ({
			toolName: result.toolName,
			isError: result.isError,
			contentLength: textContent(result.content).length,
			contentHash: sha256Hex(textContent(result.content)),
		})),
	};
}
