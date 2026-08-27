/**
 * Which bash commands produce a diff worth handing to delta.
 *
 * Matching the command, not the output: output that merely looks like a diff — a
 * `.patch` fixture, `rg 'diff --git'` — must not be recoloured, and the command
 * is the only signal available before the output exists. The cost is that
 * unusual tools need `extraCommands` in config.
 *
 * The matcher is not a shell parser. `segments` splits on newlines as well as
 * `;`, `|`, `&&` and `||`, so a `git diff` line inside a heredoc *is* treated as
 * a command and matches. Recolouring that output is the failure mode we accept:
 * a false positive costs a subprocess and some colour, a false negative costs
 * the feature.
 */

/** Flags that turn a diff command into a summary, which delta cannot render. */
const SUMMARY =
	/^--(stat|numstat|name-only|name-status|shortstat|compact-summary)(=|$)/;

/** Flags that suppress `git show`'s diff, leaving only the commit message. */
const NO_PATCH = /^(-s|--no-patch)$/;

/**
 * A `git show` argument that names something other than a commit.
 *
 * `git show rev:path` and `git show :path` print the *contents* of a blob or a
 * listing of a tree, not a diff, and `rev^{tree}` / `rev^{blob}` peel to the
 * same. Recolouring a source file as though it were a diff is the expensive
 * half of this matcher's two failure modes, and `git show` is the one
 * subcommand where a plain-looking invocation produces no diff at all.
 *
 * A colon is a reliable signal because git forbids it in ref names
 * (`git check-ref-format`), so `rev:path` is the only thing it can mean here.
 * `^{}` and `^{commit}` are left alone: both still resolve to a commit.
 */
const NOT_A_COMMIT = /:|\^\{(tree|blob)\}/;

/** Flags that make `git log` and `git stash show` emit a patch. */
const PATCH = /^(-[pu]|--patch|--unified(=|$)|-U\d*)$/;

/** git's own options precede the subcommand, and some of them take a value. */
const GIT_OPTIONS_WITH_VALUE = new Set([
	"-c",
	"-C",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--exec-path",
]);

/** Split a shell line into the commands it runs, ignoring how they are joined. */
export function segments(command: string): string[] {
	return command.split(/\|\||&&|[;|\n]/);
}

function tokens(segment: string): string[] {
	return segment.trim().split(/\s+/).filter(Boolean);
}

function subcommand(rest: string[]): {
	name: string | undefined;
	args: string[];
} {
	let i = 0;
	while (i < rest.length) {
		const token = rest[i];
		if (GIT_OPTIONS_WITH_VALUE.has(token)) {
			i += 2;
			continue;
		}
		if (token.startsWith("-")) {
			i += 1;
			continue;
		}
		return { name: token, args: rest.slice(i + 1) };
	}
	return { name: undefined, args: [] };
}

function isBuiltinDiff(parts: string[]): boolean {
	const [first, ...rest] = parts;
	if (first === "git") {
		const { name, args } = subcommand(rest);
		if (name === "show") {
			if (args.some((arg) => NO_PATCH.test(arg))) return false;
			return !args.some((arg) => !arg.startsWith("-") && NOT_A_COMMIT.test(arg));
		}
		if (name === "diff" || name === "range-diff") return true;
		if (name === "log") return args.some((arg) => PATCH.test(arg));
		if (name === "stash")
			return args[0] === "show" && args.slice(1).some((arg) => PATCH.test(arg));
		return false;
	}
	// Plain `diff` only emits a unified diff when asked to.
	if (first === "diff") return rest.some((arg) => PATCH.test(arg));
	return false;
}

export function isDiffCommand(
	command: string,
	extra: readonly RegExp[] = [],
): boolean {
	return segments(command).some((segment) => {
		const parts = tokens(segment);
		if (parts.length === 0) return false;
		if (parts.some((part) => SUMMARY.test(part))) return false;
		if (isBuiltinDiff(parts)) return true;
		return extra.some((pattern) => pattern.test(segment.trim()));
	});
}

/**
 * Compile config patterns, warning about — and dropping — the invalid ones.
 *
 * SAFETY: `sources` is the user's own `extraCommands` config, not untrusted
 * input, and each compiled regex is matched only against a single shell command
 * segment (short, local, user-typed) — not long or attacker-controlled text.
 * So a pathological pattern can only slow this user's own tool on their own
 * command; there is no cross-tenant ReDoS surface. Malformed regexes are
 * already dropped below rather than thrown. Deliberately built from a string so
 * users can express matchers their environment doesn't supply a hardcoded rule
 * for.
 */
export function compilePatterns(
	sources: readonly string[],
	warnings: string[],
): RegExp[] {
	const compiled: RegExp[] = [];
	for (const source of sources) {
		try {
			compiled.push(new RegExp(source));
		} catch (error) {
			warnings.push(
				`extraCommands: ${source} is not a valid regex (${(error as Error).message})`,
			);
		}
	}
	return compiled;
}
