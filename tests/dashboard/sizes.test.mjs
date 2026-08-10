import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { measureSkills, barGlyph, totalTokens, formatTokens } = await loadExt("dashboard/sizes.ts");

const dir = await mkdtemp(join(tmpdir(), "dash-sizes-"));
const write = async (name, bytes) => {
	const path = join(dir, `${name}.md`);
	await writeFile(path, "x".repeat(bytes));
	return { name, description: "", location: path };
};

const big = await write("big", 28000);
const small = await write("small", 2400);
const missing = { name: "missing", description: "", location: join(dir, "nope.md") };

const sized = await measureSkills([big, small, missing]);
ok("measures bytes as tokens", sized[0].tokens === 7000);
ok("measures the small one", sized[1].tokens === 600);
ok("missing file yields undefined", sized[2].tokens === undefined);
ok("preserves order", sized.map((s) => s.name).join(",") === "big,small,missing");
ok("total ignores unmeasurable", totalTokens(sized) === 7600);

// Bars scale relative to max, never absolutely.
ok("largest is full", barGlyph(7000, 7000) === "█");
ok("smallest is not empty", barGlyph(600, 7000) === "▁");
ok("midpoint is mid-scale", barGlyph(3500, 7000) === "▄");
ok("unmeasurable renders blank", barGlyph(undefined, 7000) === " ");
ok("zero max does not divide by zero", barGlyph(0, 0) === " ");
ok("all bars are one column wide", [...Array(9).keys()].every((i) => barGlyph(i * 875, 7000).length === 1));

ok("formats sub-thousand", formatTokens(600) === "600");
ok("formats thousands", formatTokens(78000) === "78k");
ok("formats with one decimal", formatTokens(7600) === "7.6k");

done();
