// Build-time tool (Node only): reads the mod's doctrine tree definitions (grand doctrines,
// tracks, subdoctrines) across all three folders (land/air/naval) and resolves every display
// name, bakes the result to doctrines.json.
//
// TPMP's land doctrine tree is fully custom (8 tracks, all-new subdoctrines) — land names are
// resolved from TPMP's OWN localisation files ONLY, never the base game, so a land name is
// never silently wrong just because vanilla happens to define a same-sounding key elsewhere.
// Air and naval doctrine, by contrast, are reused UNMODIFIED from vanilla HOI4 (same ids, same
// content) — TPMP's own loc files genuinely don't define names for them at all, so for those
// two folders ONLY, a name missing from TPMP's files falls back to the base game's own
// localisation (the real in-game text, e.g. "Knights of the Air") before falling back further
// to a derived name from the loc KEY itself (e.g. SUBDOCTRINE_FOO_BAR -> "Foo Bar") if even
// vanilla doesn't have it.
//
// Re-run whenever the mod's doctrine files or localisation change:
//   node extract-doctrines.js "<mod folder>" "<base game folder>"
const fs = require("fs");
const path = require("path");
const { walkAndCapture } = require("./parser.js");

function buildLocMap(files) {
	const map = new Map();
	const lineRe = /^\s*([A-Za-z0-9_]+):\d*\s*"((?:[^"\\]|\\.)*)"/;
	for (const file of files) {
		if (!fs.existsSync(file)) continue;
		const text = fs.readFileSync(file, "utf8");
		for (const line of text.split("\n")) {
			const m = lineRe.exec(line);
			if (m) map.set(m[1], m[2]);
		}
	}
	return map;
}

