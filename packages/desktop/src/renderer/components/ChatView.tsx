/**
 * ChatView: scrollable message list + composer.
 *
 * Rendering is bounded by a fixed window of conversation turns (never the
 * whole history): only the most recent `MAX_MOUNTED_TURNS` turns are mounted,
 * including while streaming, so thousand-message sessions keep DOM and memory
 * stable. The turn cache only keeps entries inside the visible window.
 *
 * Auto-scroll only happens when the user is already at the bottom or just
 * sent a message; browsing older content is never interrupted by streaming
 * updates. Switching sessions resets the window and turn cache and restores
 * that session's own scroll position.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { RetryState, UiMessage } from "../state/store.ts";
import type { SessionUsage, ToolCallInfo } from "@earendil-works/pi-agent-protocol";
import { Composer } from "./Composer.tsx";
import { ConversationTurn, groupMessagesIntoTurns, type ConversationTurnModel } from "./ConversationTurn.tsx";
import { Icon } from "./Icon.tsx";
import { UsageBar } from "./UsageBar.tsx";

const MemoComposer = memo(Composer);
const MemoUsageBar = memo(UsageBar);

/** Hard bound on how many turns are ever mounted. */
export const MAX_MOUNTED_TURNS = 100;
/** Prune the turn cache once it exceeds this many entries. */
const TURN_CACHE_SOFT_LIMIT = MAX_MOUNTED_TURNS * 2;

/** Per-session scroll positions, kept across session switches. */
const sessionScrollPositions = new Map<string, number>();

/**
 * Historic turns are frozen once their own data stops changing. Tool state is
 * a separate lifecycle from message completion (Pi executes tools after the
 * assistant message ends), so a turn must re-render whenever any tool record
 * it references changes — regardless of the streaming flag. Comparing just
 * the referenced tool entries keeps unrelated turns isolated from each other.
 */
function conversationTurnEqual(
	prev: Parameters<typeof ConversationTurn>[0],
	next: Parameters<typeof ConversationTurn>[0],
): boolean {
	if (prev.turn !== next.turn) return false;
	if (prev.streaming !== next.streaming) return false;
	if (prev.showThinking !== next.showThinking) return false;
	if (prev.showToolDetails !== next.showToolDetails) return false;
	for (const message of prev.turn.assistantMessages) {
		for (const block of message.blocks) {
			if (block.type === "toolCall" && prev.tools[block.id] !== next.tools[block.id]) {
				return false;
			}
		}
	}
	return true;
}

const MemoConversationTurn = memo(ConversationTurn, conversationTurnEqual);

