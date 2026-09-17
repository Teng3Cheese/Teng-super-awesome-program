// HOI4 save (.hoi4, plain-text Clausewitz/PDS format) extraction engine.
// Pure JS, no browser/Node-specific APIs — runs identically in a Worker or under Node for tests.
//
// Design: rather than building a full AST of a ~64MB file (most of which is division/
// character/equipment data we don't need), this walks the text once with cheap brace-depth
// tracking, and only materializes substrings for the specific keys we care about. Skipped
// values are never copied into memory.

const TARGET_TAGS = [
	// Majors
	"ENG", "FRA", "USA", "GER", "ITA", "JAP",
	// Others (hardcoded, fixed list — never derived from major=yes or otherwise dynamic)
	"CAN", "SAF", "RAJ", "AST", "UKR", "MAN", "HUN", "ROM", "BUL", "SPR",
];

const COUNTRY_FIELD_KEYS = new Set(["focus", "politics", "technology", "production", "decision_status", "characters", "focus_tree", "units"]);
const PRODUCTION_LINE_KEYS = new Set(["military_lines", "naval_lines", "ship_refit_lines", "general_lines"]);

function isWhitespace(ch) {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

// Advances past one PDS "value" starting at index i (a `{...}` block, a "quoted string",
// or a bare token), returning the index just past it. Does not allocate substrings.
function skipValue(text, i) {
	const n = text.length;
	while (i < n && isWhitespace(text.charCodeAt(i) ? text[i] : text[i])) i++;
	if (i >= n) return i;
	const ch = text[i];
	if (ch === "{") {
		let depth = 0;
		let inQuote = false;
		for (; i < n; i++) {
			const c = text[i];
			if (inQuote) {
				if (c === '"') inQuote = false;
				continue;
			}
			if (c === '"') {
				inQuote = true;
				continue;
			}
			if (c === "{") depth++;
			else if (c === "}") {
				depth--;
				if (depth === 0) {
					i++;
					break;
				}
			}
		}
		return i;
	}
	if (ch === '"') {
		i++;
		while (i < n && text[i] !== '"') i++;
		return i + 1;
	}
	while (i < n && !isWhitespace(text[i]) && text[i] !== "{" && text[i] !== "}") i++;
	return i;
}

// Walks a flat sequence of `key=value` / `key={...}` / `key="..."` pairs at the top level
// of `text`. For every key where shouldCapture(key) is true, records the value as a string
// (a `{...}` value's inner text, or a quoted/bare scalar with quotes stripped), pushed onto
// an array so repeated keys collect naturally. A bare anonymous `{...}` entry (no leading
// key — e.g. an array of objects) has its own opening/closing braces skipped one character
// at a time, which flattens its inner key=value pairs into this same top-level walk; that's
// intentional and relied on by appointed_advisors (array of {slot, character} objects) —
// see extractAppointedAdvisors, which zips the resulting parallel arrays back together.
// Everything not captured is skipped without allocation. Returns a Map<key, string[]>.
function walkAndCapture(text, shouldCapture) {
	const out = new Map();
	const n = text.length;
	let i = 0;
	while (i < n) {
		while (i < n && isWhitespace(text[i])) i++;
		if (i >= n) break;
		if (text[i] === "}" || text[i] === "{") {
			// Malformed/unexpected — skip one char defensively rather than looping forever.
			i++;
			continue;
		}
		const keyStart = i;
		while (i < n && text[i] !== "=" && !isWhitespace(text[i]) && text[i] !== "{" && text[i] !== "}") i++;
		const key = text.slice(keyStart, i);
		while (i < n && isWhitespace(text[i])) i++;
		if (text[i] !== "=") {
			// No '=' followed this token (e.g. a bare list entry) — nothing useful to key on, skip it.
			if (key.length === 0) i++;
			continue;
		}
		i++; // consume '='
		while (i < n && isWhitespace(text[i])) i++;
		if (key.length && shouldCapture(key)) {
			if (text[i] === "{") {
				const start = i + 1;
				const end = skipValue(text, i);
				const body = text.slice(start, Math.max(start, end - 1));
				if (!out.has(key)) out.set(key, []);
				out.get(key).push(body);
				i = end;
				continue;
			}
			if (text[i] === '"') {
				const start = i + 1;
				const end = skipValue(text, i);
				const val = text.slice(start, Math.max(start, end - 1));
				if (!out.has(key)) out.set(key, []);
				out.get(key).push(val);
				i = end;
				continue;
			}
			const start = i;
			const end = skipValue(text, i);
			if (!out.has(key)) out.set(key, []);
			out.get(key).push(text.slice(start, end));
			i = end;
			continue;
		}
		i = skipValue(text, i);
	}
	return out;
}

function firstMatch(re, text) {
	const m = re.exec(text);
	return m ? m[1] : undefined;
}

function allMatches(re, text) {
	const out = [];
	let m;
	re.lastIndex = 0;
	while ((m = re.exec(text)) !== null) out.push(m[1]);
	return out;
}

function parseFocus(body) {
	if (!body) return null;
	return {
		completed: allMatches(/completed="([^"]+)"/g, body),
		current: firstMatch(/current="([^"]+)"/, body) || null,
		progress: (() => {
			const v = firstMatch(/progress=([\d.]+)/, body);
			return v === undefined ? null : Number(v);
		})(),
		paused: firstMatch(/paused=(\w+)/, body) === "yes",
	};
}

