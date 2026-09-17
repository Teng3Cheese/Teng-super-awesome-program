// Build-time tool (Node only, not shipped to the browser): reads every national focus
// definition file in the mod (plus base-game localisation for names the mod doesn't
// override) and bakes them into focus-trees.json — the static focus-tree layout data the
// app renders as a diagram.
//
// Trees are keyed by their in-game tree id (e.g. "british_focus"), not by country tag.
// That matters because a country's *actual* tree is a runtime choice recorded in the save
// itself (countries.<TAG>.focus_tree) — this mod defines alternate trees for the same
// country (e.g. Romania has both "romanian_focus" and "TPMP_teng_romanian_focus", and
// which one a given game actually uses depends on game rules). The app looks up a
// country's tree by that save-recorded id, not by a hardcoded tag->file mapping, so it
// can't silently show the wrong tree.
//
// Also strips out any focus under a branch the mod disabled via `allow_branch = { always
// = no }` (and anything that transitively depends on it) — those can't ever be taken, so
// showing them as regular grey "not yet done" nodes would be misleading.
//
// Manchukuo's TSR tree pulls in extra focuses from china_shared_TSR.txt via a bare
// `shared_focus = CHI_sea_invite_foreign_investors` reference — a special case handled
// narrowly below (mergeManchuriaSharedFocuses), not a general shared/joint-focus engine.
//
// MANUAL_DISABLED_FOCUSES below is a hand-maintained list of specific focus ids confirmed
// (by the user, who plays this mod) to be unpickable in practice, despite not being flagged
// `always = no` — their actual gating (has_dlc checks, game rules, etc.) doesn't reliably
// indicate this in the abstract, since the mod's convention assumes every player owns every
// DLC, so pattern-matching on that was a dead end (tried and reverted — see conversation).
// Add to this list by name as more turn up; don't try to reverse-engineer a general rule.
//
// Re-run whenever the mod's focus files change:
//   node extract-focus-trees.js "<mod folder>" "<base game folder>"
const fs = require("fs");
const path = require("path");
const { walkAndCapture, skipValue, TARGET_TAGS } = require("./parser.js");

const TARGET_TAG_SET = new Set(TARGET_TAGS);

// Confirmed unpickable in practice. Key = focus id, value = why (for the console log only).
const MANUAL_DISABLED_FOCUSES = {
	GER_oppose_hitler: "confirmed unpickable in this mod",
	FRA_leftist_rhetoric: "confirmed unpickable in this mod",
	FRA_right_wing_rhetoric: "confirmed unpickable in this mod",
	ITA_the_italian_social_republic: "gated to the RSI puppet tag, not ITA — Italy's tree is shared with RSI/RDS",
	ITA_the_italian_liberation_war: "allow_branch requires tag = RDS, not ITA — same RSI/RDS-shared tree as above",
	JAP_the_unthinkable_option: "confirmed unpickable in this mod",
	JAP_strengthen_civilian_government: "confirmed unpickable in this mod",
	JAP_support_the_kodoha_faction: "confirmed unpickable in this mod",
};

function stripComments(text) {
	// Paradox script comments run from an unquoted '#' to end of line.
	const lines = text.split("\n");
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li];
		let inQuote = false;
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (c === '"') inQuote = !inQuote;
			else if (c === "#" && !inQuote) {
				lines[li] = line.slice(0, i);
				break;
			}
		}
	}
	return lines.join("\n");
}

function loadLocalisation(dirs) {
	const map = new Map();
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		for (const file of fs.readdirSync(dir)) {
			if (!file.endsWith(".yml")) continue;
			const text = fs.readFileSync(path.join(dir, file), "utf8");
			const re = /^\s*([A-Za-z0-9_.\-]+):\d*\s*"(.*)"\s*$/gm;
			let m;
			while ((m = re.exec(text)) !== null) {
				map.set(m[1], m[2]);
			}
		}
	}
	return map;
}

// Finds every `<keyword> = { ... }` occurrence in `text` (word-boundaried, so searching for
// "focus" doesn't also match inside "shared_focus"). Returns {start, end, body} spans.
function findKeywordBlocks(text, keyword) {
	const results = [];
	const re = new RegExp(`(?:^|[^A-Za-z0-9_])${keyword}[ \\t]*=[ \\t]*\\{`, "g");
	let m;
	while ((m = re.exec(text)) !== null) {
		const braceIdx = text.indexOf("{", m.index);
		const end = skipValue(text, braceIdx);
		results.push({ start: m.index, end, body: text.slice(braceIdx + 1, end - 1) });
		re.lastIndex = end;
	}
	return results;
}

