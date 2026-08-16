/**
 * Select: custom listbox replacement for native <select>.
 *
 * Native dropdown popups are OS-rendered on Windows and cannot be styled
 * (background, row height, animation), so the top bar selectors use this
 * component instead. Visual language matches the session context menu:
 * surface-overlay panel, strong border, large shadow, soft accent wash
 * on the selected option.
 *
 * Keyboard: ArrowDown/ArrowUp/Enter/Space open and navigate, Enter selects,
 * Escape closes and returns focus to the trigger, printable characters jump
 * to the first matching option (typeahead).
 */

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";

export interface SelectOption {
	value: string;
	label: string;
	/** Secondary line under the label (provider descriptions). */
	description?: string;
	/** Right-aligned meta content (context window size, thinking meter). */
	meta?: React.ReactNode;
	disabled?: boolean;
	/** Tooltip explaining why the option cannot be chosen. */
	disabledReason?: string;
}

const TYPEAHEAD_RESET_MS = 500;

export function Select({
	value,
	options,
	placeholder = "Unavailable",
	disabled = false,
	onChange,
	ariaLabel,
	testId,
	triggerClassName = "",
}: {
	value: string;
	options: SelectOption[];
	placeholder?: string;
	disabled?: boolean;
	onChange: (value: string) => void;
	ariaLabel: string;
	testId: string;
	triggerClassName?: string;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const typeaheadRef = useRef("");
	const typeaheadTimerRef = useRef<number | undefined>(undefined);
	const listId = useId();

	const selected = options.find((option) => option.value === value);

	const close = (): void => {
		setOpen(false);
		setActiveIndex(-1);
	};

	const toggle = (): void => {
		if (disabled) {
			return;
		}
		setActiveIndex(open ? -1 : Math.max(0, options.findIndex((option) => option.value === value)));
		setOpen(!open);
	};

	const choose = (option: SelectOption): void => {
		if (option.disabled) {
			return;
		}
		close();
		triggerRef.current?.focus();
		if (option.value !== value) {
			onChange(option.value);
		}
	};

	// Close on any pointer press outside the component.
	useEffect(() => {
		if (!open) {
			return;
		}
		const onPointerDown = (event: PointerEvent): void => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
				close();
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);

	// Keep the keyboard-active option visible while navigating.
	useEffect(() => {
		if (!open || activeIndex < 0) {
			return;
		}
		rootRef.current
			?.querySelector(`[data-select-index="${activeIndex}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [open, activeIndex]);

	useEffect(
		() => () => {
			if (typeaheadTimerRef.current !== undefined) {
				window.clearTimeout(typeaheadTimerRef.current);
			}
		},
		[],
	);

	const moveActive = (delta: number): void => {
		if (options.length === 0) {
			return;
		}
		setActiveIndex((current) => {
			let next = current < 0 ? (delta > 0 ? 0 : options.length - 1) : current;
			// Skip disabled options; wrap around the ends.
			for (let step = 0; step < options.length; step += 1) {
				next = (next + delta + options.length) % options.length;
				if (!options[next].disabled) {
					break;
				}
			}
			return next;
		});
	};

	const onKeyDown = (event: React.KeyboardEvent): void => {
		if (disabled) {
			return;
		}
		switch (event.key) {
			case "ArrowDown":
			case "ArrowUp": {
				event.preventDefault();
				if (!open) {
					setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
					setOpen(true);
					return;
				}
				moveActive(event.key === "ArrowDown" ? 1 : -1);
				return;
			}
			case "Enter":
			case " ": {
				event.preventDefault();
				if (!open) {
					toggle();
					return;
				}
				const option = options[activeIndex];
				if (option) {
					choose(option);
				}
				return;
			}
			case "Escape": {
				if (open) {
					event.preventDefault();
					close();
					triggerRef.current?.focus();
				}
				return;
			}
			case "Home":
			case "End": {
				if (!open) {
					return;
				}
				event.preventDefault();
				setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
				return;
			}
			default:
				break;
		}
		// Typeahead: accumulate printable characters and jump to the match.
		if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
			typeaheadRef.current += event.key.toLowerCase();
			if (typeaheadTimerRef.current !== undefined) {
				window.clearTimeout(typeaheadTimerRef.current);
			}
			typeaheadTimerRef.current = window.setTimeout(() => {
				typeaheadRef.current = "";
			}, TYPEAHEAD_RESET_MS);
			const needle = typeaheadRef.current;
			const matchIndex = options.findIndex(
				(option) => !option.disabled && option.label.toLowerCase().startsWith(needle),
			);
			if (matchIndex >= 0) {
				setActiveIndex(matchIndex);
			}
		}
	};

	return (
		<div className={`select${open ? " select-open" : ""}`} ref={rootRef}>
			<button
				type="button"
				ref={triggerRef}
				className={`select-trigger ${triggerClassName}`}
				disabled={disabled}
				onClick={toggle}
				onKeyDown={onKeyDown}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				aria-label={ariaLabel}
				data-testid={testId}
			>
				<span className="select-trigger-label">{selected?.label ?? placeholder}</span>
				<Icon name="chevron-right" size={14} className="select-chevron" />
			</button>
			{open && (
				<ul className="select-popup" id={listId} role="listbox" aria-label={ariaLabel}>
					{options.length === 0 && <li className="select-empty">{placeholder}</li>}
					{options.map((option, index) => {
						const isSelected = option.value === value;
						return (
							<li key={option.value} role="presentation">
								<button
									type="button"
									role="option"
									aria-selected={isSelected}
									className={`select-option${option.description ? " select-option-detailed" : ""}${
										isSelected ? " select-option-selected" : ""
									}${index === activeIndex ? " select-option-active" : ""}`}
									disabled={option.disabled}
									title={option.disabled ? option.disabledReason : undefined}
									data-select-index={index}
									data-testid={`${testId}-option-${option.value}`}
									onClick={() => choose(option)}
									onPointerEnter={() => setActiveIndex(index)}
								>
									<span className="select-option-copy">
										<span className="select-option-label">{option.label}</span>
										{option.description && (
											<span className="select-option-description">{option.description}</span>
										)}
									</span>
								{option.meta && <span className="select-option-meta">{option.meta}</span>}
							</button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