function sameMessageRefs(left: UiMessage[], right: UiMessage[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	return left.every((message, index) => message === right[index]);
}

export function ChatView({
	workspaceId,
	messages,
	tools,
	streaming,
	disabled,
	showThinking,
	showToolDetails,
	sessionUsage = null,
	supportsImages = false,
	retry = null,
	sessionKey = "",
}: {
	/** Workspace the session belongs to (session-routed operations). */
	workspaceId: string;
	messages: UiMessage[];
	tools: Record<string, ToolCallInfo>;
	streaming: boolean;
	disabled: boolean;
	showThinking: boolean;
	showToolDetails: boolean;
	sessionUsage?: SessionUsage | null;
	supportsImages?: boolean;
	retry?: RetryState | null;
	/** Current session id; changes reset the render window and turn cache. */
	sessionKey?: string;
}): React.JSX.Element {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [atBottom, setAtBottom] = useState(true);
	const turnCacheRef = useRef(new Map<string, ConversationTurnModel>());
	const previousSessionKeyRef = useRef(sessionKey);
	const lastMessagesRef = useRef<UiMessage[]>([]);

	// Session switch: save the old session's scroll position, reset the window
	// and the turn cache, restore the new session's own scroll position.
	useEffect(() => {
		if (previousSessionKeyRef.current === sessionKey) {
			return;
		}
		const container = scrollRef.current;
		if (container && previousSessionKeyRef.current !== "") {
			sessionScrollPositions.set(previousSessionKeyRef.current, container.scrollTop);
		}
		previousSessionKeyRef.current = sessionKey;
		turnCacheRef.current.clear();
		setAtBottom(true);
		const saved = sessionKey !== "" ? sessionScrollPositions.get(sessionKey) : undefined;
		if (saved !== undefined && container) {
			// Content settles one frame after commit; restore afterwards.
			const rafId = window.requestAnimationFrame(() => {
				container.scrollTop = Math.min(saved, container.scrollHeight);
			});
			return () => window.cancelAnimationFrame(rafId);
		}
	}, [sessionKey]);

	// Scroll-to-bottom policy: only when the user is at the bottom, or when a
	// new user message just arrived (the user actively sent it).
	useEffect(() => {
		const container = scrollRef.current;
		if (!container) {
			return;
		}
		if (messages.length === 0) {
			container.scrollTop = 0;
			return;
		}
		const previous = lastMessagesRef.current;
		lastMessagesRef.current = messages;
		const last = messages[messages.length - 1];
		const userJustSent = last.role === "user" && previous.at(-1) !== last;
		const shouldScroll = atBottom || userJustSent;
		if (!shouldScroll) {
			return;
		}
		if (userJustSent) {
			setAtBottom(true);
		}
		// The flex/min-height layout of the chat column settles one frame after
		// commit; positioning immediately reads an intermediate layout and
		// lands off-target. Defer to the next animation frame.
		const rafId = window.requestAnimationFrame(() => {
			const lastTurn = container.querySelector(".message-list > :last-child");
			if (lastTurn) {
				lastTurn.scrollIntoView({ block: "end" });
			} else {
				container.scrollTop = container.scrollHeight;
			}
		});
		return () => window.cancelAnimationFrame(rafId);
	}, [messages, atBottom]);

	useEffect(() => {
		const container = scrollRef.current;
		if (!container) {
			return;
		}
		const onScroll = () => {
			setAtBottom(container.scrollTop + container.clientHeight >= container.scrollHeight - 48);
		};
		container.addEventListener("scroll", onScroll, { passive: true });
		return () => container.removeEventListener("scroll", onScroll);
	}, []);

	// Turn grouping is a cheap O(n) pass; the DOM is what stays bounded.
	const groupedTurns = useMemo(() => groupMessagesIntoTurns(messages), [messages]);
	const visibleTurns = useMemo(
		() => (groupedTurns.length > MAX_MOUNTED_TURNS ? groupedTurns.slice(-MAX_MOUNTED_TURNS) : groupedTurns),
		[groupedTurns],
	);

	// Keep turn object references stable for unchanged turns so memoized
	// message components can skip re-rendering during streaming. The cache
	// only keeps entries from the visible window (bounded memory).
	const turns = useMemo(() => {
		const cache = turnCacheRef.current;
		const stable: ConversationTurnModel[] = [];
		const visibleIds = new Set<string>();
		for (const turn of visibleTurns) {
			visibleIds.add(turn.id);
			const existing = cache.get(turn.id);
			if (existing && existing.user === turn.user && sameMessageRefs(existing.assistantMessages, turn.assistantMessages)) {
				stable.push(existing);
			} else {
				cache.set(turn.id, turn);
				stable.push(turn);
			}
		}
		if (cache.size > TURN_CACHE_SOFT_LIMIT) {
			for (const id of cache.keys()) {
				if (!visibleIds.has(id)) {
					cache.delete(id);
				}
			}
		}
		return stable;
	}, [visibleTurns]);

	return (
		<main className="chat" data-testid="chat">
			<div className={`chat-scroll ${messages.length === 0 ? "chat-scroll-empty" : ""}`} ref={scrollRef}>
				<div className="chat-inner">
					{messages.length === 0 && (
						<div className="chat-empty">
							<span className="chat-empty-mark" aria-hidden="true">
								<Icon name="sparkles" size={24} />
							</span>
							<h1>Build with Jip-pi</h1>
							<p>Explore your codebase, plan a change, or trace a difficult bug.</p>
							<div className="chat-empty-capabilities" aria-label="Suggested tasks">
								<span>Explore code</span>
								<span>Plan changes</span>
								<span>Debug issues</span>
							</div>
						</div>
					)}
					<div className="message-list" aria-live="polite">
						{turns.map((turn, index) => (
							<MemoConversationTurn
								key={turn.id}
								turn={turn}
								tools={tools}
								streaming={streaming && index === turns.length - 1}
								showThinking={showThinking}
								showToolDetails={showToolDetails}
							/>
						))}
					</div>
				</div>
			</div>
			<MemoUsageBar usage={sessionUsage} />
			{retry && (
				<div className="retry-banner" role="status" data-testid="retry-banner">
					<span className="retry-banner-title">
						Retrying ({retry.attempt}/{retry.maxAttempts})
						{retry.delayMs > 0 ? ` in ${Math.max(1, Math.round(retry.delayMs / 1000))}s` : ""}
					</span>
					<span className="retry-banner-error">{retry.errorMessage}</span>
				</div>
			)}
			<MemoComposer
				workspaceId={workspaceId}
				sessionId={sessionKey}
				streaming={streaming}
				disabled={disabled}
				supportsImages={supportsImages}
			/>
		</main>
	);
}