function parseFocusBody(id, body) {
	const x = Number((/(?:^|\n)\s*x\s*=\s*(-?\d+)/.exec(body) || [])[1] || 0);
	const y = Number((/(?:^|\n)\s*y\s*=\s*(-?\d+)/.exec(body) || [])[1] || 0);
	const relTo = (/relative_position_id\s*=\s*([A-Za-z0-9_]+)/.exec(body) || [])[1] || null;
	const cost = Number((/(?:^|\n)\s*cost\s*=\s*([\d.]+)/.exec(body) || [])[1] || 10);
	const icon = (/(?:^|\n)\s*icon\s*=\s*([A-Za-z0-9_]+)/.exec(body) || [])[1] || null;
	const fields = walkAndCapture(body, (k) => ["prerequisite", "mutually_exclusive", "allow_branch"].includes(k));
	const prereqGroups = (fields.get("prerequisite") || []).map((g) =>
		[...g.matchAll(/focus\s*=\s*([A-Za-z0-9_]+)/g)].map((m) => m[1])
	).filter((g) => g.length);
	const mutexBodies = fields.get("mutually_exclusive") || [];
	const mutex = mutexBodies.flatMap((g) => [...g.matchAll(/focus\s*=\s*([A-Za-z0-9_]+)/g)].map((m) => m[1]));
	// The mod disables an entire branch by setting allow_branch = { always = no } on its
	// root focus — other allow_branch conditions (has_dlc, etc.) are normal availability
	// gates, not removals, so only this exact case counts. (See MANUAL_DISABLED_FOCUSES
	// above for specific branches that are unpickable for other reasons.)
	const disabledDirectly = (fields.get("allow_branch") || []).some((b) => /(?:^|\n)\s*always\s*=\s*no/.test(b))
		|| id in MANUAL_DISABLED_FOCUSES;
	return { id, x, y, relTo, cost, icon, prereqGroups, mutex, disabledDirectly };
}

// A file can contain more than one `focus_tree = { ... }` block (rare, but seen in some
// shared-branch files), so this returns an array, not a single tree.
function extractFocusTrees(filePath) {
	const raw = stripComments(fs.readFileSync(filePath, "utf8"));
	const trees = [];
	for (const treeBlock of findKeywordBlocks(raw, "focus_tree")) {
		const treeBody = treeBlock.body;
		const top = walkAndCapture(treeBody, (k) => k === "focus" || k === "country");
		const treeId = (/(?:^|\n)\s*id\s*=\s*([A-Za-z0-9_]+)/.exec(treeBody) || [])[1] || null;
		const focusBodies = top.get("focus") || [];
		if (!treeId || !focusBodies.length) continue;

		// Which country tag(s) this tree is actually for — read from country.modifier.tag,
		// not guessed from the filename (a file can define a tree for a different/alternate
		// tag, as TENG_romania.txt does for ROM).
		const countryBody = (top.get("country") || [])[0] || "";
		const associatedTags = [...countryBody.matchAll(/tag\s*=\s*([A-Za-z]{2,4})\b/g)].map((m) => m[1].toUpperCase());

		const focuses = focusBodies.map((body) => {
			const id = (/(?:^|\n)\s*id\s*=\s*([A-Za-z0-9_]+)/.exec(body) || [])[1] || null;
			return id ? parseFocusBody(id, body) : null;
		}).filter(Boolean);

		trees.push({ treeId, focuses, associatedTags, sourceFile: path.basename(filePath) });
	}
	return trees;
}

function resolvePositions(focuses) {
	const byId = new Map(focuses.map((f) => [f.id, f]));
	const resolved = new Map();
	function resolve(f, guard) {
		if (resolved.has(f.id)) return resolved.get(f.id);
		if (guard.has(f.id)) return { x: f.x, y: f.y }; // cycle guard, shouldn't happen
		guard.add(f.id);
		if (!f.relTo || !byId.has(f.relTo)) {
			const pos = { x: f.x, y: f.y };
			resolved.set(f.id, pos);
			return pos;
		}
		const base = resolve(byId.get(f.relTo), guard);
		const pos = { x: base.x + f.x, y: base.y + f.y };
		resolved.set(f.id, pos);
		return pos;
	}
	for (const f of focuses) resolve(f, new Set());
	for (const f of focuses) {
		const pos = resolved.get(f.id);
		f.absX = pos.x;
		f.absY = pos.y;
	}
}

