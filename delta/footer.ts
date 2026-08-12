/**
 * pi's bash truncation footer, split off and rendered separately.
 *
 * `bash.js` appends `[Showing lines … Full output: …]` to the output *text* and
 * strips it again at render time, recognising it from `details`. Delta must not
 * see it — it is prose, not diff — so this splits it the same way pi does, using
 * the same three conditions, and rebuilds the warning line from `details`.
 *
 * The warning wording follows pi's, minus its byte-limit variant: `formatSize`
 * and `DEFAULT_MAX_BYTES` are not exported, and inventing a size label that
 * disagrees with pi's would be worse than omitting it.
 */

export interface BashDetails {
	truncation?: {
		truncated?: boolean;
		truncatedBy?: string;
		outputLines?: number;
		totalLines?: number;
	};
	fullOutputPath?: string;
}

export function splitBashFooter(
	text: string,
	details: BashDetails | undefined,
): { body: string; footer: string } {
	const path = details?.fullOutputPath;
	if (details?.truncation?.truncated !== true || !path || !text.endsWith("]")) {
		return { body: text, footer: "" };
	}
	const start = text.lastIndexOf("\n\n[");
	if (start === -1 || !text.slice(start).includes(path)) {
		return { body: text, footer: "" };
	}
	return { body: text.slice(0, start).trimEnd(), footer: text.slice(start) };
}

/** The `[Full output: … Truncated: …]` line, as a list of parts. */
export function bashWarnings(details: BashDetails | undefined): string[] {
	const warnings: string[] = [];
	if (details?.fullOutputPath) warnings.push(`Full output: ${details.fullOutputPath}`);
	const truncation = details?.truncation;
	if (truncation?.truncated === true) {
		if (truncation.truncatedBy === "lines") {
			warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
		} else {
			warnings.push(`Truncated: ${truncation.outputLines} lines shown`);
		}
	}
	return warnings;
}