function parsePolitics(body) {
	if (!body) return null;
	const ideasRaw = firstMatch(/ideas=\{([^}]*)\}/, body) || "";
	return {
		political_power: (() => {
			const v = firstMatch(/political_power=([\d.]+)/, body);
			return v === undefined ? null : Number(v);
		})(),
		ruling_party: firstMatch(/ruling_party=(\w+)/, body) || null,
		ideas: ideasRaw.split(/\s+/).map((s) => s.trim()).filter(Boolean),
	};
}

function parseTechnology(body) {
	if (!body) return null;
	// The real tech-id entries live one level deeper, under a "technologies" wrapper key
	// (technology={ override_icons_tag="..." technologies={ engines_1={...} ... } }).
	const outer = walkAndCapture(body, (k) => k === "technologies");
	const inner = outer.get("technologies");
	const techBody = inner && inner.length ? inner[0] : "";
	const entries = walkAndCapture(techBody, () => true);
	const done = [];
	const inProgress = [];
	for (const [id, bodies] of entries) {
		for (const entryBody of bodies) {
			const level = firstMatch(/level=(\d+)/, entryBody);
			const date = firstMatch(/date="([^"]+)"/, entryBody);
			if (level !== undefined) {
				done.push({ id, level: Number(level), date: date || null });
			} else {
				const points = firstMatch(/research_points=([\d.]+)/, entryBody);
				if (points !== undefined) inProgress.push({ id, points: Number(points) });
			}
		}
	}
	return { done, inProgress };
}

function parseProductionLine(body) {
	const num = (re) => {
		const v = firstMatch(re, body);
		return v === undefined ? null : Number(v);
	};
	return {
		priority: num(/priority=([\d.]+)/),
		active_factories: num(/active_factories=([\d.]+)/),
		requested_factories: num(/requested_factories=([\d.]+)/),
		produced: num(/produced=([\d.]+)/),
		cost: num(/cost=([\d.]+)/),
		equipment_id: (() => {
			const v = firstMatch(/equipment_variant_index=\{\s*id=(\d+)\s+type=(\d+)\s*\}/, body);
			return v === undefined ? null : Number(v);
		})(),
	};
}