// Removes any focus directly disabled via allow_branch=always=no (or manually listed
// above), plus anything that can no longer be reached because every one of its
// prerequisite OR-groups has lost all its members — a fixed-point computation since
// removal cascades down the branch.
function removeDisabledBranches(focuses) {
	const byId = new Map(focuses.map((f) => [f.id, f]));
	const removed = new Set(focuses.filter((f) => f.disabledDirectly).map((f) => f.id));
	let changed = true;
	while (changed) {
		changed = false;
		for (const f of focuses) {
			if (removed.has(f.id)) continue;
			const blocked = f.prereqGroups.some((group) => group.length > 0 && group.every((reqId) => removed.has(reqId)));
			if (blocked) {
				removed.add(f.id);
				changed = true;
			}
		}
	}
	const survivors = focuses.filter((f) => !removed.has(f.id));
	// Drop dead ids from surviving focuses' prereq/mutex lists (their OR-groups still have
	// at least one live alternative, or they wouldn't have survived).
	for (const f of survivors) {
		f.prereqGroups = f.prereqGroups.map((g) => g.filter((id) => !removed.has(id))).filter((g) => g.length > 0);
		f.mutex = f.mutex.filter((id) => !removed.has(id));
	}
	return { survivors, removedCount: removed.size };
}

// Topological depth (0 = no prerequisites) — kept in the data for possible future use, not
// currently used for coloring (that's by completion order instead — see index.template.html).
function computeDepths(focuses) {
	const byId = new Map(focuses.map((f) => [f.id, f]));
	const depth = new Map();
	function get(f, guard) {
		if (depth.has(f.id)) return depth.get(f.id);
		if (guard.has(f.id)) return 0; // cycle guard
		guard.add(f.id);
		if (!f.prereqGroups.length) {
			depth.set(f.id, 0);
			return 0;
		}
		const d = 1 + Math.max(...f.prereqGroups.map((group) => Math.min(...group.map((id) => (byId.has(id) ? get(byId.get(id), guard) : 0)))));
		depth.set(f.id, d);
		return d;
	}
	for (const f of focuses) get(f, new Set());
	for (const f of focuses) f.depth = depth.get(f.id);
}

// Manchukuo's TSR tree (manchukuo_focus_tsr) references shared content defined once in
// china_shared_TSR.txt via a bare `shared_focus = CHI_sea_invite_foreign_investors` line —
// pulls in that focus plus everything chained off it (via prerequisite/relative_position_id)
// from that one file. Narrow and hardcoded on purpose (see file header).
function mergeManchuriaSharedFocuses(tree, treeId, focusDir) {
	const specs = {
		manchukuo_focus_tsr: { file: "china_shared_TSR.txt", seed: "CHI_sea_invite_foreign_investors" },
		manchukuo_focus: { file: "china_shared.txt", seed: "CHI_invite_foreign_investors" },
	};
	const spec = specs[treeId];
	if (!spec) return 0;
	const filePath = path.join(focusDir, spec.file);
	if (!fs.existsSync(filePath)) return 0;

	const raw = stripComments(fs.readFileSync(filePath, "utf8"));
	const shared = new Map();
	for (const block of findKeywordBlocks(raw, "shared_focus")) {
		const id = (/(?:^|\n)\s*id\s*=\s*([A-Za-z0-9_]+)/.exec(block.body) || [])[1];
		if (id) shared.set(id, parseFocusBody(id, block.body));
	}
	if (!shared.has(spec.seed)) return 0;

	// Connected component reachable from the seed via prerequisite/relative_position_id,
	// in either direction (a later shared focus can point back at an earlier one).
	const referencedBy = new Map();
	for (const [id, f] of shared) {
		for (const r of new Set([...f.prereqGroups.flat(), f.relTo].filter(Boolean))) {
			if (!referencedBy.has(r)) referencedBy.set(r, []);
			referencedBy.get(r).push(id);
		}
	}
	const visited = new Set();
	const queue = [spec.seed];
	while (queue.length) {
		const id = queue.pop();
		if (visited.has(id) || !shared.has(id)) continue;
		visited.add(id);
		const f = shared.get(id);
		for (const g of f.prereqGroups) for (const r of g) queue.push(r);
		if (f.relTo) queue.push(f.relTo);
		for (const dep of referencedBy.get(id) || []) queue.push(dep);
	}

	// The seed focus itself carries a MAN-specific `offset = { x y trigger = { tag = MAN }
	// } }` for where it should sit in Manchukuo's tree specifically (additive to its base
	// x/y) — everything else pulled in just chains off it normally via
	// relative_position_id, so only the seed needs this.
	const seedBlock = findKeywordBlocks(raw, "shared_focus").find((b) => new RegExp(`id\\s*=\\s*${spec.seed}\\b`).test(b.body));
	if (seedBlock) {
		const offsetMatch = findKeywordBlocks(raw.slice(seedBlock.start), "offset").find((o) => /tag\s*=\s*MAN\b/.test(o.body));
		if (offsetMatch) {
			const ox = Number((/(?:^|\n)\s*x\s*=\s*(-?\d+)/.exec(offsetMatch.body) || [])[1] || 0);
			const oy = Number((/(?:^|\n)\s*y\s*=\s*(-?\d+)/.exec(offsetMatch.body) || [])[1] || 0);
			const seed = shared.get(spec.seed);
			seed.x += ox;
			seed.y += oy;
		}
	}

	let pulledIn = 0;
	for (const id of visited) {
		if (tree.focuses.some((f) => f.id === id)) continue;
		tree.focuses.push(shared.get(id));
		pulledIn++;
	}
	return pulledIn;
}

