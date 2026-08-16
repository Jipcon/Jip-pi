import { useEffect, useRef, useState } from "react";
import type { ToolCallInfo } from "@earendil-works/pi-agent-protocol";
import type { UiMessage } from "../state/store.ts";
import { looksLikeGoLimitError, OPENCODE_CONSOLE_URL } from "../state/opencode.ts";
import { Icon } from "./Icon.tsx";
import { AssistantMessageContent, MessageItem } from "./MessageItem.tsx";

export interface ConversationTurnModel {
	id: string;
	user?: UiMessage;
	assistantMessages: UiMessage[];
}

export function groupMessagesIntoTurns(messages: UiMessage[]): ConversationTurnModel[] {
	const turns: ConversationTurnModel[] = [];
	let current: ConversationTurnModel | undefined;

	for (const message of messages) {
		if (message.role === "user") {
			current = { id: `turn-${message.id}`, user: message, assistantMessages: [] };
			turns.push(current);
			continue;
		}
		if (!current) {
			current = { id: `turn-orphan-${message.id}`, assistantMessages: [] };
			turns.push(current);
		}
		current.assistantMessages.push(message);
	}

	return turns;
}

interface AssistantTurnParts {
	processMessages: UiMessage[];
	finalMessage?: UiMessage;
}

export function splitAssistantTurn(messages: UiMessage[]): AssistantTurnParts {
	// A message only qualifies as the final answer when generation did not
	// fail. Failed attempts (stopReason "error") always fold into the process
	// section so they can never masquerade as the formal answer.
	let finalIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].stopReason === "error") {
			continue;
		}
		if (
			messages[index].blocks.some(
				(block) => block.type === "image" || (block.type === "text" && block.text.trim().length > 0),
			)
		) {
			finalIndex = index;
			break;
		}
	}

	const processMessages: UiMessage[] = [];
	let finalMessage: UiMessage | undefined;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (index !== finalIndex) {
			processMessages.push(message);
			continue;
		}

		const finalBlocks = message.blocks.filter((block) => block.type === "text" || block.type === "image");
		const processBlocks = message.blocks.filter((block) => block.type !== "text" && block.type !== "image");
		finalMessage = { ...message, id: `${message.id}-final`, blocks: finalBlocks };
		if (processBlocks.length > 0) {
			processMessages.push({
				...message,
				id: `${message.id}-process`,
				blocks: processBlocks,
				complete: true,
			});
		}
	}

	return { processMessages, finalMessage };
}

/** The final message of a turn when the whole turn failed after retries. */
export function turnFailure(messages: UiMessage[]): UiMessage | undefined {
	if (messages.length === 0) {
		return undefined;
	}
	const last = messages[messages.length - 1];
	return last.stopReason === "error" ? last : undefined;
}

function visibleProcessMessages(messages: UiMessage[], showThinking: boolean): UiMessage[] {
	return messages
		.map((message) => ({
			...message,
			blocks: message.blocks.filter(
				(block) =>
					block.type === "toolCall" ||
					(block.type === "text" && block.text.trim().length > 0) ||
					(block.type === "thinking" && showThinking),
			),
		}))
		.filter((message) => message.blocks.length > 0);
}

function processSummary(messages: UiMessage[], tools: Record<string, ToolCallInfo>, streaming: boolean): string {
	const toolCalls = messages.flatMap((message) => message.blocks.filter((block) => block.type === "toolCall"));
	const hasError = toolCalls.some((block) => tools[block.id]?.status === "error");
	const hasRunning = streaming || toolCalls.some((block) => tools[block.id]?.status === "running");
	const status = hasError ? "Error" : hasRunning ? "Running" : "Completed";
	if (toolCalls.length === 0) {
		return hasRunning ? "Work log · Running" : "Work log";
	}
	return `${toolCalls.length} tool ${toolCalls.length === 1 ? "call" : "calls"} · ${status}`;
}

