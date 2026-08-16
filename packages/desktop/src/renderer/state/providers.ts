/**
 * Provider display metadata for the renderer.
 *
 * The backend reports provider ids; the GUI maps them to human-readable
 * labels that make the subscription/balance distinction explicit so OpenCode
 * Go models can never be mistaken for OpenCode Zen models.
 */

export interface ProviderDisplay {
	id: string;
	/** Short label shown in the provider selector. */
	label: string;
	/** Longer description, shown as the option title. */
	description?: string;
}

const PROVIDER_DISPLAYS: Record<string, ProviderDisplay> = {
	"opencode-go": {
		id: "opencode-go",
		label: "OpenCode Go · subscription",
		description: "Go subscription models billed to your Go plan",
	},
	opencode: {
		id: "opencode",
		label: "OpenCode Zen · balance",
		description: "Pay-per-use Zen models billed to your account balance",
	},
};

export function providerDisplay(providerId: string): ProviderDisplay {
	return PROVIDER_DISPLAYS[providerId] ?? { id: providerId, label: providerId };
}
