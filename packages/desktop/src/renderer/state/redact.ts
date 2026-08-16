/**
 * Defense in depth: credential-shaped fragments are stripped from error text
 * before it reaches the DOM, even if a backend forgot to redact.
 */
export function redactCredentialText(text: string): string {
	return text
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
		.replace(/(api[_-]?key|authorization|token|secret|password|credential)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}