// general_lines entries are NOT equipment production at all — they're the construction
// queue (factories, dockyards, infrastructure, forts, etc. being built), a totally
// different schema from military/naval/ship_refit lines: no equipment_variant_index, but a
// nested building={ template=... location=... } instead (template is the building type
// being built, e.g. "arms_factory", "industrial_complex", "infrastructure", "dockyard";
// location is the province id). Treating it like an equipment line was why it always showed
// up as "Unknown" equipment in an "Unknown" category — it was never an equipment id to begin
// with.
//
// Unlike military_lines/naval_lines/ship_refit_lines (which repeat the SAME key once per
// line — production={ military_lines={...} military_lines={...} ... }), general_lines is a
// single container that nests one "building={...}" entry per construction project inside
// it — production={ general_lines={ building={...} building={...} ... } }. Treating that
// single container as one line (the original bug here) meant every regex only ever matched
// the FIRST nested building, silently dropping every other in-progress construction project
// down to just one row.
function parseConstructionLine(body) {
	const num = (re) => {
		const v = firstMatch(re, body);
		return v === undefined ? null : Number(v);
	};
	return {
		priority: num(/priority=([\d.]+)/),
		active_factories: num(/active_factories=([\d.]+)/),
		amount: num(/amount=([\d.]+)/),
		produced: num(/produced=([\d.]+)/),
		cost: num(/cost=([\d.]+)/),
		template: firstMatch(/building=\{\s*template=(\S+)/, body) || null,
		location: (() => {
			const v = firstMatch(/building=\{\s*template=\S+\s*\n\s*location=(\d+)/, body);
			return v === undefined ? null : Number(v);
		})(),
	};
}

function parseGeneralLinesContainer(containerBody) {
	const entries = walkAndCapture(containerBody, (k) => k === "building");
	return (entries.get("building") || []).map(parseConstructionLine);
}

function parseProduction(body) {
	if (!body) return null;
	const entries = walkAndCapture(body, (k) => PRODUCTION_LINE_KEYS.has(k));
	const out = {};
	for (const key of PRODUCTION_LINE_KEYS) {
		if (key === "general_lines") {
			out[key] = (entries.get(key) || []).flatMap(parseGeneralLinesContainer);
		} else {
			out[key] = (entries.get(key) || []).map(parseProductionLine);
		}
	}
	return out;
}

// A country's own units={ division={...} division={...} ... } lists every division it
// currently has deployed, each referencing the division_template (see
// parseDivisionTemplates below, a GLOBAL top-level list, not nested per-country like this)
// it was built from via division_template_id={ id=N type=52 }. Tallying how many currently
// deployed divisions reference each template id is the only reliable way to tell an
// actively-used template from an effectively retired one — there's no explicit
// "decommissioned" flag on a template itself, it just sits there unused once nothing
// references it anymore.
function parseUnitCounts(body) {
	if (!body) return {};
	const entries = walkAndCapture(body, (k) => k === "division");
	const divisions = entries.get("division") || [];
	const counts = {};
	for (const divBody of divisions) {
		const m = /division_template_id=\{\s*id=(\d+)/.exec(divBody);
		if (!m) continue;
		counts[m[1]] = (counts[m[1]] || 0) + 1;
	}
	return counts;
}

function parseDecisionStatus(body) {
	if (!body) return null;
	const entries = walkAndCapture(body, () => true);
	const active = [];
	for (const [kind, bodies] of entries) {
		for (const entryBody of bodies) {
			const decision = firstMatch(/decision="([^"]+)"/, entryBody);
			if (decision) active.push({ kind, decision });
		}
	}
	return active;
}

function parseAppointedAdvisors(charactersBody) {
	if (!charactersBody) return [];
	// appointed_advisors lives under the country's "characters" block, not directly under
	// the country itself: characters={ appointed_advisors={ {slot=... character={..}} ... } }
	const outer = walkAndCapture(charactersBody, (k) => k === "appointed_advisors");
	const body = (outer.get("appointed_advisors") || [])[0];
	if (!body) return [];
	// appointed_advisors={ { slot="..." character={ id=N type=T } } { slot=... } ... } —
	// an array of anonymous objects, which walkAndCapture flattens into parallel arrays
	// (see its doc comment); zip them back together in order.
	const entries = walkAndCapture(body, (k) => k === "slot" || k === "character");
	const slots = entries.get("slot") || [];
	const chars = entries.get("character") || [];
	const out = [];
	for (let i = 0; i < slots.length; i++) {
		const m = /id=(\d+)/.exec(chars[i] || "");
		out.push({ slot: slots[i], characterId: m ? Number(m[1]) : null });
	}
	return out;
}

function extractCountryFields(body) {
	const captured = walkAndCapture(body, (k) => COUNTRY_FIELD_KEYS.has(k));
	const get = (k) => {
		const arr = captured.get(k);
		return arr && arr.length ? arr[0] : undefined;
	};
	return {
		focus: parseFocus(get("focus")),
		politics: parsePolitics(get("politics")),
		technology: parseTechnology(get("technology")),
		production: parseProduction(get("production")),
		decisions: parseDecisionStatus(get("decision_status")),
		advisors: parseAppointedAdvisors(get("characters")),
		focusTreeId: get("focus_tree") || null,
		unitCounts: parseUnitCounts(get("units")),
	};
}

// Builds a lookup of every named character who can hold an advisor slot, keyed by their
// numeric character id (as referenced from appointed_advisors). Character definitions are
// static for the life of a game, so callers should only do this once (e.g. for the first
// loaded save), not per save — it's the one part of the save worth treating as a shared
// reference table rather than re-parsing per file.
function extractAdvisorRoster(text) {
	const idx = text.indexOf("\ncharacter_manager={");
	if (idx === -1) return new Map();
	const braceIdx = text.indexOf("{", idx);
	const end = skipValue(text, braceIdx);
	const body = text.slice(braceIdx + 1, end - 1);

	const top = walkAndCapture(body, (k) => k === "historical" || k === "dynamic");
	const roster = new Map();
	for (const groupBody of [...(top.get("historical") || []), ...(top.get("dynamic") || [])]) {
		const chars = walkAndCapture(groupBody, (k) => k === "character");
		for (const charBody of chars.get("character") || []) {
			const idMatch = /(?:^|\n)\s*id=\{\s*id=(\d+)/.exec(charBody);
			if (!idMatch) continue;
			const charFields = walkAndCapture(charBody, (k) => k === "advisors");
			const advisorsBody = (charFields.get("advisors") || [])[0];
			if (!advisorsBody) continue; // not an advisor-capable character, skip — most aren't
			const advisorFields = walkAndCapture(advisorsBody, (k) => k === "advisor");
			const advisorBody = (advisorFields.get("advisor") || [])[0];
			if (!advisorBody) continue;
			const slot = firstMatch(/slot="([^"]+)"/, advisorBody);
			const ideaToken = firstMatch(/idea_token="([^"]+)"/, advisorBody);
			const cost = firstMatch(/political_power=([\d.]+)/, advisorBody);
			const name = firstMatch(/(?:^|\n)\s*name="([^"]+)"/, charBody);
			roster.set(Number(idMatch[1]), {
				name: name || ideaToken || "unknown",
				slot: slot || null,
				ideaToken: ideaToken || null,
				cost: cost === undefined ? null : Number(cost),
			});
		}
	}
	// Force real, independent string copies before returning. Every string value above came
	// from `.slice()`/regex-capture on `text` (possibly 60-90MB), and V8 represents those as
	// SlicedStrings that keep the ENTIRE parent buffer alive for as long as this tiny
	// extracted piece is referenced anywhere — see the longer comment on parseSave's return
	// below for the full story. Without this, a roster built once from one save still pins
	// that whole file's raw text in memory for the rest of the session.
	return new Map([...roster.entries()].map(([id, info]) => [id, JSON.parse(JSON.stringify(info))]));
}

