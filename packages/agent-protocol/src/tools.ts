/**
 * Tool execution tracking model.
 *
 * The GUI renders every tool through a generic renderer. Specialized
 * renderers (bash, edit, read, ...) are optional improvements on top.
 */

export type ToolStatus = "running" | "completed" | "error";

export interface ToolCallInfo {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: ToolStatus;
	/** Accumulated partial output while the tool is running. */
	partialResult?: string;
	/** Final result text once completed. */
	result?: string;
	isError?: boolean;
	startedAt?: number;
	completedAt?: number;
}