function main() {
	const modDir = process.argv[2];
	const gameDir = process.argv[3];
	if (!modDir || !gameDir) {
		console.error("Usage: node extract-focus-trees.js <mod folder> <base game folder>");
		process.exit(1);
	}

	const loc = loadLocalisation([
		path.join(gameDir, "localisation", "english"),
		path.join(modDir, "localisation", "english"),
	]);
	console.log(`Loaded ${loc.size} localisation keys.`);

	const prettify = (id) =>
		id.replace(/_focus$/, "").replace(/^[A-Z]+_/, "").replace(/_/g, " ")
			.replace(/\b\w/g, (c) => c.toUpperCase());

	const focusDir = path.join(modDir, "common", "national_focus");
	const files = fs.readdirSync(focusDir).filter((f) => f.endsWith(".txt"));

	const manualHits = new Set();
	const out = {};
	for (const file of files) {
		let trees;
		try {
			trees = extractFocusTrees(path.join(focusDir, file));
		} catch (err) {
			console.warn(`Failed to parse ${file}: ${err.message}`);
			continue;
		}
		for (const tree of trees) {
			// Only bundle trees that could actually apply to one of our 16 tracked
			// countries (by their real country.modifier.tag, not the filename — a file can
			// define an alternate tree for a tag, as TENG_romania.txt does for ROM), plus
			// the tagless default tree as a fallback. Everything else (Chile, Congo, all
			// the other ~85 nations this mod covers) would just be dead weight.
			const isRelevant = tree.treeId === "generic_focus" || tree.associatedTags.some((t) => TARGET_TAG_SET.has(t));
			if (!isRelevant) continue;

			if (out[tree.treeId]) {
				console.warn(`Duplicate tree id ${tree.treeId} in ${file} (already defined in ${out[tree.treeId].sourceFile}) — keeping the first one.`);
				continue;
			}

			const pulledIn = mergeManchuriaSharedFocuses(tree, tree.treeId, focusDir);
			for (const f of tree.focuses) if (f.id in MANUAL_DISABLED_FOCUSES) manualHits.add(f.id);

			resolvePositions(tree.focuses);
			const { survivors, removedCount } = removeDisabledBranches(tree.focuses);
			computeDepths(survivors);

			for (const f of survivors) {
				const locName = loc.get(f.id);
				// Some loc entries use HOI4's dynamic-text macros (e.g. "[Root.GetName]")
				// which need the game's scripting engine to resolve — we can't evaluate
				// those, so fall back to a prettified id rather than showing raw syntax.
				f.name = locName && !locName.includes("[") && !locName.includes("$") ? locName : prettify(f.id);
				delete f.disabledDirectly;
			}

			out[tree.treeId] = { focuses: survivors, sourceFile: tree.sourceFile };
			console.log(`${tree.treeId} (${file}): ${survivors.length} focuses kept${pulledIn ? ` (${pulledIn} pulled from china_shared)` : ""}, ${removedCount} removed as disabled-branch`);
		}
	}

	for (const id of Object.keys(MANUAL_DISABLED_FOCUSES)) {
		if (!manualHits.has(id)) console.warn(`MANUAL_DISABLED_FOCUSES entry "${id}" was never found in any bundled tree — check the id is still correct.`);
	}

	fs.writeFileSync(path.join(__dirname, "focus-trees.json"), JSON.stringify(out));
	console.log(`Wrote focus-trees.json with ${Object.keys(out).length} trees.`);
}

main();