// Builds a lookup of every equipment variant instance ever created in the game, keyed by
// the numeric id referenced from a production line's equipment_variant_index, to the
// archetype name it was built from (e.g. "light_tank_chassis_1936") — which category-extract
// tooling (see extract-equipment-categories.js) can resolve to a human category like "Tanks".
// Equipment ids only ever get added, never reused/removed, so — like the advisor roster —
// this only needs building once per batch, from whichever save has the most complete set
// (in practice, the latest one), not once per file.
function extractEquipmentRoster(text) {
	const idx = text.indexOf("\nequipments={");
	if (idx === -1) return new Map();
	const braceIdx = text.indexOf("{", idx);
	const end = skipValue(text, braceIdx);
	const body = text.slice(braceIdx + 1, end - 1);

	const entries = walkAndCapture(body, () => true);
	const roster = new Map();
	for (const [archetypeKey, bodies] of entries) {
		for (const entryBody of bodies) {
			const idMatch = /(?:^|\n)\s*id=\{\s*id=(\d+)/.exec(entryBody);
			if (idMatch) roster.set(Number(idMatch[1]), archetypeKey);
		}
	}
	return new Map([...roster.entries()].map(([id, key]) => [id, JSON.parse(JSON.stringify(key))]));
}

// player_countries={ ENG={ user="Some Name" country_leader=yes id=5 } ENG={ user="Other" ... } ... }
// — a tag can legitimately appear more than once (a co-op second player, or a replacement
// mid-campaign taking over from a previous one); this collects every distinct username seen
// against each tracked tag, in save order, and leaves ordering/aggregation ACROSS saves to
// the caller (a country's actual player(s) can also change from one save to the next).
function parsePlayerCountries(text, tags) {
	const idx = text.indexOf("\nplayer_countries={");
	if (idx === -1) return {};
	const braceIdx = text.indexOf("{", idx);
	const end = skipValue(text, braceIdx);
	const body = text.slice(braceIdx + 1, end - 1);

	const entries = walkAndCapture(body, (tag) => tags.has(tag));
	const out = {};
	for (const [tag, bodies] of entries) {
		const names = [];
		for (const entryBody of bodies) {
			const m = /user="([^"]*)"/.exec(entryBody);
			if (m && m[1] && !names.includes(m[1])) names.push(m[1]);
		}
		if (names.length) out[tag] = names;
	}
	return out;
}

