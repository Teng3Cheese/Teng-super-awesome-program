// Build-time tool (Node only): reads every MIO (Military Industrial Organization) definition
// file — generic org types plus every per-country one — and resolves each organization's FULL
// upgrade tree (every node it can unlock, with its real position and prerequisites), through
// TPMP's OWN localisation only (never the base game). Bakes the result to mio-traits.json.
//
// Three things make this harder than a flat per-file scan:
//  1. `include = <other org id>` — a country-specific org (e.g. GER_focke_wulf_organization)
//     inherits an entire base tree wholesale from a shared "archetype" org defined elsewhere
//     (e.g. generic_range_focused_aircraft_organization), then layers its own extra nodes on
//     top via `add_trait` and can nudge an inherited node's position via `override_trait`
//     (looked up by token). This has to be resolved recursively per org, not scanned flat —
//     the including org's own file never contains its inherited nodes' text at all.
//  2. The SAME trait token can legitimately be defined, independently, inside MULTIPLE org
//     blocks — confirmed directly: generic_mio_trait_MIO_standard_1a is copy-pasted near-
//     identically into the standard/advanced/production infantry orgs AND the artillery org
//     (4+ separate definitions of one token). A single flat `token -> node` map would let the
//     last file processed silently steal that node's ownership from every other org that also
//     defines it — which is exactly why it went missing from the infantry/artillery trees
//     before this fix. Every org's tree is therefore resolved and stored independently; nothing
//     is deduplicated across orgs.
//  3. A few country-specific nodes (so far only seen in GER's file) position themselves with a
//     `@name` scripted constant (e.g. `position = { x=@aircraft_hamburger_X y=... }`) instead
//     of a literal number — these are simple per-file `@name = value` assignments at the top of
//     that file, substituted in textually before any other parsing.
//
// TPMP_MIO_l_english.yml only localizes a minority of trait tokens — most upgrade nodes have no
// loc entry at all and would show their raw token in-game. Where that's the case, the display
// name is instead derived straight from the token itself (e.g.
// generic_mio_trait_long_range_cruising -> "Long Range Cruising").
//
// Re-run whenever the mod's MIO organization files or localisation change:
//   node extract-mio-traits.js "<mod folder>"
const fs = require("fs");
const path = require("path");
const { walkAndCapture } = require("./parser.js");

function buildLocMap(file) {
	const map = new Map();
	if (!fs.existsSync(file)) return map;
	const lineRe = /^\s*([A-Za-z0-9_]+):\d*\s*"((?:[^"\\]|\\.)*)"/;
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const m = lineRe.exec(line);
		if (m) map.set(m[1], m[2]);
	}
	return map;
}

// generic_mio_trait_standard_infantry_1a -> "Standard Infantry 1a", GER_mio_trait_krupp_contacts
// -> "Krupp Contacts" — strips the generic_/<TAG>_ prefix and the mio_trait_ marker, then title-
// cases what's left. Used only when the token has no localisation entry of its own.
function nameFromToken(token) {
	const stripped = token.replace(/^(?:generic_|[A-Z]{2,5}_)?mio_trait_/, "");
	return stripped
		.split("_")
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

function resolveName(locMap, key, fallbackToken) {
	if (key && locMap.has(key)) return locMap.get(key);
	return nameFromToken(fallbackToken);
}

// Substitutes `@name` scripted-constant references with their value, using only the `@name =
// number` assignments found at the top of THIS file (HOI4's per-file scripted variable scope —
// confirmed these never appear defined anywhere outside the one file that uses them).
function resolveLocalDefines(text) {
	const defines = new Map();
	for (const m of text.matchAll(/^\s*@(\w+)\s*=\s*(-?\d+)\s*$/gm)) defines.set(m[1], m[2]);
	if (!defines.size) return text;
	return text.replace(/@(\w+)/g, (full, name) => (defines.has(name) ? defines.get(name) : full));
}

function parseTraitBlock(body) {
	const tokenMatch = /(?:^|\n)\s*token\s*=\s*(\S+)/.exec(body);
	const nameMatch = /(?:^|\n)\s*name\s*=\s*(\S+)/.exec(body);
	const token = tokenMatch ? tokenMatch[1] : nameMatch ? nameMatch[1] : null;
	if (!token) return null;
	const posMatch = /position\s*=\s*\{\s*x\s*=\s*(-?\d+)\s*y\s*=\s*(-?\d+)/.exec(body);
	// any_parent (OR) and all_parents (AND) both become plain edges here — this is a display
	// tree, not a prerequisite evaluator, so the AND/OR distinction doesn't change what's drawn.
	const anyParentMatch = /any_parent\s*=\s*\{([^}]*)\}/.exec(body);
	const allParentsMatch = /all_parents\s*=\s*\{([^}]*)\}/.exec(body);
	const relPosMatch = /(?:^|\n)\s*relative_position_id\s*=\s*(\S+)/.exec(body);
	const parents = new Set([
		...(anyParentMatch ? anyParentMatch[1].trim().split(/\s+/).filter(Boolean) : []),
		...(allParentsMatch ? allParentsMatch[1].trim().split(/\s+/).filter(Boolean) : []),
	]);
	// A node with no explicit prereq list but a relative_position_id still visually hangs off
	// that other node in-game — use it as a best-effort edge so it doesn't float disconnected.
	if (!parents.size && relPosMatch) parents.add(relPosMatch[1]);
	return {
		token,
		nameKey: nameMatch ? nameMatch[1] : token,
		x: posMatch ? Number(posMatch[1]) : null,
		y: posMatch ? Number(posMatch[2]) : null,
		parents: [...parents],
		relativePositionId: relPosMatch ? relPosMatch[1] : null,
	};
}

