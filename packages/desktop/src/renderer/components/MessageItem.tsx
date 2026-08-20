/**
 * MessageItem: renders a single user chat message as a right-aligned rounded
 * card (max-width 80%), with the inline editor when an edit targets it.
 * Assistant content is rendered by ConversationTurn through
 * AssistantMessageContent.
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
	/** Inline editor state for this message: edit target and initial text. */
	editing?: { text: string } | null;
	/** Commit the edit with the final text: branch before this message and resend. */
	onEditSend?: (text: string) => void;
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
	onSend,
	onCancel,
}: {
	text: string;
	hasImages: boolean;
	onSend: (text: string) => void;
	onCancel: () => void;
}): React.JSX.Element {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	// The draft is editor-local: typing re-renders only this editor, never the
	// surrounding turns. The final text is handed to onSend on commit.
	const [draft, setDraft] = useState(text);
	const canSend = draft.trim().length > 0;

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
	}, [draft]);

	return (
		<div className="user-bubble user-bubble-editing" data-testid="user-message-editor">
			{hasImages && (
				<div className="user-message-editor-hint">Resending keeps the text only; attached images are not resent.</div>
			)}
			<textarea
				ref={textareaRef}
				className="user-message-editor-input"
				value={draft}
				rows={1}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
						event.preventDefault();
						if (canSend) {
							onSend(draft);
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
					onClick={() => onSend(draft)}
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
	canEdit = false,
	onEdit,
	editing = null,
	onEditSend,
	onEditCancel,
}: MessageContentProps): React.JSX.Element {
	const text = message.blocks
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
	const images = message.blocks.filter((block) => block.type === "image");
	const editable = canEdit && message.entryId !== undefined && onEdit !== undefined;
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

	async function copyUserMessage(): Promise<void> {
		if (text.trim().length === 0) return;
		try {
			await navigator.clipboard.writeText(text);
			setCopyStatus("copied");
		} catch {
			setCopyStatus("error");
		}
		if (copyStatusResetTimer.current !== undefined) {
			window.clearTimeout(copyStatusResetTimer.current);
		}
		copyStatusResetTimer.current = window.setTimeout(() => setCopyStatus("idle"), 1500);
	}
	if (editing) {
		return (
			<div className="message-row message-row-user">
				<UserMessageEditor
					text={editing.text}
					hasImages={images.length > 0}
					onSend={(text) => onEditSend?.(text)}
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
			{(editable || text.trim().length > 0) && (
				<div className="user-message-actions">
					{text.trim().length > 0 && (
						<button
							type="button"
							className={`icon-button user-message-copy user-message-copy-${copyStatus}`}
							onClick={() => void copyUserMessage()}
							aria-label={copyStatus === "copied" ? "Copied" : "Copy message"}
							title={copyStatus === "copied" ? "Copied" : "Copy message"}
							data-testid="copy-user-message"
						>
							<Icon name={copyStatus === "copied" ? "check" : "copy"} size={16} />
						</button>
					)}
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
			)}
		</div>
	);
}

export const MessageItem = memo(MessageItemImpl, messageContentPropsEqual);