// states={ 1={ buildings={ arms_factory={level=N ...} industrial_complex={level=M ...} ... }
//   owner="TAG" ... } 2={ ... } ... } — a country's actual current military/civilian
// factory count isn't stored as a single field anywhere; it only exists as the sum of
// arms_factory/industrial_complex building levels across every state it currently holds.
// Uses `controller` (who currently holds/runs the state) over `owner` (original legal
// owner) when they differ — an occupied enemy state's factories count toward whoever
// actually controls them, same as the in-game top-bar factory count works; `controller` is
// only present in the save at all when it differs from `owner`, so this falls back cleanly.
function parseStateFactories(text, tags) {
	const idx = text.indexOf("\nstates={");
	if (idx === -1) return {};
	const braceIdx = text.indexOf("{", idx);
	const end = skipValue(text, braceIdx);
	const body = text.slice(braceIdx + 1, end - 1);

	const entries = walkAndCapture(body, () => true);
	const totals = {};
	for (const bodies of entries.values()) {
		for (const stateBody of bodies) {
			const controllerMatch = /(?:^|\n)\s*controller="([A-Za-z]{2,4})"/.exec(stateBody);
			const ownerMatch = /(?:^|\n)\s*owner="([A-Za-z]{2,4})"/.exec(stateBody);
			const tag = ((controllerMatch || ownerMatch || [])[1] || "").toUpperCase();
			if (!tag || !tags.has(tag)) continue;
			const milMatch = /arms_factory=\{\s*level=(\d+)/.exec(stateBody);
			const civMatch = /industrial_complex=\{\s*level=(\d+)/.exec(stateBody);
			if (!totals[tag]) totals[tag] = { mil: 0, civ: 0 };
			if (milMatch) totals[tag].mil += Number(milMatch[1]);
			if (civMatch) totals[tag].civ += Number(civMatch[1]);
		}
	}
	return totals;
}

// Tallies unit-type occurrences within one named sub-block of a division_template body
// (e.g. its `regiments={ infantry={..} infantry={..} artillery_brigade={..} }`) into
// [{type, count}, ...] — each entry inside is one battalion/company slot, so counting
// occurrences of each key IS the composition.
function tallyUnitTypes(sectionBody) {
	if (!sectionBody) return [];
	const entries = walkAndCapture(sectionBody, () => true);
	return [...entries.entries()].map(([type, bodies]) => ({ type, count: bodies.length }));
}

// division_templates={ division_template={ id={id=N type=52} name="..." country="TAG"
// regiments={...} regimental_support={...} support={...} ... } ... } — a GLOBAL top-level
// list of every division template ever created by every country in the game (not nested
// per-country, unlike most other country data), matched to its owner via the template's own
// `country=` field. Paired with parseUnitCounts (which tallies how many CURRENT divisions
// reference each template id) by the caller to tell which templates are still in active use.
//
// A template's actual composition lives in three separate sub-blocks: `regiments` (the main
// combat battalions/brigades, arranged in the designer's grid), `regimental_support`
// (artillery attached directly to regiments — a different slot from the classic support
// company row), and `support` (support companies, normally at most one of each type). A
// template's NAME alone (often a player-chosen label like "2w" or "Slopper") says nothing
// about what's actually in it, so this pulls all three so the UI can show real composition.
function parseDivisionTemplates(text, tags) {
	const idx = text.indexOf("\ndivision_templates={");
	if (idx === -1) return {};
	const braceIdx = text.indexOf("{", idx);
	const end = skipValue(text, braceIdx);
	const body = text.slice(braceIdx + 1, end - 1);

	const entries = walkAndCapture(body, (k) => k === "division_template");
	const bodies = entries.get("division_template") || [];
	const out = {};
	for (const templateBody of bodies) {
		const tag = ((/(?:^|\n)\s*country="([A-Za-z]{2,4})"/.exec(templateBody) || [])[1] || "").toUpperCase();
		if (!tag || !tags.has(tag)) continue;
		const idMatch = /(?:^|\n)\s*id=\{\s*id=(\d+)/.exec(templateBody);
		if (!idMatch) continue;
		const name = (/(?:^|\n)\s*name="([^"]*)"/.exec(templateBody) || [])[1] || `Template #${idMatch[1]}`;

		const sections = walkAndCapture(templateBody, (k) => k === "regiments" || k === "regimental_support" || k === "support");
		const combat = tallyUnitTypes((sections.get("regiments") || [])[0]);
		const regimentalSupport = tallyUnitTypes((sections.get("regimental_support") || [])[0]);
		const support = tallyUnitTypes((sections.get("support") || [])[0]);

		if (!out[tag]) out[tag] = [];
		out[tag].push({ id: Number(idMatch[1]), name, combat, regimentalSupport, support });
	}
	return out;
}

function dateSortKey(dateStr) {
	if (!dateStr) return 0;
	const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(dateStr);
	if (!m) return 0;
	const [, y, mo, d, h] = m.map(Number);
	return y * 1e6 + mo * 1e4 + d * 1e2 + h;
}

// Main entry point. text: full contents of a .hoi4 save file (string).
function parseSave(text, targetTags) {
	const tags = new Set(targetTags || TARGET_TAGS);

	// Wide enough to survive a long player_countries list (large MP games) pushing
	// start_date/game_unique_id further down than the first ~1-2KB.
	const header = text.slice(0, 20000);
	const date = firstMatch(/^date="([^"]+)"/m, header) || null;
	const startDate = firstMatch(/^start_date="([^"]+)"/m, header) || null;
	const gameUniqueId = firstMatch(/^game_unique_id="([^"]+)"/m, header) || null;
	const version = firstMatch(/^version="([^"]+)"/m, header) || null;

	const playerCountries = parsePlayerCountries(text, tags);
	const stateFactories = parseStateFactories(text, tags);
	const divisionTemplates = parseDivisionTemplates(text, tags);

	const countriesIdx = text.indexOf("\ncountries={");
	const countries = {};
	if (countriesIdx !== -1) {
		const bodyStart = countriesIdx + "\ncountries={".length;
		const end = skipValue(text, countriesIdx + 1); // +1 to land on 'countries', skipValue handles the '=' lookup? no—
		// skipValue expects to start at the value itself; find the '{' explicitly instead.
		const braceIdx = text.indexOf("{", countriesIdx);
		const valueEnd = skipValue(text, braceIdx);
		const countriesBody = text.slice(bodyStart, Math.max(bodyStart, valueEnd - 1));

		const tagEntries = walkAndCapture(countriesBody, (tag) => tags.has(tag));
		for (const [tag, bodies] of tagEntries) {
			// A tag could legitimately appear more than once across the file's lifetime in
			// edge cases (e.g. re-tagged nations); keep the last body, matching save order.
			const body = bodies[bodies.length - 1];
			countries[tag] = extractCountryFields(body);
			countries[tag].factories = stateFactories[tag] || { mil: 0, civ: 0 };
			const templates = divisionTemplates[tag] || [];
			const unitCounts = countries[tag].unitCounts || {};
			countries[tag].armyTemplates = templates.map((tpl) => ({
				id: tpl.id,
				name: tpl.name,
				count: unitCounts[tpl.id] || 0,
				combat: tpl.combat,
				regimentalSupport: tpl.regimentalSupport,
				support: tpl.support,
			}));
			delete countries[tag].unitCounts;
		}
	}

	// Force a real, independent copy before returning. Every string field above (down
	// through every focus id, idea token, character name, etc.) came from `.slice()` or a
	// regex capture group against `text`, which for a large save is 60-90MB+. V8 represents
	// those as SlicedStrings — cheap to create, but they keep a strong reference to the
	// ENTIRE PARENT BUFFER alive for as long as even one tiny extracted piece is still
	// referenced anywhere. Concretely: without this, holding onto the small `result` object
	// from one parsed save was silently keeping that save's full ~80MB raw text pinned in
	// memory for the rest of the session — across a real ~90-file weekly batch (many 70MB+),
	// that's 6-7GB of dead weight, enough to crash a tab or a Node process outright (verified
	// via validate-batch.js: heap grew unboundedly with cumulative file size processed until
	// this fix was added, after which it stayed flat regardless of batch size). JSON
	// round-tripping a small object is effectively free, so there's no reason not to always
	// do this.
	return JSON.parse(JSON.stringify({
		date,
		dateSortKey: dateSortKey(date),
		startDate,
		gameUniqueId,
		version,
		countries,
		playerCountries,
	}));
}

const HOI4Parser = { parseSave, TARGET_TAGS, dateSortKey, walkAndCapture, skipValue, extractAdvisorRoster, extractEquipmentRoster };

if (typeof module !== "undefined" && module.exports) {
	module.exports = HOI4Parser;
}
if (typeof self !== "undefined") {
	self.HOI4Parser = HOI4Parser;
}