export function ConversationTurn({
	turn,
	tools,
	streaming,
	showThinking,
	showToolDetails,
}: {
	turn: ConversationTurnModel;
	tools: Record<string, ToolCallInfo>;
	streaming: boolean;
	showThinking: boolean;
	showToolDetails: boolean;
}): React.JSX.Element {
	const { processMessages, finalMessage } = splitAssistantTurn(turn.assistantMessages);
	const failedTurn = turnFailure(turn.assistantMessages);
	const failureAttempts = turn.assistantMessages.filter((message) => message.stopReason === "error").length;
	const visibleProcess = visibleProcessMessages(processMessages, showThinking);
	const toolCalls = visibleProcess.flatMap((message) => message.blocks.filter((block) => block.type === "toolCall"));
	const hasRunningTool = toolCalls.some((block) => tools[block.id]?.status === "running");
	const hasError = toolCalls.some((block) => tools[block.id]?.status === "error");
	const hasProblem = hasRunningTool || hasError;
	// Partial text from a failed generation is never the formal answer and
	// must not be copyable.
	const finalFailed = failedTurn !== undefined;
	const finalAborted = !finalFailed && turn.assistantMessages.at(-1)?.stopReason === "aborted";
	const copyText =
		finalMessage?.blocks
			.flatMap((block) => (block.type === "text" && block.text.trim().length > 0 ? [block.text] : []))
			.join("\n\n") ?? "";
	const canCopyFinalResponse =
		!streaming && !finalFailed && finalMessage?.complete === true && copyText.length > 0;
	// Process activity is always collapsed by default; the toggle label carries
	// the live status (Running / Error / Completed) so problems stay visible
	// without forcing content open.
	const [processOpen, setProcessOpen] = useState(false);
	const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
	const copyStatusResetTimer = useRef<number | undefined>(undefined);

	useEffect(
		() => () => {
			if (copyStatusResetTimer.current !== undefined) {
				window.clearTimeout(copyStatusResetTimer.current);
			}
		},
		[],
	);

	async function copyFinalResponse(): Promise<void> {
		try {
			await navigator.clipboard.writeText(copyText);
			setCopyStatus("copied");
		} catch {
			setCopyStatus("error");
		}
		if (copyStatusResetTimer.current !== undefined) {
			window.clearTimeout(copyStatusResetTimer.current);
		}
		copyStatusResetTimer.current = window.setTimeout(() => setCopyStatus("idle"), 1_500);
	}

	const hasAssistantContent = visibleProcess.length > 0 || finalMessage !== undefined || failedTurn !== undefined;
	// Web-style working status: anchored to the top of the assistant area while
	// the agent runs, and hidden once the final answer starts streaming (the
	// in-message streaming dots take over from there).
	const showWorkingStatus = streaming && (finalMessage === undefined || finalMessage.complete === true);
	const retryLabel =
		failureAttempts > 1
			? `${failureAttempts} attempts`
			: failureAttempts === 1
				? "1 attempt"
				: undefined;
	return (
		<div className="conversation-turn" data-testid="conversation-turn">
			{turn.user && <MessageItem message={turn.user} tools={tools} />}
			{(hasAssistantContent || showWorkingStatus) && (
				<div className="message-row message-row-assistant" data-testid="assistant-message">
					<div className="assistant-meta">
						<span>Jip-pi</span>
					</div>
					<div className="assistant-body">
						{showWorkingStatus && (
							<div className="assistant-working" role="status" data-testid="assistant-working">
								<span className="assistant-working-dot" aria-hidden="true" />
								<span className="assistant-working-text">Jip-pi is working</span>
							</div>
						)}
						{finalFailed && failedTurn && (
							<div className="assistant-failure" role="alert" data-testid="assistant-failure">
								<div className="assistant-failure-title">
									<Icon name="alert" size={15} />
									<span>
										Generation failed{retryLabel ? ` after ${retryLabel}` : ""}
									</span>
								</div>
								{failedTurn.errorMessage && (
									<div className="assistant-failure-message">{failedTurn.errorMessage}</div>
								)}
								{looksLikeGoLimitError(failedTurn.errorMessage) && (
									<div className="assistant-failure-hint" data-testid="go-limit-hint">
										This looks like an OpenCode usage-limit error. Go quota and the
										"Use balance" fallback are controlled by your OpenCode account settings:{" "}
										<a href={OPENCODE_CONSOLE_URL} target="_blank" rel="noreferrer">
											open the OpenCode console
										</a>
										. The local usage bar only shows tokens and an estimated cost, never a
										remaining quota.
									</div>
								)}
							</div>
						)}
						{finalAborted && (
							<div className="assistant-aborted" role="status" data-testid="assistant-aborted">
								<Icon name="stop" size={15} />
								<span>Stopped by user</span>
							</div>
						)}
						{visibleProcess.length > 0 && (
							<div className={`assistant-process ${hasProblem ? "assistant-process-problem" : ""}`}>
								<button
									type="button"
									className="assistant-process-toggle"
									onClick={() => setProcessOpen((open) => !open)}
									aria-expanded={processOpen}
									data-testid="assistant-process-toggle"
								>
									<span className="assistant-process-caret">{processOpen ? "▾" : "▸"}</span>
									<span>{processSummary(visibleProcess, tools, streaming)}</span>
								</button>
								{processOpen && (
									<div className="assistant-process-content" data-testid="assistant-process-content">
										{visibleProcess.map((message) => (
											<div className="assistant-process-message" key={message.id}>
												<AssistantMessageContent
													message={message}
													tools={tools}
													showThinking={showThinking}
													showToolDetails={showToolDetails}
												/>
											</div>
										))}
									</div>
								)}
							</div>
						)}
						{finalMessage && (
							<>
								<AssistantMessageContent
									message={finalMessage}
									tools={tools}
									showThinking={showThinking}
									showToolDetails={showToolDetails}
								/>
								{canCopyFinalResponse && (
									<div className="assistant-actions">
										<button
											type="button"
											className={`icon-button assistant-copy-button assistant-copy-button-${copyStatus}`}
											onClick={() => void copyFinalResponse()}
											aria-label={copyStatus === "copied" ? "Copied" : "Copy final response"}
											title={copyStatus === "copied" ? "Copied" : "Copy final response"}
											data-testid="copy-final-response"
										>
											<Icon name={copyStatus === "copied" ? "check" : "copy"} size={18} />
										</button>
										<span
											className={`assistant-copy-status ${copyStatus === "error" ? "assistant-copy-status-error" : ""}`}
											role="status"
										>
											{copyStatus === "copied" ? "Copied" : copyStatus === "error" ? "Copy failed" : ""}
										</span>
									</div>
								)}
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
