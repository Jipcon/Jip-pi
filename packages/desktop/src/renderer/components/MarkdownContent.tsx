import { isValidElement, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import { all, common } from "lowlight";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Icon } from "./Icon.tsx";

const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [
	remarkGfm,
	[remarkMath, { singleDollarTextMath: false }],
];
// rehype-highlight only registers the languages we hand it. Importing
// lowlight's full `all` set (192 languages) would bloat the renderer
// bundle, so start from the 37-language `common` subset and cherry-pick a
// curated set of frequent programming languages plus command-line dialects
// that are missing from `common` (same highlight.js version lowlight uses
// internally, avoiding cross-version LanguageFn mismatches).
const HIGHLIGHT_LANGUAGES = {
	...common,
	awk: all.awk,
	clojure: all.clojure,
	dart: all.dart,
	dos: all.dos,
	elixir: all.elixir,
	erlang: all.erlang,
	fsharp: all.fsharp,
	groovy: all.groovy,
	haskell: all.haskell,
	julia: all.julia,
	ocaml: all.ocaml,
	powershell: all.powershell,
	scala: all.scala,
};
const REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [
	[rehypeKatex, { strict: "ignore" }],
	[rehypeHighlight, { detect: false, languages: HIGHLIGHT_LANGUAGES }],
];
/**
 * Language name from the code element's `language-*` class, when present.
 * react-markdown and rehype-highlight both emit it (e.g. `language-typescript`).
 */