// GRAND_DOCTRINE_STRATEGIC_DESTRUCTION -> "Strategic Destruction", DOCTRINE_TRACK_FIGHTER_AIRCRAFT
// -> "Fighter Aircraft" — used only when TPMP's own loc files have no entry for the key.
function nameFromKey(key) {
	return key
		.replace(/^(GRAND_DOCTRINE_|DOCTRINE_TRACK_|SUBDOCTRINE_)/, "")
		.toLowerCase()
		.split("_")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

// `vanillaLocMap` is only ever passed for air/naval entries — a land call always passes null,
// so land names can never resolve through the base game, only through TPMP's own files or the
// id-derived fallback.
function resolveName(tpmpLocMap, key, fallbackId, vanillaLocMap) {
	if (!key) return fallbackId;
	const resolveIn = (map, k) => {
		const v = map.get(k);
		if (v === undefined) return undefined;
		// A couple of subdoctrine names are themselves indirections to another loc key
		// (e.g. "$some_other_key$") — resolve one level of that, in the same map.
		const refMatch = /^\$(\w+)\$$/.exec(v);
		if (refMatch) return map.get(refMatch[1]) || nameFromKey(refMatch[1]);
		return v;
	};
	return resolveIn(tpmpLocMap, key) ?? (vanillaLocMap && resolveIn(vanillaLocMap, key)) ?? nameFromKey(key);
}

// Extracts every top-level `id = { ... }` block from a file as a Map id -> body, in file order.
function parseBlocks(file) {
	if (!fs.existsSync(file)) return new Map();
	return walkAndCapture(fs.readFileSync(file, "utf8"), () => true);
}

function main() {
	const modDir = process.argv[2];
	const gameDir = process.argv[3];
	if (!modDir) {
		console.error('Usage: node extract-doctrines.js "<mod folder>" "<base game folder>"');
		process.exit(1);
	}

	const locMap = buildLocMap([
		path.join(modDir, "localisation", "english", "TPMP_doctrine_l_english.yml"),
		path.join(modDir, "localisation", "replace", "english", "TPMP_overrides_l_english.yml"),
	]);
	// Only ever consulted for air/naval entries (see header comment) — stays empty, and thus a
	// no-op in resolveName, if no game folder was given.
	const vanillaLocMap = gameDir ? buildLocMap([path.join(gameDir, "localisation", "english", "doctrines_l_english.yml")]) : new Map();
	const vanillaFor = (folder) => (folder === "land" ? null : vanillaLocMap);

	const doctrinesDir = path.join(modDir, "common", "doctrines");

	// Grand doctrines: one id per grand doctrine, tagged with its folder (land/air/naval).
	const grandDoctrines = {};
	for (const file of fs.readdirSync(path.join(doctrinesDir, "grand_doctrines")).filter((f) => f.endsWith(".txt"))) {
		const blocks = parseBlocks(path.join(doctrinesDir, "grand_doctrines", file));
		for (const [id, bodies] of blocks) {
			const body = bodies[bodies.length - 1];
			const folderMatch = /(?:^|\n)\s*folder\s*=\s*(\w+)/.exec(body);
			const nameMatch = /(?:^|\n)\s*name\s*=\s*(\w+)/.exec(body);
			if (!folderMatch || !nameMatch) continue;
			const folder = folderMatch[1];
			grandDoctrines[id] = { folder, name: resolveName(locMap, nameMatch[1], id, vanillaFor(folder)) };
		}
	}

	// Tracks: the 4-or-8 slots per folder, in the order the game itself defines them (which
	// is also the order the mod's own screenshot of the land UI lays them out in).
	const tracks = {};
	const trackFiles = [
		{ file: "land_doctrine_tracks.txt", folder: "land" },
		{ file: "air_doctrine_track.txt", folder: "air" },
		{ file: "sea_doctrine_tracks.txt", folder: "naval" },
	];
	for (const { file, folder } of trackFiles) {
		const blocks = parseBlocks(path.join(doctrinesDir, "tracks", file));
		let order = 0;
		for (const [id, bodies] of blocks) {
			const body = bodies[bodies.length - 1];
			const nameMatch = /(?:^|\n)\s*name\s*=\s*(\w+)/.exec(body);
			tracks[id] = { folder, order: order++, name: resolveName(locMap, nameMatch ? nameMatch[1] : null, id, vanillaFor(folder)) };
		}
	}

	// Subdoctrines: every selectable option within a track, across all three folders. Walks
	// every .txt under subdoctrines/ recursively (land/air/sea/special_forces subfolders) —
	// the folder is derived from which top-level subfolder the file lives in.
	const subdoctrines = {};
	function walkSubdoctrineFiles(dir, folder) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				// special_forces is one of the 8 LAND tracks (see land_doctrine_tracks.txt), not
				// its own folder — its subdoctrines must stay TPMP-only like the rest of land.
				const nextFolder = entry.name === "land" || entry.name === "special_forces" ? "land" : entry.name === "air" ? "air" : entry.name === "sea" ? "naval" : folder;
				walkSubdoctrineFiles(full, nextFolder);
				continue;
			}
			if (!entry.name.endsWith(".txt")) continue;
			const blocks = parseBlocks(full);
			for (const [id, bodies] of blocks) {
				const body = bodies[bodies.length - 1];
				const trackMatch = /(?:^|\n)\s*track\s*=\s*(\w+)/.exec(body);
				const nameMatch = /(?:^|\n)\s*name\s*=\s*(\w+)/.exec(body);
				if (!trackMatch) continue;
				subdoctrines[id] = { track: trackMatch[1], name: resolveName(locMap, nameMatch ? nameMatch[1] : null, id, vanillaFor(folder)) };
			}
		}
	}
	walkSubdoctrineFiles(path.join(doctrinesDir, "subdoctrines"), null);

	const out = { grandDoctrines, tracks, subdoctrines };
	console.log(`Grand doctrines: ${Object.keys(grandDoctrines).length}, tracks: ${Object.keys(tracks).length}, subdoctrines: ${Object.keys(subdoctrines).length}`);
	fs.writeFileSync(path.join(__dirname, "doctrines.json"), JSON.stringify(out));
	console.log("Wrote doctrines.json");
}

main();
