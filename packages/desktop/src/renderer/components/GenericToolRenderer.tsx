/**
 * GenericToolRenderer: renders ANY tool invocation.
 *
 * Unknown tools must never break the UI; this renderer handles arbitrary
 * tool names, argument shapes and results. Specialized renderers (bash,
 * read, edit) are optional refinements layered on top.
 */

import type { ToolCallInfo } from "@earendil-works/pi-agent-protocol";
import { Icon } from "./Icon.tsx";

function statusLabel(status: ToolCallInfo["status"]): string {
	switch (status) {
		case "running":
			return "Running...";
		case "completed":
			return "Completed";
		case "error":
			return "Error";
	}
}

export function GenericToolRenderer({ tool }: { tool: ToolCallInfo }): React.JSX.Element {
	return (
		<div className="tool-card" data-testid="tool-card">
			<div className="tool-card-header">
				<span className="tool-card-identity">
					<span className="tool-card-icon">
						<Icon name={tool.name === "bash" ? "terminal" : "tool"} size={15} />
					</span>
					<span className="tool-card-name" data-testid="tool-name">
						{tool.name}
					</span>
				</span>
				<span className={`tool-card-status tool-card-status-${tool.status}`} data-testid="tool-status">
					<span className="tool-card-status-dot" aria-hidden="true" />
					{statusLabel(tool.status)}
				</span>
			</div>
			{tool.name === "bash" ? (
				<BashToolRenderer tool={tool} />
			) : (
				<>
					<div className="tool-card-args">
						<div className="tool-card-section-label">Arguments</div>
						<pre>{JSON.stringify(tool.args, null, 2)}</pre>
					</div>
					{tool.partialResult !== undefined && (
						<pre className="tool-card-output">{tool.partialResult}</pre>
					)}
					{tool.result !== undefined && <pre className="tool-card-output">{tool.result}</pre>}
					{tool.isError === true && <div className="tool-card-error">Tool failed</div>}
				</>
			)}
		</div>
	);
}

/** Specialized renderer for the bash tool: command line + live output. */
function BashToolRenderer({ tool }: { tool: ToolCallInfo }): React.JSX.Element {
	const command = typeof tool.args["command"] === "string" ? tool.args["command"] : "";
	return (
		<>
			{command && (
				<div className="tool-card-command" data-testid="tool-command">
					{command}
				</div>
			)}
			{tool.partialResult !== undefined && (
				<pre className="tool-card-output" data-testid="tool-partial">
					{tool.partialResult}
				</pre>
			)}
			{tool.result !== undefined && (
				<pre className="tool-card-output" data-testid="tool-result">
					{tool.result}
				</pre>
			)}
			{tool.isError === true && <div className="tool-card-error">Command failed</div>}
		</>
	);
}
