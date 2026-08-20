/**
 * Composer: text/image input area with Send / Stop controls.
 *
 * - Enter sends, Shift+Enter inserts a newline
 * - while streaming: Send disabled, Stop enabled
 * - idle: Send enabled when text or images are present, Stop disabled
 */

import type { ImageBlock, MessageBlock, UserMessage } from "@earendil-works/pi-agent-protocol";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";

const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);
const IMAGE_ACCEPT = [...ACCEPTED_IMAGE_TYPES].join(",");
let attachmentSequence = 0;

interface PendingImage {
	id: string;
	block: ImageBlock;
}

function readImage(file: File): Promise<ImageBlock> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
		reader.onload = () => {
			if (typeof reader.result !== "string") {
				reject(new Error(`Failed to read ${file.name}`));
				return;
			}
			const separator = reader.result.indexOf(",");
			if (separator < 0) {
				reject(new Error(`Invalid image data for ${file.name}`));
				return;
			}
			resolve({ type: "image", data: reader.result.slice(separator + 1), mimeType: file.type, name: file.name });
		};
		reader.readAsDataURL(file);
	});
}

export function Composer({
	workspaceId,
	sessionId,
	streaming,
	disabled,
	supportsImages = false,
}: {
	/** Workspace the session belongs to (session-routed operations). */
	workspaceId: string;
	/** Session that receives prompts and aborts. */
	sessionId: string;
	streaming: boolean;
	disabled: boolean;
	supportsImages?: boolean;
}): React.JSX.Element {
	const [text, setText] = useState("");
	const [images, setImages] = useState<PendingImage[]>([]);
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const textarea = textareaRef.current;
		if (textarea) {
			// Auto-grow between 54px and 180px.
			textarea.style.height = "auto";
			textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 54), 180)}px`;
		}
	}, [text]);

	const canSend = !streaming && !disabled && !sending && (text.trim().length > 0 || images.length > 0);

	/**
	 * Controlled async submit: the draft stays intact until the backend
	 * confirms it accepted the prompt, and is fully restored when the send
	 * fails. Duplicate sends are blocked while one is in flight.
	 */
	const submit = async (): Promise<void> => {
		if (!canSend) {
			return;
		}
		const content = text.trim();
		const blocks: MessageBlock[] = [];
		if (content) {
			blocks.push({ type: "text", text: content });
		}
		blocks.push(...images.map((image) => image.block));
		const message: UserMessage = {
			role: "user",
			content: images.length > 0 ? blocks : content,
		};
		setSending(true);
		try {
			await window.agent.sendMessage(workspaceId, sessionId, message);
			// Accepted: clear the draft now that the message is on its way.
			setText("");
			setImages([]);
			setAttachmentError(null);
		} catch (error) {
			// Rejected: restore the draft exactly as it was.
			setAttachmentError(error instanceof Error ? error.message : String(error));
		} finally {
			setSending(false);
		}
	};

	const addImageFiles = async (files: File[]): Promise<void> => {
		if (files.length === 0) {
			return;
		}
		const accepted = files.filter((file) => ACCEPTED_IMAGE_TYPES.has(file.type));
		if (accepted.length !== files.length) {
			setAttachmentError("Only PNG, JPEG, WebP, GIF, and BMP images are supported.");
		} else {
			setAttachmentError(null);
		}
		try {
			const blocks = await Promise.all(accepted.map(readImage));
			setImages((current) => [
				...current,
				...blocks.map((block) => ({ id: `image-${attachmentSequence++}`, block })),
			]);
		} catch (error) {
			setAttachmentError(error instanceof Error ? error.message : String(error));
		}
	};

	const addImages = (event: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.currentTarget.files ?? []);
		event.currentTarget.value = "";
		void addImageFiles(files);
	};

	const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
		if (disabled || streaming) {
			return;
		}
		const files = Array.from(event.clipboardData.files);
		if (files.length === 0) {
			return;
		}
		event.preventDefault();
		void addImageFiles(files);
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit();
		}
	};

	const stop = async (): Promise<void> => {
		try {
			await window.agent.abort(workspaceId, sessionId);
		} catch (error) {
			setAttachmentError(error instanceof Error ? error.message : String(error));
		}
	};

	return (
		<div className="composer" data-testid="composer">
			<div className="composer-shell">
				{images.length > 0 && (
					<div className="composer-attachments" data-testid="composer-attachments">
						{images.map((image) => (
							<div className="composer-attachment" key={image.id}>
								<img
									src={`data:${image.block.mimeType};base64,${image.block.data}`}
									alt={image.block.name ?? "Attached image"}
								/>
								<button
									type="button"
									className="composer-attachment-remove"
									onClick={() => setImages((current) => current.filter((entry) => entry.id !== image.id))}
									aria-label={`Remove ${image.block.name ?? "image"}`}
								>
									<Icon name="close" size={18} />
								</button>
							</div>
						))}
					</div>
				)}
				<textarea
					ref={textareaRef}
					className="composer-input"
					placeholder="Ask Jip-pi to explore, explain, or change your code…"
					value={text}
					disabled={disabled}
					rows={1}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					data-testid="composer-input"
					aria-label="Message Jip-pi"
				/>
				{attachmentError && (
					<div className="composer-attachment-error" role="alert">
						{attachmentError}
					</div>
				)}
				{!supportsImages && images.length > 0 && (
					<div className="composer-attachment-error" role="status" data-testid="composer-image-warning">
						The current model does not support image input. Images will be ignored.
					</div>
				)}
				<div className="composer-footer">
					<div className="composer-footer-left">
						<input
							ref={fileInputRef}
							type="file"
							className="composer-file-input"
							accept={IMAGE_ACCEPT}
							multiple
							onChange={(event) => void addImages(event)}
							data-testid="composer-file-input"
						/>
						<button
							type="button"
							className="icon-button composer-attach-button"
							disabled={disabled || streaming}
							onClick={() => fileInputRef.current?.click()}
							aria-label="Add photos"
							title={supportsImages ? "Add photos" : "Add photos (the current model does not support image input)"}
							data-testid="attach-images-button"
						>
							<Icon name="plus" size={18} />
						</button>
						<span className="composer-hint">
							<kbd>Enter</kbd> to send <span aria-hidden="true">·</span> <kbd>Shift + Enter</kbd> for a new line
						</span>
					</div>
					<div className="composer-actions">
						<button
							type="button"
							className="composer-action composer-stop"
							disabled={!streaming || disabled}
							onClick={() => void stop()}
							data-testid="stop-button"
							aria-label="Stop generation"
							title="Stop"
						>
							<Icon name="stop" size={20} />
						</button>
						<button
							type="button"
							className="composer-action composer-send"
							disabled={!canSend}
							onClick={() => void submit()}
							data-testid="send-button"
							aria-label="Send message"
							title="Send (Enter)"
						>
							<Icon name="arrow-up" size={20} />
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
