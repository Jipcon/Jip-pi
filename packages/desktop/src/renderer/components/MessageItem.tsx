/**
 * MessageItem: renders a single chat message.
 * - user: right-aligned rounded card, max-width 80%
 * - assistant: left-aligned, full width, no giant bubble; thinking and full
 *   tool details are opt-in display preferences.
 */

import { memo, useState } from "react";
import type { MessageBlock, ToolCallInfo } from "@earendil-works/pi-agent-protocol";
import type { UiMessage } from "../state/store.ts";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { GenericToolRenderer } from "./GenericToolRenderer.tsx";

interface MessageContentProps {
	message: UiMessage;
	tools: Record<string, ToolCallInfo>;
	showThinking?: boolean;
	showToolDetails?: boolean;
}

/**
 * Skip re-rendering when the message is unchanged and none of the tool
 * records it references changed. Keeps streaming updates local to the last
 * message instead of re-rendering (and re-parsing Markdown for) every message.
 */
function messageContentPropsEqual(prev: MessageContentProps, next: MessageContentProps): boolean {
	if (prev.message !== next.message) return false;
	if (prev.showThinking !== next.showThinking) return false;
	if (prev.showToolDetails !== next.showToolDetails) return false;
	for (const block of prev.message.blocks) {
		if (block.type === "toolCall" && prev.tools[block.id] !== next.tools[block.id]) {
			return false;
		}
	}
	return true;
}

function MessageImage({ block, className }: { block: Extract<MessageBlock, { type: "image" }>; className: string }): React.JSX.Element {
	return (
		<img
			className={className}
			src={`data:${block.mimeType};base64,${block.data}`}
			alt={block.name ?? "Attached image"}
		/>
	);
}

function ThinkingBlockView({ thinking }: { thinking: string }): React.JSX.Element {
	const [open, setOpen] = useState(false);
	return (
		<div className="thinking-block">
			<button type="button" className="thinking-toggle" onClick={() => setOpen(!open)}>
				<span className="thinking-caret">{open ? "▾" : "▸"}</span>
				Thinking
			</button>
			{open && <pre className="thinking-content">{thinking}</pre>}
		</div>
	);
}

function ToolCallBlockView({
	block,
	tool,
	showDetails,
}: {
	block: Extract<MessageBlock, { type: "toolCall" }>;
	tool?: ToolCallInfo;
	showDetails: boolean;
}): React.JSX.Element {
	if (!showDetails) {
		const status = tool?.status ?? "completed";
		return (
			<div className="tool-activity" data-testid="tool-activity">
				<span className="tool-activity-name">{block.name}</span>
				<span className={`tool-activity-status tool-activity-status-${status}`}>{status}</span>
			</div>
		);
	}
	if (tool) {
		return <GenericToolRenderer tool={tool} />;
	}
	// No execution record yet (e.g. historic message): render a minimal card.
	return (
		<div className="tool-card">
			<div className="tool-card-header">
				<span className="tool-card-name">{block.name}</span>
				<span className="tool-card-status tool-card-status-completed">Completed</span>
			</div>
			<div className="tool-card-args">
				<pre>{JSON.stringify(block.arguments, null, 2)}</pre>
			</div>
		</div>
	);
}

function AssistantMessageContentImpl({
	message,
	tools,
	showThinking = false,
	showToolDetails = false,
}: MessageContentProps): React.JSX.Element {
	return (
		<>
			{message.blocks.map((block, index) => {
				if (block.type === "text") {
					return <MarkdownContent key={index} text={block.text} />;
				}
				if (block.type === "thinking") {
					return showThinking ? <ThinkingBlockView key={index} thinking={block.thinking} /> : null;
				}
				if (block.type === "image") {
					return <MessageImage key={index} block={block} className="assistant-image" />;
				}
				return (
					<ToolCallBlockView
						key={index}
						block={block}
						tool={tools[block.id]}
						showDetails={showToolDetails}
					/>
				);
			})}
			{!message.complete && (
				<div className="streaming-indicator" aria-label="streaming">
					<span />
					<span />
					<span />
				</div>
			)}
		</>
	);
}

export const AssistantMessageContent = memo(AssistantMessageContentImpl, messageContentPropsEqual);

function MessageItemImpl({
	message,
	tools,
	showThinking = false,
	showToolDetails = false,
}: MessageContentProps): React.JSX.Element {
	if (message.role === "user") {
		const text = message.blocks
			.filter((block) => block.type === "text")
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("");
		const images = message.blocks.filter((block) => block.type === "image");
		return (
			<div className="message-row message-row-user">
				<div className={`user-bubble ${text ? "" : "user-bubble-images-only"}`} data-testid="user-message">
					{images.length > 0 && (
						<div className="user-message-images">
							{images.map((image, index) => (
								<MessageImage key={index} block={image} className="user-message-image" />
							))}
						</div>
					)}
					{text && <div className="user-message-text">{text}</div>}
				</div>
			</div>
		);
	}

	return (
		<div className="message-row message-row-assistant" data-testid="assistant-message">
			<div className="assistant-meta">
				<span>Jip-pi</span>
			</div>
			<div className="assistant-body">
				<AssistantMessageContent
					message={message}
					tools={tools}
					showThinking={showThinking}
					showToolDetails={showToolDetails}
				/>
			</div>
		</div>
	);
}

export const MessageItem = memo(MessageItemImpl, messageContentPropsEqual);