function codeLanguage(children: React.ReactNode): string | null {
	if (!isValidElement(children)) {
		return null;
	}
	const className = (children.props as { className?: string }).className;
	const match = /(?:^|\s)language-([\w#+-]+)/.exec(className ?? "");
	return match ? match[1] : null;
}

/**
 * Code block with a copy button. The button lives in a non-scrolling wrapper
 * around the <pre>, so it stays pinned at the top-right while code lines
 * scroll underneath it.
 */
function PreBlock({
	children,
	...props
}: React.ComponentPropsWithoutRef<"pre">): React.JSX.Element {
	const preRef = useRef<HTMLPreElement>(null);
	const [copied, setCopied] = useState(false);
	const resetTimer = useRef<number | undefined>(undefined);
	const language = codeLanguage(children);

	useEffect(
		() => () => {
			if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
		},
		[],
	);

	const copy = async (): Promise<void> => {
		// textContent includes the highlighted spans' text, never their markup.
		const text = preRef.current?.querySelector("code")?.textContent ?? "";
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
		} catch {
			// Keep the original icon; fail silently.
		}
		if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
		resetTimer.current = window.setTimeout(() => setCopied(false), 1_500);
	};

	return (
		<div className="code-block">
			<pre ref={preRef} {...props}>{children}</pre>
			{language ? (
				<span className="code-block-language" data-testid="code-block-language">
					{language}
				</span>
			) : (
				<span className="code-block-marker" aria-hidden="true" data-testid="code-block-marker">
					<Icon name="code" size={18} />
				</span>
			)}
			<button
				type="button"
				className={`code-copy-button${copied ? " code-copy-button-copied" : ""}`}
				onClick={() => void copy()}
				aria-label="Copy code"
				title="Copy code"
			>
				<Icon name={copied ? "check" : "copy"} size={14} />
			</button>
		</div>
	);
}

const MARKDOWN_COMPONENTS: Components = {
	a({ node: _node, children, ...props }) {
		return (
			<a {...props} target="_blank" rel="noreferrer noopener">
				{children}
			</a>
		);
	},
	pre({ node: _node, children, ...props }) {
		return <PreBlock {...props}>{children}</PreBlock>;
	},
};

interface Fence {
	character: "`" | "~";
	length: number;
}

function isEscaped(source: string, index: number): boolean {
	let backslashes = 0;
	for (let position = index - 1; position >= 0 && source[position] === "\\"; position -= 1) {
		backslashes += 1;
	}
	return backslashes % 2 === 1;
}

function findClosingDelimiter(source: string, delimiter: string, start: number): number {
	let index = source.indexOf(delimiter, start);
	while (index >= 0 && isEscaped(source, index)) {
		index = source.indexOf(delimiter, index + delimiter.length);
	}
	return index;
}

function findClosingSingleDollar(source: string, start: number): number {
	let index = source.indexOf("$", start);
	while (index >= 0) {
		if (source[index - 1] === "$" || source[index + 1] === "$") {
			return -1;
		}
		if (!isEscaped(source, index)) {
			return index;
		}
		index = source.indexOf("$", index + 1);
	}
	return -1;
}

function findClosingCodeSpan(source: string, start: number, length: number): number {
	const delimiter = "`".repeat(length);
	let index = source.indexOf(delimiter, start);
	while (index >= 0) {
		if (source[index - 1] !== "`" && source[index + length] !== "`") {
			return index;
		}
		index = source.indexOf(delimiter, index + length);
	}
	return -1;
}

function isSingleDollarMath(source: string, opening: number, closing: number): boolean {
	const content = source.slice(opening + 1, closing);
	const after = source.slice(closing + 1);
	return !(
		content.length === 0 ||
		content.includes("\n") ||
		/\s$/.test(content) ||
		/^\d/.test(after) ||
		(/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(content) && /^[A-Za-z_][A-Za-z0-9_]*/.test(after)) ||
		content.includes("`")
	);
}

function normalizeMathChunk(source: string): string {
	let result = "";
	let index = 0;

	while (index < source.length) {
		if (source[index] === "`" && !isEscaped(source, index)) {
			let length = 1;
			while (source[index + length] === "`") {
				length += 1;
			}
			const closing = findClosingCodeSpan(source, index + length, length);
			if (closing < 0) {
				result += source.slice(index);
				break;
			}
			const end = closing + length;
			result += source.slice(index, end);
			index = end;
			continue;
		}

		if ((source.startsWith("\\(", index) || source.startsWith("\\[", index)) && !isEscaped(source, index)) {
			const display = source[index + 1] === "[";
			const closingDelimiter = display ? "\\]" : "\\)";
			const closing = findClosingDelimiter(source, closingDelimiter, index + 2);
			if (closing >= 0) {
				const content = source.slice(index + 2, closing);
				if (content.length > 0 && (display || !content.includes("\n"))) {
					if (display) {
						const lineStart = source.lastIndexOf("\n", index - 1) + 1;
						const lineEndIndex = source.indexOf("\n", closing + 2);
						const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex;
						if (source.slice(lineStart, index).trim().length > 0) {
							result += "\n\n";
						}
						result += `$$\n${content.trim()}\n$$`;
						if (source.slice(closing + 2, lineEnd).trim().length > 0) {
							result += "\n\n";
						}
					} else {
						result += `$$${content}$$`;
					}
					index = closing + 2;
					continue;
				}
			}
			result += "\\".repeat(3) + source[index + 1];
			index += 2;
			continue;
		}

		if (source.startsWith("$$", index) && !isEscaped(source, index)) {
			const closing = findClosingDelimiter(source, "$$", index + 2);
			if (closing >= 0) {
				const content = source.slice(index + 2, closing);
				const lineStart = source.lastIndexOf("\n", index - 1) + 1;
				const lineEndIndex = source.indexOf("\n", closing + 2);
				const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex;
				const isolated =
					source.slice(lineStart, index).trim().length === 0 &&
					source.slice(closing + 2, lineEnd).trim().length === 0;
				result += isolated && content.trim().length > 0 ? `$$\n${content.trim()}\n$$` : source.slice(index, closing + 2);
				index = closing + 2;
				continue;
			}
			result += "$$";
			index += 2;
			continue;
		}

		if (source[index] === "$" && !isEscaped(source, index) && !/\s/.test(source[index + 1] ?? "")) {
			const closing = findClosingSingleDollar(source, index + 1);
			if (closing >= 0 && isSingleDollarMath(source, index, closing)) {
				result += `$$${source.slice(index + 1, closing)}$$`;
				index = closing + 1;
				continue;
			}
		}

		result += source[index];
		index += 1;
	}

	return result;
}

function normalizeMathDelimiters(source: string): string {
	const lines = source.match(/[^\n]*(?:\n|$)/g) ?? [];
	let result = "";
	let chunkStart = 0;
	let offset = 0;
	let fence: Fence | undefined;

	for (const line of lines) {
		let lineText = line.endsWith("\n") ? line.slice(0, -1) : line;
		if (lineText.endsWith("\r")) {
			lineText = lineText.slice(0, -1);
		}
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lineText)?.[1];
		if (!fence && marker) {
			result += normalizeMathChunk(source.slice(chunkStart, offset));
			fence = { character: marker[0] as "`" | "~", length: marker.length };
			chunkStart = offset;
		} else if (fence && marker?.[0] === fence.character && marker.length >= fence.length && /^ {0,3}(`+|~+)[ \t]*$/.test(lineText)) {
			const end = offset + line.length;
			result += source.slice(chunkStart, end);
			fence = undefined;
			chunkStart = end;
		}
		offset += line.length;
	}

	result += fence ? source.slice(chunkStart) : normalizeMathChunk(source.slice(chunkStart));
	return result;
}

export function MarkdownContent({ text }: { text: string }): React.JSX.Element {
	const markdown = useMemo(() => normalizeMathDelimiters(text), [text]);
	return (
		<div className="assistant-text">
			<ReactMarkdown components={MARKDOWN_COMPONENTS} remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
				{markdown}
			</ReactMarkdown>
		</div>
	);
}
