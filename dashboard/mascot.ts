/**
 * The pi mascot, drawn with block glyphs.
 *
 * Not an inline image: `pi-tui`'s `detectCapabilities()` picks an image
 * protocol from environment variables alone, and terminals outside its
 * allowlist (Tabby among them) degrade a real image to a text placeholder.
 * Block glyphs render everywhere.
 */

export interface MascotTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const BLOCK = "█";
const PUPIL = "▌";

export function mascotLines(theme: MascotTheme, version: string): string[] {
	const blue = (text: string) => theme.fg("accent", text);
	const eye = `${BLOCK}${theme.fg("dim", PUPIL)}`;
	const leg = `     ${blue(BLOCK.repeat(2))}    ${blue(BLOCK.repeat(2))}`;
	return [
		`     ${eye}  ${eye}`,
		`  ${blue(BLOCK.repeat(14))}`,
		leg,
		leg,
		leg,
		`  ${theme.bold(theme.fg("accent", "pi"))}${theme.fg("dim", ` v${version}`)}`,
	];
}
