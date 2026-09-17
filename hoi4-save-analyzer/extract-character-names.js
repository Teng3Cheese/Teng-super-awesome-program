// Build-time tool (Node only): bundles just the character-name localisation (files with
// "character" in the name, mod + base game) into character-names.json, so advisor names
// pulled from a save's character_manager (raw tokens like "GER_hanns_kerrl") can be shown
// as "Hanns Kerrl" instead. Deliberately scoped to these files rather than all ~15MB of
// game localisation — advisor names are covered by them (spot-checked against a real
// roster), and it keeps the bundled data small.
//
// Re-run whenever the mod's character files change:
//   node extract-character-names.js "<mod folder>" "<base game folder>"
const fs = require("fs");
const path = require("path");

function loadCharacterLoc(dirs) {
	const map = {};
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		for (const file of fs.readdirSync(dir)) {
			if (!file.endsWith(".yml") || !/character/i.test(file)) continue;
			const text = fs.readFileSync(path.join(dir, file), "utf8");
			const re = /^\s*([A-Za-z0-9_.\-]+):\d*\s*"(.*)"\s*$/gm;
			let m;
			while ((m = re.exec(text)) !== null) {
				// Some loc entries use HOI4's dynamic-text syntax ("$VAR$", "[Root.GetName]")
				// which needs the game's scripting engine to resolve — skip those so the
				// runtime falls back to a prettified token instead of showing raw syntax.
				if (m[2].includes("$") || m[2].includes("[")) continue;
				map[m[1]] = m[2];
			}
		}
	}
	return map;
}

function main() {
	const modDir = process.argv[2];
	const gameDir = process.argv[3];
	if (!modDir || !gameDir) {
		console.error("Usage: node extract-character-names.js <mod folder> <base game folder>");
		process.exit(1);
	}
	const map = loadCharacterLoc([
		path.join(gameDir, "localisation", "english"),
		path.join(modDir, "localisation", "english"),
	]);
	console.log(`Loaded ${Object.keys(map).length} character name keys.`);
	fs.writeFileSync(path.join(__dirname, "character-names.json"), JSON.stringify(map));
	console.log("Wrote character-names.json");
}

main();
