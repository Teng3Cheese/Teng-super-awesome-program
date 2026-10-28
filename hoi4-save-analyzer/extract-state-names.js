// Build-time tool (Node only): resolves every state id to its real name. A construction
// line's `location` field (see parseConstructionLine in parser.js) is a STATE id, not a raw
// province id — confirmed directly against the mod's own history/states/<id>-<Name>.txt
// filenames (e.g. location=851 -> 851-Var.txt) and each file's own `id=N` field matching.
//
// Each state file's `name = "STATE_N"` field is just a loc key, not the real name — TPMP
// doesn't define its own state_names loc file at all, so vanilla states (confirmed directly:
// STATE_21 -> "Bouches-du-Rhône", STATE_851 -> "Var", both from the base game's own
// state_names_l_english.yml) resolve from there. For states TPMP adds beyond vanilla's own
// range (e.g. STATE_1000 "East Azerbaijan" — no vanilla state_names entry exists for it at
// all), the display name is instead derived from the state file's own filename, which already
// carries the real name right after the id (e.g. "1000-East Azerbaijan.txt" -> "East Azerbaijan").
//
// Re-run whenever the mod's state files or the base game's state names change:
//   node extract-state-names.js "<mod folder>" "<base game folder>"
const fs = require("fs");
const path = require("path");

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

function main() {
	const modDir = process.argv[2];
	const gameDir = process.argv[3];
	if (!modDir || !gameDir) {
		console.error('Usage: node extract-state-names.js "<mod folder>" "<base game folder>"');
		process.exit(1);
	}

	const locMap = buildLocMap(path.join(gameDir, "localisation", "english", "state_names_l_english.yml"));
	const statesDir = path.join(modDir, "history", "states");

	const out = {};
	let fromLoc = 0, fromFilename = 0;
	for (const file of fs.readdirSync(statesDir).filter((f) => f.endsWith(".txt"))) {
		// Usually "851-Var.txt", but confirmed directly: 116 files use "1014 - Bahrain.txt"
		// (a space before — and sometimes after — the hyphen) instead.
		const idMatch = /^(\d+)\s*-\s*/.exec(file);
		if (!idMatch) continue;
		const id = idMatch[1];
		const locName = locMap.get(`STATE_${id}`);
		if (locName) {
			out[id] = locName;
			fromLoc++;
		} else {
			// "1000-East Azerbaijan.txt" -> "East Azerbaijan"
			out[id] = file.slice(idMatch[0].length).replace(/\.txt$/, "").trim();
			fromFilename++;
		}
	}

	console.log(`States: ${Object.keys(out).length} (${fromLoc} from vanilla state_names, ${fromFilename} derived from filename)`);
	fs.writeFileSync(path.join(__dirname, "state-names.json"), JSON.stringify(out));
	console.log("Wrote state-names.json");
}

main();
