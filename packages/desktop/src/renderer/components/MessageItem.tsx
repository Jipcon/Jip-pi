/**
 * MessageItem: renders a single chat message.
 * - user: right-aligned rounded card, max-width 80%
 * - assistant: left-aligned, full width, no giant bubble; thinking and full
 *   tool details are opt-in display preferences.
 */

import { memo, useEffect, useRef, useState } from "react";
import type { MessageBlock, ToolCallInfo } from "@earendil-works/pi-agent-protocol";
import type { UiMessage } from "../state/store.ts";
import { GenericToolRenderer } from "./GenericToolRenderer.tsx";
import { Icon } from "./Icon.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";

interface MessageContentProps {
	message: UiMessage;
	tools: Record<string, ToolCallInfo>;
	showThinking?: boolean;
	showToolDetails?: boolean;
	/** Whether editing user messages is supported and the session is idle. */
	canEdit?: boolean;
	/** Request to edit this user message (open the inline editor). */
	onEdit?: (message: UiMessage) => void;
	/** Inline editor state for this message (draft text included). */
	editing?: { text: string } | null;
	/** Update the inline editor's draft. */
	onEditDraft?: (text: string) => void;
	/** Commit the edit: branch before this message and resend the text. */
	onEditSend?: () => void;
	/** Abandon the edit and restore the original message. */
	onEditCancel?: () => void;
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
	if (prev.canEdit !== next.canEdit) return false;
	if (prev.onEdit !== next.onEdit) return false;
	if (prev.editing !== next.editing) return false;
	if (prev.onEditDraft !== next.onEditDraft) return false;
	if (prev.onEditSend !== next.onEditSend) return false;
	if (prev.onEditCancel !== next.onEditCancel) return false;
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

/**
 * Inline editor for a past user message: replaces the bubble in place.
 * Cancel keeps the original conversation untouched; Send branches the
 * session tree before this message and resends the edited text (v1 keeps
 * the text only — attached images are not resent).
 */
function UserMessageEditor({
	text,
	hasImages,
	onDraft,
	onSend,
	onCancel,
}: {
	text: string;
	hasImages: boolean;
	onDraft: (text: string) => void;
	onSend: () => void;
	onCancel: () => void;
}): React.JSX.Element {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const canSend = text.trim().length > 0;

	useEffect(() => {
		const textarea = textareaRef.current;
		if (textarea) {
			textarea.focus();
			// Cursor at the end so revising continues where the text ends.
			textarea.selectionStart = textarea.value.length;
			textarea.selectionEnd = textarea.value.length;
		}
	}, []);

	useEffect(() => {
		const textarea = textareaRef.current;
		if (textarea) {
			// Auto-grow between 54px and 180px, mirroring the composer.
			textarea.style.height = "auto";
			textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 54), 180)}px`;
		}
	}, [text]);

	return (
		<div className="user-bubble user-bubble-editing" data-testid="user-message-editor">
			{hasImages && (
				<div className="user-message-editor-hint">Resending keeps the text only; attached images are not resent.</div>
			)}
			<textarea
				ref={textareaRef}
				className="user-message-editor-input"
				value={text}
				rows={1}
				onChange={(event) => onDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
						event.preventDefault();
						if (canSend) {
							onSend();
						}
					}
					if (event.key === "Escape") {
						event.preventDefault();
						onCancel();
					}
				}}
				aria-label="Edit message"
				data-testid="user-message-editor-input"
			/>
			<div className="user-message-editor-actions">
				<span className="user-message-editor-hint">
					<kbd>Enter</kbd> to resend <span aria-hidden="true">·</span> <kbd>Esc</kbd> to cancel
				</span>
				<button type="button" className="btn" onClick={onCancel} data-testid="edit-cancel-button">
					Cancel
				</button>
				<button
					type="button"
					className="btn btn-primary"
					disabled={!canSend}
					onClick={onSend}
					data-testid="edit-send-button"
				>
					Send
				</button>
			</div>
		</div>
	);
}

function MessageItemImpl({
	message,
	tools,
	showThinking = false,
	showToolDetails = false,
	canEdit = false,
	onEdit,
	editing = null,
	onEditDraft,
	onEditSend,
	onEditCancel,
}: MessageContentProps): React.JSX.Element {
	if (message.role === "user") {
		const text = message.blocks
			.filter((block) => block.type === "text")
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("");
		const images = message.blocks.filter((block) => block.type === "image");
		const editable = canEdit && message.entryId !== undefined && onEdit !== undefined;
		if (editing) {
			return (
				<div className="message-row message-row-user">
					<UserMessageEditor
						text={editing.text}
						hasImages={images.length > 0}
						onDraft={(draft) => onEditDraft?.(draft)}
						onSend={() => onEditSend?.()}
						onCancel={() => onEditCancel?.()}
					/>
				</div>
			);
		}
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
				{editable && (
					<button
						type="button"
						className="icon-button user-message-edit"
						onClick={() => onEdit?.(message)}
						aria-label="Edit message"
						title="Edit message"
						data-testid="edit-user-message"
					>
						<Icon name="edit" size={16} />
					</button>
				)}
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