// A handful of country-specific add_trait nodes (so far only seen on GER's aircraft org add-
// ons) give `position = { x=0 y=N }` as a bare placeholder and rely entirely on
// `relative_position_id` for where they actually sit next to another node in-game — confirmed
// directly: 5+ distinct nodes in GER_focke_wulf_organization alone all share the literal
// placeholder x=0, which would otherwise stack every one of them on top of each other in this
// tool's grid layout. Since the real in-game offset algorithm isn't something this tool can see,
// this derives a reasonable stand-in: one row below the referenced node, nudged sideways per
// sibling that references the same node, so nothing silently overlaps.
function fixRelativePositions(nodes, traitEntries) {
	const pending = new Map();
	for (const te of traitEntries) {
		if (te.relativePositionId && te.x === 0) pending.set(te.token, te.relativePositionId);
	}
	if (!pending.size) return;
	// Every node NOT in `pending` already has a real (non-derived) position — seed the occupied
	// set with those so a derived node can't coincidentally land on top of one of them either.
	const occupied = new Set();
	for (const [token, node] of nodes) {
		if (!pending.has(token)) occupied.add(`${node.x},${node.y}`);
	}
	for (let pass = 0; pass < 5 && pending.size; pass++) {
		for (const [token, targetToken] of [...pending]) {
			if (pending.has(targetToken)) continue; // target itself still pending — resolve it first
			const node = nodes.get(token);
			const target = nodes.get(targetToken);
			pending.delete(token);
			if (!node || !target) continue;
			let x = target.x, y = target.y + 1;
			while (occupied.has(`${x},${y}`)) x++;
			occupied.add(`${x},${y}`);
			node.x = x;
			node.y = y;
		}
	}
}

function main() {
	const modDir = process.argv[2];
	if (!modDir) {
		console.error('Usage: node extract-mio-traits.js "<mod folder>"');
		process.exit(1);
	}

	const locMap = buildLocMap(path.join(modDir, "localisation", "english", "TPMP_MIO_l_english.yml"));
	const orgsDir = path.join(modDir, "common", "military_industrial_organization", "organizations");

	const orgNames = {};
	// Raw per-org data, scoped to exactly what that org's own file text defines — nothing here
	// is shared or merged across orgs yet (see point 2 in the header comment above).
	const rawOrgs = new Map();

	for (const file of fs.readdirSync(orgsDir).filter((f) => f.endsWith(".txt"))) {
		const text = resolveLocalDefines(fs.readFileSync(path.join(orgsDir, file), "utf8"));
		const topLevel = walkAndCapture(text, () => true);
		for (const [orgId, orgBodies] of topLevel) {
			const orgBody = orgBodies[orgBodies.length - 1];

			const orgTopLevel = walkAndCapture(orgBody, (k) => k === "name" || k === "include");
			const orgNameBodies = orgTopLevel.get("name") || [];
			const orgNameKey = orgNameBodies[orgNameBodies.length - 1];
			const includeBodies = orgTopLevel.get("include") || [];
			const includeId = includeBodies[includeBodies.length - 1] || null;
			// Most generic orgs have no explicit `name = X` field — the organization id itself
			// IS the loc key in that case (e.g. TPMP_generic_standard_infantry_organization).
			orgNames[orgId] = resolveName(locMap, orgNameKey || orgId, orgId);

			const sections = walkAndCapture(orgBody, (k) => k === "trait" || k === "add_trait" || k === "override_trait");
			const traitEntries = [...(sections.get("trait") || []), ...(sections.get("add_trait") || [])].map(parseTraitBlock).filter(Boolean);
			const overrideEntries = (sections.get("override_trait") || []).map(parseTraitBlock).filter(Boolean);

			rawOrgs.set(orgId, { includeId, traitEntries, overrideEntries });
		}
	}

	const resolvedCache = new Map();
	function resolveTree(orgId, chain) {
		if (resolvedCache.has(orgId)) return resolvedCache.get(orgId);
		if (chain.has(orgId)) return []; // defensive cycle guard — not expected to ever trigger
		const raw = rawOrgs.get(orgId);
		if (!raw) return [];
		chain.add(orgId);

		const nodes = new Map();
		if (raw.includeId) {
			for (const n of resolveTree(raw.includeId, chain)) nodes.set(n.id, { ...n });
		}
		for (const te of raw.traitEntries) {
			nodes.set(te.token, {
				id: te.token,
				name: resolveName(locMap, te.nameKey, te.token),
				x: te.x ?? 0,
				y: te.y ?? 0,
				parents: te.parents,
			});
		}
		for (const ov of raw.overrideEntries) {
			const existing = nodes.get(ov.token);
			if (!existing) continue;
			if (ov.x !== null) existing.x = ov.x;
			if (ov.y !== null) existing.y = ov.y;
		}
		fixRelativePositions(nodes, raw.traitEntries);

		chain.delete(orgId);
		const result = [...nodes.values()];
		resolvedCache.set(orgId, result);
		return result;
	}

	const orgTrees = {};
	for (const orgId of rawOrgs.keys()) {
		orgTrees[orgId] = resolveTree(orgId, new Set());
	}

	const totalNodes = Object.values(orgTrees).reduce((sum, nodes) => sum + nodes.length, 0);
	console.log(`Orgs: ${Object.keys(orgNames).length}, total resolved tree nodes (not deduplicated across orgs): ${totalNodes}`);
	fs.writeFileSync(path.join(__dirname, "mio-traits.json"), JSON.stringify({ orgs: orgNames, orgTrees }));
	console.log("Wrote mio-traits.json");
}

main();
