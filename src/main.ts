import { MarkdownView, Plugin } from "obsidian";

type CleanupFn = () => void;

export default class SidenoteCollisionAvoider extends Plugin {
	private rafId: number | null = null;
	private cleanups: CleanupFn[] = [];
	private isMutating = false;

	onload() {
		// Relayout on view/layout changes
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.rebindAndSchedule(),
			),
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () =>
				this.rebindAndSchedule(),
			),
		);

		// Resize
		this.registerDomEvent(window, "resize", () => this.schedule());

		// Initial
		this.rebindAndSchedule();
	}

	onunload() {
		this.cancel();
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];
	}

	private cancel() {
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	private schedule() {
		this.cancel();
		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			this.layout();
		});
	}

	private rebindAndSchedule() {
		this.rebindObservers();
		this.schedule();
	}

	private rebindObservers() {
		// Clear old observers/listeners
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const cmRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (!cmRoot) return;

		const scroller = cmRoot.querySelector<HTMLElement>(".cm-scroller");
		if (scroller) {
			const onScroll = () => this.schedule();
			scroller.addEventListener("scroll", onScroll, { passive: true });
			this.cleanups.push(() =>
				scroller.removeEventListener("scroll", onScroll),
			);
		}

		const content = cmRoot.querySelector<HTMLElement>(".cm-content");
		if (content) {
			const mo = new MutationObserver(() => {
				if (this.isMutating) return;
				// CM6 can re-render; allow link conversion to run again
				cmRoot
					.querySelectorAll<HTMLElement>(
						"small.sidenote[data-md-links-rendered='1']",
					)
					.forEach((el) => delete el.dataset.mdLinksRendered);

				this.schedule();
			});

			mo.observe(content, {
				childList: true,
				subtree: true,
				characterData: true,
			});

			this.cleanups.push(() => mo.disconnect());
		}
	}

	private layout() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const cmRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (!cmRoot) return;

		const sidenotes = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("small.sidenote"),
		);
		if (sidenotes.length === 0) return;

		// 1) Render Markdown links inside sidenotes (Live Preview)
		this.renderMarkdownLinksInSidenotes(cmRoot);

		// 2) Numbering by visual order
		const ordered = sidenotes
			.map((el) => ({ el, rect: el.getBoundingClientRect() }))
			.sort((a, b) => a.rect.top - b.rect.top);

		let n = 1;
		for (const { el } of ordered) {
			const marker = el.closest<HTMLElement>(".sidenote-number");
			const num = String(n++);
			el.dataset.sidenoteNum = num;
			if (marker) marker.dataset.sidenoteNum = num;
		}

		// 3) Collision avoidance
		let columnBottom = -Infinity;
		const spacing = 8;

		for (const { el, rect } of ordered) {
			const desiredTop = rect.top;
			const minTop =
				columnBottom === -Infinity
					? desiredTop
					: columnBottom + spacing;

			const actualTop = Math.max(desiredTop, minTop);
			const shift = actualTop - desiredTop;

			el.style.setProperty(
				"--sidenote-shift",
				shift > 0.5 ? `${shift}px` : "0px",
			);

			columnBottom = actualTop + rect.height;
		}
	}

	/**
	 * Convert [label](url) to <a> inside <small.sidenote> in Live Preview.
	 * - Walk text nodes only (won’t re-wrap existing <a>)
	 * - Guard against mutation loops
	 * - Only allow safe protocols
	 */
	private renderMarkdownLinksInSidenotes(cmRoot: HTMLElement) {
		const sidenotes = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("small.sidenote"),
		);

		this.isMutating = true;
		try {
			for (const sn of sidenotes) {
				if (sn.dataset.mdLinksRendered === "1") continue;

				const walker = document.createTreeWalker(
					sn,
					NodeFilter.SHOW_TEXT,
				);
				const textNodes: Text[] = [];
				while (walker.nextNode())
					textNodes.push(walker.currentNode as Text);

				let changed = false;

				for (const node of textNodes) {
					const text = node.nodeValue ?? "";
					if (
						!text.includes("[") ||
						!text.includes("](") ||
						!text.includes(")")
					)
						continue;

					const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;

					// quick check
					re.lastIndex = 0;
					if (!re.test(text)) continue;
					re.lastIndex = 0;

					const frag = document.createDocumentFragment();
					let lastIndex = 0;
					let m: RegExpExecArray | null;

					while ((m = re.exec(text)) !== null) {
						const [full, label, urlRaw] = m;
						const start = m.index;

						if (start > lastIndex) {
							frag.appendChild(
								document.createTextNode(
									text.slice(lastIndex, start),
								),
							);
						}

						const url = urlRaw.trim();
						const isSafe =
							url.startsWith("http://") ||
							url.startsWith("https://") ||
							url.startsWith("mailto:");

						if (isSafe) {
							const a = document.createElement("a");
							a.textContent = label;
							a.href = url;
							a.rel = "noopener noreferrer";
							a.target = "_blank";
							frag.appendChild(a);
						} else {
							// leave as literal text if protocol is not allowed
							frag.appendChild(document.createTextNode(full));
						}

						lastIndex = start + full.length;
					}

					if (lastIndex < text.length) {
						frag.appendChild(
							document.createTextNode(text.slice(lastIndex)),
						);
					}

					node.parentNode?.replaceChild(frag, node);
					changed = true;
				}

				if (changed) sn.dataset.mdLinksRendered = "1";
			}
		} finally {
			this.isMutating = false;
		}
	}
}
