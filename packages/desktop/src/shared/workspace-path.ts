export function workspacePathKey(path: string): string {
	const slashPath = path.replace(/\\/g, "/");
	let normalized = slashPath.startsWith("//")
		? `//${slashPath.slice(2).replace(/\/+/g, "/")}`
		: slashPath.replace(/\/+/g, "/");
	if (normalized !== "/" && !/^[A-Za-z]:\/$/.test(normalized)) {
		normalized = normalized.replace(/\/+$/, "");
	}
	return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLocaleLowerCase() : normalized;
}

export function workspacePathsEqual(left: string, right: string): boolean {
	return workspacePathKey(left) === workspacePathKey(right);
}
