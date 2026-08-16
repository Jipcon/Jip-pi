export type IconName =
	| "check"
	| "chevron-right"
	| "close"
	| "code"
	| "copy"
	| "edit"
	| "folder"
	| "folder-plus"
	| "message"
	| "plus"
	| "send"
	| "settings"
	| "sparkles"
	| "stop"
	| "terminal"
	| "trash"
	| "tool"
	| "alert";

interface IconProps {
	name: IconName;
	size?: number;
	className?: string;
}

interface IconDefinition {
	content: React.JSX.Element;
	overflow?: "visible";
}

const BASE_STROKE_WIDTH = 1.2;

// 只调这个值即可修改 settings 齿轮大小。
// 1.0 = 原始大小
// 1.2 = 放大 20%
// 1.4 = 放大 40%
const SETTINGS_SCALE = 0.6;

const ICONS: Record<IconName, IconDefinition> = {
	check: {
		content: <path d="m5 12 4 4L19 6" />,
	},

	"chevron-right": {
		content: <path d="m9 18 6-6-6-6" />,
	},

	close: {
		content: (
			<>
				<path d="m6 6 12 12" />
				<path d="m18 6-12 12" />
			</>
		),
	},

	code: {
		content: (
			<>
				<path d="m9 7-5 5 5 5" />
				<path d="m13.5 5.5-3 13" />
				<path d="m15 7 5 5-5 5" />
			</>
		),
	},

	copy: {
		content: (
			<>
				<rect x="8" y="8" width="12" height="12" rx="2" />
				<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
			</>
		),
	},

	edit: {
		content: (
			<>
				<path d="M13.5 5.5 18.5 10.5" />
				<path d="m4 20 4.2-1 10.3-10.3a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z" />
			</>
		),
	},

	folder: {
		content: (
			<path d="M3.5 7.5v9a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2H12l-2-2H5.5a2 2 0 0 0-2 2Z" />
		),
	},

	"folder-plus": {
		content: (
			<>
				<path d="M3.5 7.5v9a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2H12l-2-2H5.5a2 2 0 0 0-2 2Z" />
				<path d="M12 10v5M9.5 12.5h5" />
			</>
		),
	},

	message: {
		content: (
			<path d="M5 18.5 3.5 21v-5.25A8.5 8.5 0 1 1 7.2 19H5Z" />
		),
	},

	plus: {
		content: (
			<>
				<path d="M12 5v14" />
				<path d="M5 12h14" />
			</>
		),
	},

	send: {
		content: (
			<>
				<path d="m4 4 17 8-17 8 3-8-3-8Z" />
				<path d="M7 12h14" />
			</>
		),
	},

	settings: {
		overflow: "visible",
		content: (
			<g
				transform={`translate(12 12) scale(${SETTINGS_SCALE}) translate(-12 -12)`}
				strokeWidth={BASE_STROKE_WIDTH / SETTINGS_SCALE}
			>
				<circle cx="12" cy="12" r="3" />

				<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1v.1h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1-.4h-.1v-4H3A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1v-.1h4V3A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.38.34.72.64.98.28.25.64.4 1 .42h.1v4h-.1a1.7 1.7 0 0 0-1.64.6Z" />
			</g>
		),
	},

	sparkles: {
		content: (
			<>
				<path d="m12 3 1.3 3.7L17 8l-3.7 1.3L12 13l-1.3-3.7L7 8l3.7-1.3L12 3Z" />
				<path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
				<path d="m5 13 .7 1.8 1.8.7-1.8.7L5 18l-.7-1.8-1.8-.7 1.8-.7L5 13Z" />
			</>
		),
	},

	alert: {
		content: (
			<path
				d="M12 2 1 21h22L12 2Zm0 6v6m0 3v.01"
				strokeWidth={2}
			/>
		),
	},

	stop: {
		content: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
	},

	terminal: {
		content: (
			<>
				<rect x="3.5" y="5" width="17" height="14" rx="2" />
				<path d="m7 9 3 3-3 3" />
				<path d="M13 15h4" />
			</>
		),
	},

	trash: {
		content: (
			<>
				<path d="M4 7h16" />
				<path d="M9 7V4h6v3" />
				<path d="m6 7 1 13h10l1-13" />
				<path d="M10 11v5M14 11v5" />
			</>
		),
	},

	tool: {
		content: (
			<path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.5 2.5-3-3 2.5-2.5Z" />
		),
	},
};

export function Icon({
	name,
	size = 16,
	className,
}: IconProps): React.JSX.Element {
	const icon: IconDefinition = ICONS[name];

	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={BASE_STROKE_WIDTH}
			strokeLinecap="round"
			strokeLinejoin="round"
			overflow={icon.overflow}
			aria-hidden="true"
			focusable="false"
		>
			{icon.content}
		</svg>
	);
}